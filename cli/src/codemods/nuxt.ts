import type { Codemod, FilePatch } from './types.js';

export const nuxtCodemod: Codemod = {
  framework: 'nuxt',
  description: 'Add Opslane SDK to a Nuxt application',

  async generate(_projectRoot: string): Promise<FilePatch[]> {
    const patches: FilePatch[] = [];

    // Create a client-only Nuxt plugin
    patches.push({
      filePath: 'plugins/opslane.client.ts',
      action: 'create',
      content: [
        "import { OpslaneSDK } from '@opslane/sdk';",
        '',
        'export default defineNuxtPlugin(() => {',
        '  OpslaneSDK.init({',
        "    apiKey: '<YOUR_API_KEY>',",
        "    environment: 'production',",
        '  });',
        '});',
        '',
      ].join('\n'),
    });

    return patches;
  },
};
