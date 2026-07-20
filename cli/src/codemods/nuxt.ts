import { join } from 'node:path';
import type { Codemod, FilePatch } from './types.js';
import {
  hasCall,
  lastImportStatement,
  readSource,
  sdkImportLocalName,
} from './source.js';

export const nuxtCodemod: Codemod = {
  framework: 'nuxt',
  description: 'Add Opslane SDK to a Nuxt application',

  async generate(projectRoot: string): Promise<FilePatch[]> {
    const patches: FilePatch[] = [];
    const pluginFile = 'plugins/opslane.client.ts';
    const pluginSource = await readSource(join(projectRoot, pluginFile));

    if (pluginSource === null) {
      patches.push({
        filePath: pluginFile,
        action: 'create',
        content: [
          "import { init } from '@opslane/sdk';",
          '',
          'export default defineNuxtPlugin(() => {',
          '  const config = useRuntimeConfig();',
          '  init({ apiKey: config.public.opslaneApiKey });',
          '});',
          '',
        ].join('\n'),
      });
    } else {
      const initLocalName = sdkImportLocalName(pluginSource, 'init');
      const needsImport = initLocalName === null;
      const callName = initLocalName ?? 'init';
      const needsInit = !hasCall(pluginSource, callName);
      if (needsImport) {
        patches.push({
          filePath: pluginFile,
          action: 'modify',
          insertAfter: lastImportStatement(pluginSource),
          insertContent: "import { init } from '@opslane/sdk';",
        });
      }
      if (needsInit) {
        const pluginOpening = pluginSource.match(/defineNuxtPlugin\s*\(\s*\(\)\s*=>\s*\{/)?.[0];
        if (pluginOpening) {
          patches.push({
            filePath: pluginFile,
            action: 'modify',
            insertAfter: pluginOpening,
            insertContent: [
              '  const config = useRuntimeConfig();',
              `  ${callName}({ apiKey: config.public.opslaneApiKey });`,
            ].join('\n'),
          });
        }
      }
    }

    const configCandidates = ['nuxt.config.ts', 'nuxt.config.js'];
    let configFile: string | null = null;
    let configSource: string | null = null;
    for (const candidate of configCandidates) {
      const source = await readSource(join(projectRoot, candidate));
      if (source !== null) {
        configFile = candidate;
        configSource = source;
        break;
      }
    }

    if (configFile === null || configSource === null) {
      patches.push({
        filePath: 'nuxt.config.ts',
        action: 'create',
        content: [
          'export default defineNuxtConfig({',
          '  runtimeConfig: {',
          '    public: {',
          "      opslaneApiKey: '',",
          '    },',
          '  },',
          '});',
          '',
        ].join('\n'),
      });
    } else if (!/\bopslaneApiKey\s*:/.test(configSource)) {
      const publicOpening = configSource.match(/\bpublic\s*:\s*\{/)?.[0];
      const runtimeOpening = configSource.match(/\bruntimeConfig\s*:\s*\{/)?.[0];
      const configOpening = configSource.match(/defineNuxtConfig\s*\(\s*\{/)?.[0];
      if (publicOpening) {
        patches.push({
          filePath: configFile,
          action: 'modify',
          insertAfter: publicOpening,
          insertContent: "opslaneApiKey: '',",
        });
      } else if (runtimeOpening) {
        patches.push({
          filePath: configFile,
          action: 'modify',
          insertAfter: runtimeOpening,
          insertContent: "public: { opslaneApiKey: '' },",
        });
      } else if (configOpening) {
        patches.push({
          filePath: configFile,
          action: 'modify',
          insertAfter: configOpening,
          insertContent: "runtimeConfig: { public: { opslaneApiKey: '' } },",
        });
      }
    }

    return patches;
  },
};
