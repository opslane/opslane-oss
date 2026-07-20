import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Codemod, FilePatch } from './types.js';
import {
  hasCall,
  lastImportStatement,
  readSource,
  sdkImportLocalName,
} from './source.js';

async function findMainFile(projectRoot: string): Promise<string> {
  const candidates = ['src/main.tsx', 'src/main.jsx'];
  for (const candidate of candidates) {
    try {
      await access(join(projectRoot, candidate));
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  // Default to tsx if none exists
  return 'src/main.tsx';
}

export const reactViteCodemod: Codemod = {
  framework: 'react-vite',
  description: 'Add Opslane SDK to a React + Vite application',

  async generate(projectRoot: string): Promise<FilePatch[]> {
    const mainFile = await findMainFile(projectRoot);
    const source = (await readSource(join(projectRoot, mainFile))) ?? '';
    const initLocalName = sdkImportLocalName(source, 'init');
    const needsImport = initLocalName === null;
    const callName = initLocalName ?? 'init';
    const needsInit = !hasCall(source, callName);

    if (!needsImport && !needsInit) return [];

    const additions: string[] = [];
    if (needsImport) additions.push("import { init } from '@opslane/sdk';");
    if (needsImport && needsInit) additions.push('');
    if (needsInit) {
      additions.push(
        'init({',
        '  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,',
        '});',
      );
    }

    return [{
      filePath: mainFile,
      action: 'modify',
      insertAfter: lastImportStatement(source),
      insertContent: additions.join('\n'),
    } satisfies FilePatch];
  },
};
