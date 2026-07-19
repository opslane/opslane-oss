import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Codemod, FilePatch } from './types.js';
import {
  findCreateAppStatement,
  hasCall,
  lastImportStatement,
  readSource,
  sdkImportLocalName,
} from './source.js';

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
    const source = (await readSource(join(projectRoot, mainFile))) ?? '';
    const patches: FilePatch[] = [];

    const initLocalName = sdkImportLocalName(source, 'init');
    const pluginLocalName = sdkImportLocalName(source, 'opslaneVuePlugin');
    const missingImports = [
      initLocalName === null ? 'init' : null,
      pluginLocalName === null ? 'opslaneVuePlugin' : null,
    ].filter((name): name is string => name !== null);
    const initCallName = initLocalName ?? 'init';
    const needsInit = !hasCall(source, initCallName);

    if (missingImports.length > 0 || needsInit) {
      const additions: string[] = [];
      if (missingImports.length > 0) {
        additions.push(
          `import { ${missingImports.join(', ')} } from '@opslane/sdk';`,
        );
      }
      if (missingImports.length > 0 && needsInit) additions.push('');
      if (needsInit) {
        additions.push(
          `${initCallName}({`,
          '  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,',
          '});',
        );
      }
      patches.push({
        filePath: mainFile,
        action: 'modify',
        insertAfter: lastImportStatement(source),
        insertContent: additions.join('\n'),
      });
    }

    const createApp = findCreateAppStatement(source);
    const appName = createApp?.appName ?? 'app';
    const pluginCallName = pluginLocalName ?? 'opslaneVuePlugin';
    const pluginUse = `${appName}.use(${pluginCallName})`;
    if (createApp && !source.includes(pluginUse)) {
      patches.push({
        filePath: mainFile,
        action: 'modify',
        insertAfter: createApp.statement,
        insertContent: `${appName}.use(${pluginCallName});`,
      });
    }

    return patches;
  },
};
