import { loadAgentCredentials, defaultCredentialsPath } from './agent-credentials.js';
import { jsonOutput } from './output.js';

export interface StatusOptions {
  credentialsPath?: string;
}

export interface StatusResult {
  status: 'configured' | 'not_configured';
  org_id?: string;
  project_id?: string;
  repo?: string;
  api_url?: string;
}

export async function getStatus(options: StatusOptions = {}): Promise<StatusResult> {
  const credPath = options.credentialsPath ?? defaultCredentialsPath();
  const creds = await loadAgentCredentials(credPath);

  if (!creds) {
    return { status: 'not_configured' };
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
  const result = await getStatus(options);
  jsonOutput(result);
}
