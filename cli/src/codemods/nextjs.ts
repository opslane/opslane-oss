import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Codemod, FilePatch } from './types.js';
import {
  bodyOpeningTag,
  hasCall,
  lastImportStatement,
  readSource,
  sdkImportLocalName,
} from './source.js';

async function findLayoutFile(projectRoot: string): Promise<string> {
  const candidates = [
    'app/layout.tsx',
    'app/layout.jsx',
    'src/app/layout.tsx',
    'src/app/layout.jsx',
    'pages/_app.tsx',
    'pages/_app.jsx',
    'src/pages/_app.tsx',
    'src/pages/_app.jsx',
  ];
  for (const candidate of candidates) {
    try {
      await access(join(projectRoot, candidate));
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  // Default to app router layout
  return 'app/layout.tsx';
}

function nextClientContent(): string {
  return [
    "'use client';",
    '',
    "import { init } from '@opslane/sdk';",
    '',
    'let initialized = false;',
    '',
    'export function OpslaneClient() {',
    '  const apiKey = process.env.NEXT_PUBLIC_OPSLANE_API_KEY;',
    '  if (!initialized && apiKey && typeof window !== \'undefined\') {',
    '    init({ apiKey });',
    '    initialized = true;',
    '  }',
    '',
    '  return null;',
    '}',
    '',
  ].join('\n');
}

function insertAfter(source: string, anchor: string, content: string): string {
  const position = source.indexOf(anchor) + anchor.length;
  return `${source.slice(0, position)}\n${content}${source.slice(position)}`;
}

/** Repair the dedicated client component one missing aspect at a time. */
function repairNextClient(source: string): string {
  let repaired = source;
  if (!/^\s*['"]use client['"]\s*;?/m.test(repaired)) {
    repaired = `'use client';\n\n${repaired}`;
  }

  let initLocalName = sdkImportLocalName(repaired, 'init');
  if (!initLocalName) {
    const importAnchor = lastImportStatement(repaired) || "'use client';";
    repaired = insertAfter(repaired, importAnchor, "import { init } from '@opslane/sdk';");
    initLocalName = 'init';
  }

  const functionMatch = /(?:export\s+)?function\s+OpslaneClient\s*\([^)]*\)\s*\{/.exec(repaired);
  if (!functionMatch) return nextClientContent();

  const escapedInit = initLocalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const initCall = new RegExp(`\\b${escapedInit}\\s*\\(`).test(repaired);
  const envKey = repaired.includes('process.env.NEXT_PUBLIC_OPSLANE_API_KEY');
  const guarded = /if\s*\(\s*!([A-Za-z_$][\w$]*)\s*&&\s*apiKey\s*&&\s*typeof window\s*!==\s*['"]undefined['"]\s*\)/.exec(repaired);
  const guardName = guarded?.[1];
  const hasGuardDeclaration = guardName
    ? new RegExp(`\\blet\\s+${guardName}\\s*=\\s*false\\s*;?`).test(repaired)
    : false;
  const hasGuardAssignment = guardName
    ? new RegExp(`\\b${guardName}\\s*=\\s*true\\s*;?`).test(repaired)
    : false;

  if (initCall && envKey && guarded && hasGuardDeclaration && hasGuardAssignment) {
    return repaired;
  }

  // A one-line partial initialization can be safely replaced without touching
  // the rest of a customized component. More complex stale client files are
  // reset to the small canonical component so literal keys cannot survive.
  const callLine = new RegExp(
    `^[ \\t]*${escapedInit}\\s*\\(\\s*\\{[^\\n]*\\}\\s*\\)\\s*;?[ \\t]*$`,
    'm',
  );
  const setupLines = [
    '  const apiKey = process.env.NEXT_PUBLIC_OPSLANE_API_KEY;',
    "  if (!initialized && apiKey && typeof window !== 'undefined') {",
    `    ${initLocalName}({ apiKey });`,
    '    initialized = true;',
    '  }',
  ].join('\n');

  if (!/\blet\s+initialized\s*=\s*false\s*;?/.test(repaired)) {
    const importAnchor = lastImportStatement(repaired) || "'use client';";
    repaired = insertAfter(repaired, importAnchor, '\nlet initialized = false;');
  }

  if (callLine.test(repaired)) {
    return repaired.replace(callLine, setupLines);
  }
  if (!initCall && !envKey) {
    const opening = functionMatch[0];
    return insertAfter(repaired, opening, setupLines);
  }
  return nextClientContent();
}

export const nextjsCodemod: Codemod = {
  framework: 'nextjs',
  description: 'Add Opslane SDK to a Next.js application',

  async generate(projectRoot: string): Promise<FilePatch[]> {
    const layoutFile = await findLayoutFile(projectRoot);
    const patches: FilePatch[] = [];

    if (layoutFile.includes('/app/') || layoutFile.startsWith('app/')) {
      const clientFile = join(dirname(layoutFile), 'opslane-client.tsx');
      const clientSource = await readSource(join(projectRoot, clientFile));
      if (clientSource === null) {
        patches.push({
          filePath: clientFile,
          action: 'create',
          content: nextClientContent(),
        });
      } else {
        const repaired = repairNextClient(clientSource);
        if (repaired !== clientSource) {
          patches.push({ filePath: clientFile, action: 'replace', content: repaired });
        }
      }

      const layoutSource = (await readSource(join(projectRoot, layoutFile))) ?? '';
      const importedClient = layoutSource.match(
        /import\s*\{\s*OpslaneClient(?:\s+as\s+([\w$]+))?\s*\}\s*from\s*['"]\.\/opslane-client['"]\s*;?/,
      );
      const clientLocalName = importedClient?.[1] ?? 'OpslaneClient';
      if (!importedClient) {
        patches.push({
          filePath: layoutFile,
          action: 'modify',
          insertAfter: lastImportStatement(layoutSource),
          insertContent: "import { OpslaneClient } from './opslane-client';",
        });
      }

      if (!new RegExp(`<${clientLocalName}\\s*/>`).test(layoutSource)) {
        const bodyTag = bodyOpeningTag(layoutSource);
        if (bodyTag) {
          patches.push({
            filePath: layoutFile,
            action: 'modify',
            insertAfter: bodyTag,
            insertContent: `<${clientLocalName} />`,
          });
        }
      }
    } else {
      const source = (await readSource(join(projectRoot, layoutFile))) ?? '';
      const initLocalName = sdkImportLocalName(source, 'init');
      const needsImport = initLocalName === null;
      const callName = initLocalName ?? 'init';
      const needsInit = !hasCall(source, callName);
      if (needsImport || needsInit) {
        const additions: string[] = [];
        if (needsImport) additions.push("import { init } from '@opslane/sdk';");
        if (needsImport && needsInit) additions.push('');
        if (needsInit) {
          additions.push(
            'const opslaneApiKey = process.env.NEXT_PUBLIC_OPSLANE_API_KEY;',
            'if (opslaneApiKey) init({ apiKey: opslaneApiKey });',
          );
        }
        patches.push({
          filePath: layoutFile,
          action: 'modify',
          insertAfter: lastImportStatement(source),
          insertContent: additions.join('\n'),
        });
      }
    }

    return patches;
  },
};
