import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { detectFramework, type Framework } from './detect.js';
import { getCodemod } from './codemods/registry.js';
import { generateFallbackPatches } from './ai-fallback.js';
import { defaultCredentialsPath, resolveCredentials } from './agent-credentials.js';
import { canonicalOrigin } from './origin.js';
import { defaultApiUrl } from './config.js';
import { detectRepoFromGit } from './setup.js';
import { jsonOutput, exitWithStatus } from './output.js';
import type { FilePatch } from './codemods/types.js';

const HOSTED_ORIGIN = 'https://api.opslane.com';

export interface SnippetOptions {
  framework?: string;
  apiKey?: string;
  apiUrl?: string;
  repo?: string;
  cwd?: string;
  credentialsPath?: string;
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
  env: { var: string; value: string; file: '.env.local'; gitignore: true };
  endpoint?: string;
}

class MissingCredentialsError extends Error {}

async function installCommand(cwd: string): Promise<string> {
  const candidates: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm add @opslane/sdk'],
    ['yarn.lock', 'yarn add @opslane/sdk'],
    ['bun.lockb', 'bun add @opslane/sdk'],
    ['bun.lock', 'bun add @opslane/sdk'],
  ];
  for (const [file, command] of candidates) {
    try { await access(join(cwd, file)); return command; } catch { /* next */ }
  }
  return 'npm install @opslane/sdk';
}

function envVarFor(framework: Framework): string {
  if (framework === 'react-vite' || framework === 'vue-vite') return 'VITE_OPSLANE_API_KEY';
  if (framework === 'nextjs') return 'NEXT_PUBLIC_OPSLANE_API_KEY';
  if (framework === 'nuxt') return 'NUXT_PUBLIC_OPSLANE_API_KEY';
  return 'OPSLANE_API_KEY';
}

function withEndpoint(patch: FilePatch, endpoint: string | undefined): FilePatch {
  if (!endpoint) return patch;
  const add = (source: string): string => source
    .replace(/(apiKey:\s*[^,\n}]+,)(\n)/g, `$1$2  endpoint: '${endpoint}',$2`)
    .replace(/init\(\{ apiKey \}\);/g, `init({ apiKey, endpoint: '${endpoint}' });`)
    .replace(/init\(\{ apiKey: ([^}]+) \}\);/g, `init({ apiKey: $1, endpoint: '${endpoint}' });`);
  return {
    ...patch,
    content: patch.content ? add(patch.content) : patch.content,
    insertContent: patch.insertContent ? add(patch.insertContent) : patch.insertContent,
  };
}

export async function getSnippet(options: SnippetOptions = {}): Promise<SnippetResult> {
  const cwd = options.cwd ?? process.cwd();
  const apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  const repo = options.repo ?? detectRepoFromGit(cwd);
  const creds = options.apiKey ? null : await resolveCredentials({
    apiUrl,
    repo,
    filePath: options.credentialsPath ?? defaultCredentialsPath(),
  });
  const apiKey = options.apiKey ?? creds?.api_key;
  if (!apiKey) throw new MissingCredentialsError();

  const framework: Framework = options.framework
    ? options.framework as Framework
    : await detectFramework(cwd);
  const origin = canonicalOrigin(creds?.api_url ?? apiUrl);
  const endpoint = origin === HOSTED_ORIGIN ? undefined : origin;
  const codemod = getCodemod(framework);
  const generated = codemod
    ? await codemod.generate(cwd)
    : await generateFallbackPatches(cwd);
  const patches = generated.map((patch) => withEndpoint(patch, endpoint));

  return {
    framework,
    install: await installCommand(cwd),
    patches: patches.map((patch) => ({
      file_path: patch.filePath,
      action: patch.action,
      content: patch.content,
      insert_after: patch.insertAfter,
      insert_content: patch.insertContent,
    })),
    env: {
      var: envVarFor(framework),
      value: apiKey,
      file: '.env.local',
      gitignore: true,
    },
    ...(endpoint ? { endpoint } : {}),
  };
}

export async function snippet(options: SnippetOptions = {}): Promise<void> {
  let apiUrl: string;
  try {
    apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  } catch {
    return exitWithStatus('usage_error', { message: '--api-url must be a valid http(s) URL' }, 1);
  }
  try {
    jsonOutput(await getSnippet({ ...options, apiUrl }));
  } catch (error) {
    if (error instanceof MissingCredentialsError) {
      return exitWithStatus('no_credentials', { message: 'Run "opslane setup" in this repo first.' }, 1);
    }
    return exitWithStatus('internal_error', {
      message: error instanceof Error ? error.message : 'could not generate SDK patches',
    }, 1);
  }
}
