import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Codemod, FilePatch } from './types.js';

async function findMainFile(projectRoot: string): Promise<string> {
  const candidates = ['src/main.ts', 'src/main.js'];
  for (const candidate of candidates) {
    try {
      await access(join(projectRoot, candidate));
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  // Default to ts if none exists
  return 'src/main.ts';
}

export const vueViteCodemod: Codemod = {
  framework: 'vue-vite',
  description: 'Add Opslane SDK to a Vue + Vite application',

  async generate(projectRoot: string): Promise<FilePatch[]> {
    const mainFile = await findMainFile(projectRoot);
    const patches: FilePatch[] = [];

    // Add OpslaneSDK + Vue plugin imports and init before app.mount
    patches.push({
      filePath: mainFile,
      action: 'modify',
      insertAfter: "from 'vue'",
      insertContent: [
        "import { OpslaneSDK, opslaneVuePlugin } from '@opslane/sdk';",
        '',
        "OpslaneSDK.init({",
        "  apiKey: '<YOUR_API_KEY>',",
        "  environment: 'production',",
        "});",
      ].join('\n'),
    });

    // Add app.use(opslaneVuePlugin) after createApp
    patches.push({
      filePath: mainFile,
      action: 'modify',
      insertAfter: 'createApp(',
      insertContent: [
        '',
        'app.use(opslaneVuePlugin);',
      ].join('\n'),
    });

    return patches;
  },
};
