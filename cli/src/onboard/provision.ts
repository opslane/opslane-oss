import {
  loadTokensFrom,
  updateTokensAt,
  type TokenPair,
} from '../auth.js';
import {
  pollSessionOnce,
  responseJSON,
  retryAfterSeconds,
} from '../agent-protocol.js';
import {
  defaultPendingDir,
  deletePendingSession,
  findPendingByRepo,
  savePendingSession,
  validatePollId,
  type PendingSession,
} from '../pending.js';
import {
  defaultCredentialsPath,
  saveAgentCredentials,
} from '../agent-credentials.js';
import { canonicalOrigin } from '../origin.js';
import {
  ApiUnreachableError,
  LoginFailedError,
  NotAuthenticatedError,
  NotAuthorizedError,
} from './errors.js';

export interface EnsureLoggedInOptions {
  apiUrl: string;
  tokenPath: string;
  loginFn: () => Promise<void>;
  fetchFn?: typeof fetch;
}

/**
 * Bounded so the credentials lock this runs under is never held on a stalled
 * connection. Must stay below fsutil's lock timeout.
 */
const REFRESH_TIMEOUT_MS = 15_000;

async function refreshTokens(
  apiUrl: string,
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<TokenPair | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const response = await fetchFn(`${apiUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    if (typeof record['access_token'] !== 'string'
      || typeof record['refresh_token'] !== 'string'
      || typeof record['expires_in'] !== 'number') {
      return null;
    }
    return {
      accessToken: record['access_token'],
      refreshToken: record['refresh_token'],
      expiresAt: Date.now() + record['expires_in'] * 1_000,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureLoggedIn(options: EnsureLoggedInOptions): Promise<TokenPair> {
  const apiUrl = canonicalOrigin(options.apiUrl);
  const fetchFn = options.fetchFn ?? fetch;

  const live = await loadTokensFrom(options.tokenPath, apiUrl);
  if (live) return live;

  // The refresh runs under the credentials lock on purpose: a refresh token is
  // single-use, so two concurrent CLI runs must not both spend it. The fetch is
  // bounded (REFRESH_TIMEOUT_MS) so the lock is never held indefinitely, and
  // fsutil reclaims a lock whose holder died before releasing it.
  let refreshed: TokenPair | null = null;
  try {
    refreshed = await updateTokensAt(options.tokenPath, apiUrl, async (current) => {
      if (current && Date.now() < current.expiresAt) return current;
      if (!current?.refreshToken) return null;
      return refreshTokens(apiUrl, current.refreshToken, fetchFn);
    });
  } catch {
    // Either the lock could not be taken or the rotated pair could not be
    // persisted. updateTokensAt has already dropped any burned token, so fall
    // through to an interactive login rather than replaying it.
    refreshed = null;
  }
  if (refreshed && Date.now() < refreshed.expiresAt) return refreshed;

  await options.loginFn();
  const after = await loadTokensFrom(options.tokenPath, apiUrl);
  if (!after) throw new LoginFailedError();
  return after;
}

export interface ProvisionResult {
  apiKey: string;
  endpoint: string;
  orgId: string;
  projectId: string;
  sessionId: string;
  pollToken: string;
}

export interface EnsureProvisionedOptions {
  apiUrl: string;
  repo: string;
  token: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  pendingDir?: string;
  credentialsPath?: string;
  max429Retries?: number;
}

const RESUMABLE = new Set(['provisioned', 'key_ok', 'app_reporting', 'completed']);

const MAX_RETRY_AFTER_MS = 60_000;

export async function ensureProvisioned(
  options: EnsureProvisionedOptions,
): Promise<ProvisionResult> {
  const apiUrl = canonicalOrigin(options.apiUrl);
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pendingDir = options.pendingDir ?? defaultPendingDir();
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();

  const pending = await findPendingByRepo(apiUrl, options.repo, pendingDir);
  if (pending) {
    const probe = await pollSessionOnce({
      apiUrl,
      sessionId: pending.poll_id,
      pollToken: pending.poll_token,
      fetchFn,
    });
    if (probe.status === 'unreachable') {
      throw new ApiUnreachableError(apiUrl);
    }
    if (probe.status !== 'unknown'
      && RESUMABLE.has(probe.status)
      && probe.apiKey
      && probe.orgId
      && probe.projectId) {
      const result: ProvisionResult = {
        apiKey: probe.apiKey,
        endpoint: apiUrl,
        orgId: probe.orgId,
        projectId: probe.projectId,
        sessionId: pending.poll_id,
        pollToken: pending.poll_token,
      };
      await saveAgentCredentials({
        org_id: result.orgId,
        project_id: result.projectId,
        api_key: result.apiKey,
        repo: options.repo,
        api_url: apiUrl,
      }, credentialsPath);
      return result;
    }
    const sessionIsDead = probe.status === 'expired'
      || probe.status === 'not_found'
      || probe.status === 'failed'
      || (probe.status !== 'unknown'
        && RESUMABLE.has(probe.status)
        && (!probe.apiKey || !probe.orgId || !probe.projectId));
    if (!sessionIsDead) {
      const detail = probe.status === 'rate_limited'
        ? `rate limited; retry after ${probe.retryAfterSeconds ?? 60} seconds`
        : probe.status === 'internal_error'
          ? probe.message ?? 'server error'
          : probe.status === 'unknown'
            ? `unrecognized server status ${JSON.stringify(probe.serverStatus)}`
            : `session is still ${probe.status}`;
      throw new Error(
        `could not safely resume onboarding session ${pending.poll_id}: ${detail}`,
      );
    }

    await deletePendingSession(pending.poll_id, pendingDir).catch(() => undefined);
  }

  const max429Retries = options.max429Retries ?? 3;
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetchFn(`${apiUrl}/api/v1/onboard/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({ repo_url: options.repo }),
      });
    } catch {
      throw new ApiUnreachableError(apiUrl);
    }
    if (response.status === 429 && attempt < max429Retries) {
      const body = await responseJSON(response.clone()) ?? {};
      // Retry-After is server-controlled and unbounded; cap it so a bad value
      // parks the CLI for a minute instead of a day.
      await sleepFn(Math.min(retryAfterSeconds(response, body) * 1_000, MAX_RETRY_AFTER_MS));
      continue;
    }
    break;
  }

  if (response.status === 401) throw new NotAuthenticatedError();
  if (response.status === 403) throw new NotAuthorizedError();
  const body = await responseJSON(response);
  if (response.status !== 201 || !body || body['status'] !== 'provisioned') {
    const detail = body
      ? (body['error'] ?? body['message'] ?? body['status'])
      : 'unparseable response';
    throw new Error(`provisioning failed (HTTP ${response.status}): ${String(detail)}`);
  }

  const apiKey = body['api_key'];
  const orgId = body['org_id'];
  const projectId = body['project_id'];
  const pollId = body['poll_id'];
  const pollToken = body['poll_token'];
  const endpoint = typeof body['endpoint'] === 'string' ? body['endpoint'] : apiUrl;
  if (typeof apiKey !== 'string'
    || typeof orgId !== 'string'
    || typeof projectId !== 'string'
    || typeof pollId !== 'string'
    || typeof pollToken !== 'string') {
    throw new Error('provisioning response omitted required credentials');
  }
  validatePollId(pollId);

  const session: PendingSession = {
    kind: 'onboard',
    poll_id: pollId,
    poll_token: pollToken,
    api_url: apiUrl,
    repo: options.repo,
    created_at: new Date().toISOString(),
  };
  await savePendingSession(session, pendingDir);
  await saveAgentCredentials({
    org_id: orgId,
    project_id: projectId,
    api_key: apiKey,
    repo: options.repo,
    api_url: apiUrl,
  }, credentialsPath);

  return {
    apiKey,
    endpoint,
    orgId,
    projectId,
    sessionId: pollId,
    pollToken,
  };
}
