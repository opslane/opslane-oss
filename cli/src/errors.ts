import { loadAgentCredentials, defaultCredentialsPath } from './agent-credentials.js';
import { jsonOutput, exitWithError } from './output.js';

export interface ErrorsOptions {
  status?: string;
  limit?: number;
  credentialsPath?: string;
  fetchFn?: typeof fetch;
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

  const creds = await loadAgentCredentials(credPath);
  if (!creds) {
    exitWithError('No credentials found. Run "opslane setup" first.');
    return;
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

  const creds = await loadAgentCredentials(credPath);
  if (!creds) {
    exitWithError('No credentials found. Run "opslane setup" first.');
    return;
  }

  const url = `${creds.api_url}/api/v1/projects/${creds.project_id}/incidents/${encodeURIComponent(errorId)}`;
  await fetchAndOutput(fetchFn, url, creds.api_key);
}
