import { resolveCredentials, defaultCredentialsPath } from './agent-credentials.js';
import { jsonOutput, exitWithError, exitWithStatus } from './output.js';
import { defaultApiUrl } from './config.js';
import { detectRepoFromGit } from './setup.js';
import { canonicalOrigin } from './origin.js';

export interface ErrorsOptions {
  status?: string;
  limit?: number;
  credentialsPath?: string;
  fetchFn?: typeof fetch;
  apiUrl?: string;
  repo?: string;
  cwd?: string;
}

async function fetchAndOutput(fetchFn: typeof fetch, url: string, apiKey: string): Promise<void> {
  try {
    const resp = await fetchFn(url, {
      headers: { 'X-API-Key': apiKey },
    });

    if (!resp.ok) {
      exitWithError(`API error: ${resp.status}`);
    }

    const body = await resp.json();
    jsonOutput(body as Record<string, unknown>);
  } catch (err) {
    exitWithError(`Cannot reach API: ${(err as Error).message}`);
  }
}

export async function listErrors(options: ErrorsOptions = {}): Promise<void> {
  const credPath = options.credentialsPath ?? defaultCredentialsPath();
  const fetchFn = options.fetchFn ?? fetch;
  let apiUrl: string;
  try {
    apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  } catch {
    return exitWithStatus('usage_error', { message: '--api-url must be a valid http(s) URL' }, 1);
  }

  const creds = await resolveCredentials({
    filePath: credPath,
    apiUrl,
    repo: options.repo ?? detectRepoFromGit(options.cwd),
  });
  if (!creds) {
    return exitWithStatus('no_credentials', { message: 'Run "opslane setup" in this repo first.' }, 1);
  }

  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit) params.set('limit', String(options.limit));

  const url = `${creds.api_url}/api/v1/projects/${creds.project_id}/incidents?${params}`;
  await fetchAndOutput(fetchFn, url, creds.api_key);
}

export async function getError(errorId: string, options: ErrorsOptions = {}): Promise<void> {
  const credPath = options.credentialsPath ?? defaultCredentialsPath();
  const fetchFn = options.fetchFn ?? fetch;
  let apiUrl: string;
  try {
    apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  } catch {
    return exitWithStatus('usage_error', { message: '--api-url must be a valid http(s) URL' }, 1);
  }

  const creds = await resolveCredentials({
    filePath: credPath,
    apiUrl,
    repo: options.repo ?? detectRepoFromGit(options.cwd),
  });
  if (!creds) {
    return exitWithStatus('no_credentials', { message: 'Run "opslane setup" in this repo first.' }, 1);
  }

  const url = `${creds.api_url}/api/v1/projects/${creds.project_id}/incidents/${encodeURIComponent(errorId)}`;
  await fetchAndOutput(fetchFn, url, creds.api_key);
}
