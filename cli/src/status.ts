import { resolveCredentials, defaultCredentialsPath } from './agent-credentials.js';
import { jsonOutput, exitWithStatus } from './output.js';
import { defaultApiUrl } from './config.js';
import { detectRepoFromGit } from './setup.js';
import { canonicalOrigin } from './origin.js';

export interface StatusOptions {
  credentialsPath?: string;
  apiUrl?: string;
  repo?: string;
  cwd?: string;
}

export interface StatusResult {
  status: 'configured' | 'no_credentials';
  org_id?: string;
  project_id?: string;
  repo?: string;
  api_url?: string;
}

export async function getStatus(options: StatusOptions = {}): Promise<StatusResult> {
  const credPath = options.credentialsPath ?? defaultCredentialsPath();
  const creds = await resolveCredentials({
    filePath: credPath,
    apiUrl: options.apiUrl ?? defaultApiUrl(),
    repo: options.repo ?? detectRepoFromGit(options.cwd),
  });

  if (!creds) {
    return { status: 'no_credentials' };
  }

  return {
    status: 'configured',
    org_id: creds.org_id,
    project_id: creds.project_id,
    repo: creds.repo,
    api_url: creds.api_url,
  };
}

export async function status(options: StatusOptions = {}): Promise<void> {
  let apiUrl: string;
  try {
    apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  } catch {
    return exitWithStatus('usage_error', { message: '--api-url must be a valid http(s) URL' }, 1);
  }
  const result = await getStatus({ ...options, apiUrl });
  if (result.status === 'no_credentials') {
    return exitWithStatus('no_credentials', { message: 'Run "opslane setup" in this repo first.' }, 1);
  }
  jsonOutput(result);
}
