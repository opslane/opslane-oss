import { detectFramework, type Framework } from './detect.js';
import { getCodemod } from './codemods/registry.js';
import { loadAgentCredentials } from './agent-credentials.js';
import { jsonOutput } from './output.js';

export interface SnippetOptions {
  framework?: string;
  apiKey?: string;
  cwd?: string;
}

export interface SnippetResult {
  framework: string;
  install: string;
  patches: Array<{
    file_path: string;
    action: string;
    content?: string;
    insert_after?: string;
    insert_content?: string;
  }>;
}

export async function getSnippet(options: SnippetOptions = {}): Promise<SnippetResult> {
  const cwd = options.cwd ?? process.cwd();

  const framework: Framework = options.framework
    ? (options.framework as Framework)
    : await detectFramework(cwd);

  const creds = await loadAgentCredentials();
  const apiKey = options.apiKey ?? creds?.api_key;

  const codemod = getCodemod(framework);

  if (!codemod) {
    return {
      framework,
      install: 'npm install @opslane/sdk',
      patches: [{
        file_path: 'opslane-init.ts',
        action: 'create',
        content: [
          `import { Opslane } from '@opslane/sdk';`,
          '',
          `Opslane.init({ apiKey: '${apiKey ?? '<YOUR_API_KEY>'}' });`,
        ].join('\n'),
      }],
    };
  }

  const patches = await codemod.generate(cwd);

  return {
    framework,
    install: 'npm install @opslane/sdk',
    patches: patches.map(p => ({
      file_path: p.filePath,
      action: p.action,
      content: p.content,
      insert_after: p.insertAfter,
      insert_content: p.insertContent,
    })),
  };
}

export async function snippet(options: SnippetOptions = {}): Promise<void> {
  const result = await getSnippet(options);
  jsonOutput(result);
}
