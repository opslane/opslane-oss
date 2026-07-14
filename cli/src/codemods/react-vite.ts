import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Codemod, FilePatch } from './types.js';

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
    const patches: FilePatch[] = [];

    // Patch the main entry file
    patches.push({
      filePath: mainFile,
      action: 'modify',
      insertAfter: "from 'react-dom/client'",
      insertContent: [
        '',
        "import { OpslaneSDK } from '@opslane/sdk';",
        '',
        "OpslaneSDK.init({",
        "  apiKey: '<YOUR_API_KEY>',",
        "  environment: 'production',",
        "});",
      ].join('\n'),
    });

    return patches;
  },
};
