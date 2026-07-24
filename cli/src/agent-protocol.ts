/**
 * Shared wire protocol for GET /api/v1/agent/poll/{sessionId}.
 *
 * This seam preserves the server's status vocabulary. Callers are responsible
 * for translating it into their own user-facing states.
 */
import { canonicalOrigin } from './origin.js';

export type ServerPollStatus =
  | 'pending'
  | 'provisioned'
  | 'key_ok'
  | 'app_reporting'
  | 'completed'
  | 'failed'
  | 'not_found'
  | 'expired'
  | 'rate_limited'
  | 'internal_error';

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'provisioned',
  'key_ok',
  'app_reporting',
  'completed',
  'failed',
  'not_found',
  'expired',
  'rate_limited',
  'internal_error',
]);

export interface PollPayload {
  apiKey: string | null;
  orgId: string | null;
  projectId: string | null;
  repo: string | null;
  message: string | null;
  failureReason: string | null;
  retryAfterSeconds: number | null;
}

export type PollResult =
  | ({ status: ServerPollStatus } & PollPayload)
  | ({ status: 'unknown'; serverStatus: string } & PollPayload)
  | { status: 'unreachable'; error: string };

export interface PollSessionOptions {
  apiUrl: string;
  sessionId: string;
  pollToken: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export type JsonBody = Record<string, unknown>;

export async function responseJSON(response: Response): Promise<JsonBody | null> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as JsonBody
      : null;
  } catch {
    return null;
  }
}

export function retryAfterSeconds(response: Response, body: JsonBody): number {
  const bodyValue = Number(body['retry_after']);
  if (Number.isFinite(bodyValue) && bodyValue > 0) return bodyValue;
  const headerValue = Number(response.headers.get('Retry-After'));
  return Number.isFinite(headerValue) && headerValue > 0 ? headerValue : 60;
}

function str(body: JsonBody, key: string): string | null {
  return typeof body[key] === 'string' ? body[key] : null;
}

function payload(response: Response, body: JsonBody): PollPayload {
  return {
    apiKey: str(body, 'api_key'),
    orgId: str(body, 'org_id'),
    projectId: str(body, 'project_id'),
    repo: str(body, 'repo'),
    message: str(body, 'message'),
    failureReason: str(body, 'failure_reason'),
    retryAfterSeconds: retryAfterSeconds(response, body),
  };
}

const EMPTY: PollPayload = {
  apiKey: null,
  orgId: null,
  projectId: null,
  repo: null,
  message: null,
  failureReason: null,
  retryAfterSeconds: null,
};

function statusFromHTTP(code: number): ServerPollStatus {
  if (code === 404) return 'not_found';
  if (code === 410) return 'expired';
  if (code === 429) return 'rate_limited';
  return 'internal_error';
}

export async function pollSessionOnce(options: PollSessionOptions): Promise<PollResult> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(
      `${canonicalOrigin(options.apiUrl)}/api/v1/agent/poll/${encodeURIComponent(options.sessionId)}`,
      {
        headers: { 'X-Opslane-Poll-Token': options.pollToken },
        signal: options.signal,
      },
    );
  } catch (error) {
    return {
      status: 'unreachable',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const raw = await response.clone().text().catch(() => '');
  const body = await responseJSON(response);
  if (!body) {
    return {
      status: 'internal_error',
      ...EMPTY,
      message: `unparseable server response: ${raw.slice(0, 200)}`,
    };
  }

  const serverStatus = str(body, 'status');
  if (!response.ok) {
    return {
      status: statusFromHTTP(response.status),
      ...payload(response, body),
      message: str(body, 'message') ?? str(body, 'error')
        ?? (serverStatus
          ? `server said ${JSON.stringify(serverStatus)} with HTTP ${response.status}`
          : `unexpected response (HTTP ${response.status})`),
    };
  }

  if (!serverStatus) {
    return {
      status: 'internal_error',
      ...EMPTY,
      message: str(body, 'error') ?? 'response omitted status',
    };
  }
  if (!KNOWN_STATUSES.has(serverStatus)) {
    return { status: 'unknown', serverStatus, ...payload(response, body) };
  }
  return { status: serverStatus as ServerPollStatus, ...payload(response, body) };
}
