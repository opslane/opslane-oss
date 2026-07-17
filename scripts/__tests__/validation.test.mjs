import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedLineCount, parseMarkdownFences, runRunnableSnippets, validateContentEdit, validateSiteOverlay } from '../docs-sync/validation.mjs';

const DOC = 'docs/guides/react.md';
const FRONTMATTER = '---\ncovers:\n  - packages/sdk/**\n---\n';

function manifest(fences) {
  return { version: 1, documents: { [DOC]: { fences } } };
}

test('frontmatter and schema-wrapper corruption are rejected', () => {
  assert.throws(() => validateContentEdit({
    docPath: DOC,
    original: `${FRONTMATTER}# React\n`,
    edited: '# React\n',
    snippetManifest: manifest([]),
  }), /frontmatter changed/);
  assert.throws(() => validateContentEdit({
    docPath: 'docs/architecture/trust.md', original: '# Trust\n', edited: '# Trust\n<content>junk</content>\n',
  }), /wrapper tags/);
});

test('fences must be closed; language-less fences are allowed', () => {
  // CommonMark permits an info-string-less fence: parse it as an untagged block.
  assert.deepEqual(parseMarkdownFences('```\nplain output\n```\n').map(({ language, content }) => ({ language, content })), [
    { language: '', content: 'plain output' },
  ]);
  assert.throws(() => parseMarkdownFences('```ts\nconst x = 1;\n'), /unclosed/);
  assert.deepEqual(parseMarkdownFences('~~~ts title=x\nconst x = 1;\n~~~~\n').map(({ language, content }) => ({ language, content })), [
    { language: 'ts', content: 'const x = 1;' },
  ]);
});

test('Mermaid blocks get a deterministic structural check', () => {
  assert.doesNotThrow(() => validateContentEdit({
    docPath: 'docs/architecture/overview.md', original: '# Overview\n', edited: '# Overview\n```mermaid\nflowchart LR\n A --> B\n```\n',
  }));
  assert.throws(() => validateContentEdit({
    docPath: 'docs/architecture/overview.md', original: '# Overview\n', edited: '# Overview\n```mermaid\nA --> B\n```\n',
  }), /diagram declaration/);
  assert.throws(() => validateContentEdit({
    docPath: 'docs/architecture/overview.md', original: '# Overview\n', edited: '# Overview\n```mermaid\nflowchart LR\n A[broken --> B\n```\n',
  }), /unbalanced delimiters/);
  // Parens/brackets inside a quoted node label are valid Mermaid and must not
  // trip the structural balance heuristic.
  assert.doesNotThrow(() => validateContentEdit({
    docPath: 'docs/architecture/overview.md', original: '# Overview\n', edited: '# Overview\n```mermaid\nflowchart LR\n A["ingest :)"] --> B["store [hot]"]\n```\n',
  }));
});

test('setup fences require ordered classifications and safe runnable argv metadata', () => {
  const original = `${FRONTMATTER}# React\n`;
  const edited = `${original}\n\`\`\`tsx\nmount();\n\`\`\`\n`;
  assert.throws(() => validateContentEdit({ docPath: DOC, original, edited }), /manifest/);
  assert.throws(() => validateContentEdit({
    docPath: DOC, original, edited, snippetManifest: manifest([{ language: 'ts', classification: 'fragment' }]),
  }), /language mismatch/);
  assert.throws(() => validateContentEdit({
    docPath: DOC,
    original,
    edited,
    snippetManifest: manifest([{ language: 'tsx', classification: 'runnable', fixture: 'test-fixtures/react-app', target: 'src/example.tsx', command: 'pnpm build' }]),
  }), /argv array/);
  assert.doesNotThrow(() => validateContentEdit({
    docPath: DOC,
    original,
    edited,
    snippetManifest: manifest([{ language: 'tsx', classification: 'runnable', fixture: 'test-fixtures/react-app', target: 'src/example.tsx', command: ['pnpm', 'build'] }]),
  }));
});

test('diff size is advisory and counts additions plus removals', () => {
  assert.equal(changedLineCount('a\nb\n', 'a\nc\nd\n'), 3);
  const result = validateContentEdit({
    docPath: 'docs/architecture/trust.md', original: '# Trust\nold\n', edited: '# Trust\nnew\nextra\n', advisoryChangedLines: 1,
  });
  assert.equal(result.warnings[0].code, 'large-docs-diff');
  assert.equal(result.changedLines, 3);
});

test('runnable snippets are materialized in an isolated fixture and invoked as argv', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'docs-sync-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/guides'), { recursive: true });
  mkdirSync(join(root, 'test-fixtures/example/src'), { recursive: true });
  writeFileSync(join(root, DOC), '```ts\nexport const answer = 42;\n```\n');
  const snippetManifest = manifest([{
    language: 'ts', classification: 'runnable', fixture: 'test-fixtures/example', target: 'src/example.ts', command: ['verify', '--strict'],
  }]);
  const calls = [];
  runRunnableSnippets({
    checkoutRoot: root,
    docPaths: [DOC],
    snippetManifest,
    runner(command, args, options) {
      calls.push([command, args]);
      assert.equal(readFileSync(join(options.cwd, 'src/example.ts'), 'utf8'), 'export const answer = 42;\n');
      assert.notEqual(options.cwd, join(root, 'test-fixtures/example'));
      return '';
    },
  });
  assert.deepEqual(calls, [['verify', ['--strict']]]);
  assert.equal(existsSync(join(root, 'test-fixtures/example/src/example.ts')), false);
});

test('Stage-2 site validation uses trusted site code with PR docs as data', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'docs-sync-site-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkoutRoot = join(root, 'pr');
  const trustedRoot = join(root, 'trusted');
  mkdirSync(join(checkoutRoot, 'docs'), { recursive: true });
  mkdirSync(join(checkoutRoot, 'docs-site'), { recursive: true });
  mkdirSync(join(trustedRoot, 'docs-site/node_modules'), { recursive: true });
  mkdirSync(join(trustedRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(checkoutRoot, 'docs/page.md'), '# PR edit\n');
  writeFileSync(join(checkoutRoot, 'docs-site/astro.config.mjs'), 'throw new Error("untrusted")\n');
  writeFileSync(join(trustedRoot, 'docs-site/astro.config.mjs'), 'export default {}\n');
  const calls = [];
  validateSiteOverlay({
    checkoutRoot,
    trustedRoot,
    runner(command, args, options) {
      calls.push([command, args]);
      assert.equal(readFileSync(join(options.cwd, 'docs/page.md'), 'utf8'), '# PR edit\n');
      assert.equal(readFileSync(join(options.cwd, 'docs-site/astro.config.mjs'), 'utf8'), 'export default {}\n');
      return '';
    },
  });
  assert.equal(calls[0][0], 'pnpm');
  assert.equal(calls[0][1].at(-1), 'build');
});
