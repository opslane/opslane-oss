import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkedRunner,
  parseMarkdownFences,
  runRunnableSnippets,
} from '../validation.mjs';

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function sameDocument(left, right) {
  const normalize = (content) => content.endsWith('\n')
    ? `${content.replace(/\n+$/, '')}\n`
    : content;
  return normalize(left) === normalize(right);
}

export async function validateEvalOutput(
  fixture,
  output,
  { repoRoot = DEFAULT_ROOT, runner = checkedRunner } = {},
) {
  const result = {};
  let fences;
  try {
    fences = parseMarkdownFences(output.content);
  } catch (error) {
    fences = [];
    result.fenceError = error.message;
  }

  if (fixture.expected.commandFences) {
    const commands = fences
      .filter(({ language }) => language === 'bash')
      .map(({ content }) => content);
    result.commandValidityPass =
      JSON.stringify(commands) === JSON.stringify(fixture.expected.commandFences);
    if (result.commandValidityPass) {
      try {
        for (const command of commands) runner('bash', ['-n'], { input: command });
      } catch (error) {
        result.commandValidityPass = false;
        result.commandError = error.message;
      }
    }
  }

  if (fixture.expected.runnableManifest) {
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'docs-sync-eval-'));
    try {
      const destination = join(checkoutRoot, fixture.docPath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, output.content);
      runRunnableSnippets({
        checkoutRoot,
        fixtureRepoRoot: repoRoot,
        docPaths: [fixture.docPath],
        snippetManifest: fixture.expected.runnableManifest,
        runner,
      });
      result.runnableSnippetPass = true;
    } catch (error) {
      result.runnableSnippetPass = false;
      result.runnableError = error.message;
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  }

  if (fixture.expected.expectMermaid) {
    const diagrams = fences
      .filter(({ language }) => language === 'mermaid')
      .map(({ content }) => content);
    result.mermaidParsePass = diagrams.length > 0;
    if (result.mermaidParsePass) {
      const parser = [
        "import { createRequire } from 'node:module';",
        "import { dirname, resolve } from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
        "const mermaidUrl = import.meta.resolve('mermaid');",
        "const requireFromMermaid = createRequire(mermaidUrl);",
        "const dompurifyCjs = requireFromMermaid.resolve('dompurify');",
        "const dompurifyUrl = pathToFileURL(resolve(dirname(dompurifyCjs), 'purify.es.mjs')).href;",
        "const DOMPurify = (await import(dompurifyUrl)).default;",
        // Mermaid's Node entrypoint receives DOMPurify's factory because no
        // browser window exists. Syntax parsing only needs a string sanitizer,
        // so install a non-rendering identity shim before Mermaid is imported.
        "DOMPurify.addHook = () => {};",
        "DOMPurify.sanitize = (value) => value;",
        "const mermaid = (await import(mermaidUrl)).default;",
        "let text = '';",
        "process.stdin.setEncoding('utf8');",
        "for await (const chunk of process.stdin) text += chunk;",
        "for (const diagram of JSON.parse(text)) await mermaid.parse(diagram);",
      ].join('\n');
      try {
        runner(
          'pnpm',
          ['--dir', join(repoRoot, 'docs-site'), 'exec', 'node', '--input-type=module', '-e', parser],
          { input: JSON.stringify(diagrams) },
        );
      } catch (error) {
        result.mermaidParsePass = false;
        result.mermaidError = error.message;
      }
    }
  }

  if (fixture.expected.diagramGoldenExact) {
    result.diagramMatchesProse = Boolean(result.mermaidParsePass) &&
      sameDocument(output.content, fixture.expected.exactContent);
  }

  if (fixture.expected.normativeLines) {
    const outputLines = new Set(output.content.split(/\r?\n/));
    result.normativeWordingPreserved = fixture.expected.normativeLines.every((line) =>
      outputLines.has(line));
  }

  return result;
}
