import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Codemod, FilePatch } from './types.js';

async function findLayoutFile(projectRoot: string): Promise<string> {
  const candidates = [
    'app/layout.tsx',
    'app/layout.jsx',
    'pages/_app.tsx',
    'pages/_app.jsx',
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

export const nextjsCodemod: Codemod = {
  framework: 'nextjs',
  description: 'Add Opslane SDK to a Next.js application',

  async generate(projectRoot: string): Promise<FilePatch[]> {
    const layoutFile = await findLayoutFile(projectRoot);
    const patches: FilePatch[] = [];

    if (layoutFile.startsWith('app/')) {
      // App router — add to layout
      patches.push({
        filePath: layoutFile,
        action: 'modify',
        insertAfter: "from 'next/",
        insertContent: [
          '',
          "import { OpslaneSDK } from '@opslane/sdk';",
          '',
          '// Initialize Opslane SDK for error tracking',
          "OpslaneSDK.init({",
          "  apiKey: '<YOUR_API_KEY>',",
          "  environment: 'production',",
          "});",
        ].join('\n'),
      });
    } else {
      // Pages router — add to _app
      patches.push({
        filePath: layoutFile,
        action: 'modify',
        insertAfter: "from 'next/app'",
        insertContent: [
          '',
          "import { OpslaneSDK } from '@opslane/sdk';",
          '',
          '// Initialize Opslane SDK for error tracking',
          "OpslaneSDK.init({",
          "  apiKey: '<YOUR_API_KEY>',",
          "  environment: 'production',",
          "});",
        ].join('\n'),
      });
    }

    return patches;
  },
};
