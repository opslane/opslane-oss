import { loadAgentCredentials, defaultCredentialsPath } from './agent-credentials.js';
import { jsonOutput } from './output.js';

export interface VerifyOptions {
  credentialsPath?: string;
  fetchFn?: typeof fetch;
}

export interface VerifyResult {
  status: 'ok' | 'error';
  api_reachable: boolean;
  has_events: boolean;
  message: string;
}

export async function verifyConnection(options: VerifyOptions = {}): Promise<VerifyResult> {
  const credPath = options.credentialsPath ?? defaultCredentialsPath();
  const fetchFn = options.fetchFn ?? fetch;

  const creds = await loadAgentCredentials(credPath);
  if (!creds) {
    return {
      status: 'error',
      api_reachable: false,
      has_events: false,
      message: 'No credentials found. Run "opslane setup" first.',
    };
  }

  // Check API health
  let apiReachable = false;
  try {
    const healthResp = await fetchFn(`${creds.api_url}/health`);
    apiReachable = healthResp.ok;
  } catch {
    return {
      status: 'error',
      api_reachable: false,
      has_events: false,
      message: `Cannot reach API at ${creds.api_url}`,
    };
  }

  if (!apiReachable) {
    return {
      status: 'error',
      api_reachable: false,
      has_events: false,
      message: `API at ${creds.api_url} returned unhealthy status`,
    };
  }

  // Check if events have been received (server returns {has_events: bool})
  let hasEvents = false;
  try {
    const countResp = await fetchFn(
      `${creds.api_url}/api/v1/projects/${creds.project_id}/event-count`,
      { headers: { 'X-API-Key': creds.api_key } },
    );
    if (countResp.ok) {
      const body = await countResp.json() as Record<string, unknown>;
      hasEvents = (body['has_events'] as boolean) ?? false;
    }
  } catch {
    // Non-fatal — events may not have arrived yet
  }

  return {
    status: 'ok',
    api_reachable: true,
    has_events: hasEvents,
    message: hasEvents
      ? 'Connected. Events received.'
      : 'Connected. Waiting for first event.',
  };
}

export async function verify(options: VerifyOptions = {}): Promise<void> {
  const result = await verifyConnection(options);
  jsonOutput(result);
  if (result.status === 'error') {
    process.exit(1);
  }
}
