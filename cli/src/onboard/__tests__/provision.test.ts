import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistTokensTo } from '../../auth.js';
import {
  loadAgentCredentials,
} from '../../agent-credentials.js';
import {
  loadPendingSession,
  savePendingSession,
} from '../../pending.js';
import {
  ensureLoggedIn,
  ensureProvisioned,
  type EnsureProvisionedOptions,
} from '../provision.js';
import {
  ApiUnreachableError,
  LoginFailedError,
  NotAuthenticatedError,
  NotAuthorizedError,
} from '../errors.js';

const API = 'http://localhost:8082';
const LIVE = {
  accessToken: 'live',
  refreshToken: 'r1',
  expiresAt: Date.now() + 3_600_000,
};
const DEAD = {
  accessToken: 'dead',
  refreshToken: 'r2',
  expiresAt: Date.now() - 1_000,
};
const PROVISIONED = {
  status: 'provisioned',
  api_key: 'opk_raw',
  endpoint: API,
  org_id: 'org1',
  project_id: 'proj1',
  repo: 'acme/web',
  poll_id: '123e4567-e89b-42d3-a456-426614174000',
  poll_token: 'ptok',
};
const OLD_ID = '123e4567-e89b-42d3-a456-426614174001';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function tokenFile(pair?: typeof LIVE): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'opslane-auth-'));
  const path = join(directory, 'credentials.json');
  if (pair) await persistTokensTo(path, API, pair);
  return path;
}

async function paths(): Promise<{ pendingDir: string; credentialsPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'opslane-provision-'));
  return {
    pendingDir: join(directory, 'pending'),
    credentialsPath: join(directory, 'agent-credentials.json'),
  };
}

async function base(
  overrides: Partial<EnsureProvisionedOptions> = {},
): Promise<EnsureProvisionedOptions> {
  return {
    apiUrl: API,
    repo: 'acme/web',
    token: 'bearer1',
    ...(await paths()),
    ...overrides,
  };
}

async function seedPending(options: EnsureProvisionedOptions): Promise<void> {
  await savePendingSession({
    kind: 'onboard',
    poll_id: OLD_ID,
    poll_token: 'old-token',
    api_url: API,
    repo: 'acme/web',
    created_at: new Date().toISOString(),
  }, options.pendingDir);
}

describe('ensureLoggedIn', () => {
  it('returns a live token without refresh or login', async () => {
    const tokenPath = await tokenFile(LIVE);
    const loginFn = vi.fn();
    const fetchFn = vi.fn();
    await expect(ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn }))
      .resolves.toMatchObject({ accessToken: 'live' });
    expect(loginFn).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes an expired token before opening login', async () => {
    const tokenPath = await tokenFile(DEAD);
    const loginFn = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(response(200, {
      access_token: 'fresh',
      refresh_token: 'r3',
      expires_in: 900,
    }));
    await expect(ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn }))
      .resolves.toMatchObject({ accessToken: 'fresh' });
    expect(loginFn).not.toHaveBeenCalled();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${API}/auth/refresh`);
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'r2' });
  });

  it('falls back to login once after refresh rejection', async () => {
    const tokenPath = await tokenFile(DEAD);
    const fetchFn = vi.fn().mockResolvedValue(response(401, { error: 'expired' }));
    const loginFn = vi.fn(async () => persistTokensTo(tokenPath, API, LIVE));
    await expect(ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn }))
      .resolves.toMatchObject({ accessToken: 'live' });
    expect(loginFn).toHaveBeenCalledTimes(1);
  });

  it('throws when login produces no live token', async () => {
    const tokenPath = await tokenFile();
    const loginFn = vi.fn(async () => undefined);
    await expect(ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn: vi.fn() }))
      .rejects.toBeInstanceOf(LoginFailedError);
    expect(loginFn).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent refreshes so the refresh token is consumed once', async () => {
    const tokenPath = await tokenFile(DEAD);
    const fetchFn = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return response(200, {
        access_token: 'fresh',
        refresh_token: 'r3',
        expires_in: 900,
      });
    });
    const loginFn = vi.fn();
    const [first, second] = await Promise.all([
      ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn }),
      ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(first.accessToken).toBe('fresh');
    expect(second.accessToken).toBe('fresh');
    expect(loginFn).not.toHaveBeenCalled();
  });
});

describe('ensureProvisioned', () => {
  it('POSTs, saves onboard pending state and credentials, and returns the tuple', async () => {
    const options = await base({
      fetchFn: vi.fn().mockResolvedValue(response(201, PROVISIONED)),
    });
    const result = await ensureProvisioned(options);
    expect(result).toMatchObject({
      apiKey: 'opk_raw',
      endpoint: API,
      orgId: 'org1',
      projectId: 'proj1',
      sessionId: PROVISIONED.poll_id,
      pollToken: 'ptok',
    });
    const fetchFn = options.fetchFn as ReturnType<typeof vi.fn>;
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${API}/api/v1/onboard/provision`);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bearer1');
    await expect(loadPendingSession(PROVISIONED.poll_id, options.pendingDir))
      .resolves.toMatchObject({ kind: 'onboard' });
    await expect(loadAgentCredentials({
      apiUrl: API,
      repo: 'acme/web',
      filePath: options.credentialsPath,
    })).resolves.toMatchObject({ api_key: 'opk_raw' });
  });

  it('polls and reuses a live pending session without POSTing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200, {
      status: 'key_ok',
      api_key: 'resumed-key',
      org_id: 'org1',
      project_id: 'proj1',
      repo: 'acme/web',
    }));
    const options = await base({ fetchFn });
    await seedPending(options);
    await expect(ensureProvisioned(options)).resolves.toMatchObject({
      apiKey: 'resumed-key',
      sessionId: OLD_ID,
      pollToken: 'old-token',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toContain(`/api/v1/agent/poll/${OLD_ID}`);
  });

  it.each([
    ['expired', response(410, { status: 'expired' })],
    ['completed without a key', response(200, {
      status: 'completed',
      org_id: 'org1',
      project_id: 'proj1',
    })],
  ])('replaces a dead pending session: %s', async (_label, probe) => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce(response(201, PROVISIONED));
    const options = await base({ fetchFn });
    await seedPending(options);
    await expect(ensureProvisioned(options)).resolves.toMatchObject({
      sessionId: PROVISIONED.poll_id,
    });
    await expect(loadPendingSession(OLD_ID, options.pendingDir)).resolves.toBeNull();
    await expect(loadPendingSession(PROVISIONED.poll_id, options.pendingDir))
      .resolves.toMatchObject({ kind: 'onboard' });
  });

  it.each([
    [401, NotAuthenticatedError],
    [403, NotAuthorizedError],
  ])('maps HTTP %s to a typed auth error', async (status, ErrorType) => {
    const options = await base({
      fetchFn: vi.fn().mockResolvedValue(response(status, { error: 'denied' })),
    });
    await expect(ensureProvisioned(options)).rejects.toBeInstanceOf(ErrorType);
  });

  it('retries only rate-limited requests using retry_after', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response(429, { status: 'rate_limited', retry_after: 5 }))
      .mockResolvedValueOnce(response(201, PROVISIONED));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await expect(ensureProvisioned(await base({ fetchFn, sleepFn }))).resolves.toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(5_000);
  });

  it('caps a hostile retry_after instead of parking the CLI', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response(429, { status: 'rate_limited', retry_after: 86_400 }))
      .mockResolvedValueOnce(response(201, PROVISIONED));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await expect(ensureProvisioned(await base({ fetchFn, sleepFn }))).resolves.toBeDefined();
    expect(sleepFn).toHaveBeenCalledWith(60_000);
  });

  it('caps a hostile Retry-After header too', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'rate_limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '999999' },
      }))
      .mockResolvedValueOnce(response(201, PROVISIONED));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await expect(ensureProvisioned(await base({ fetchFn, sleepFn }))).resolves.toBeDefined();
    expect(sleepFn).toHaveBeenCalledWith(60_000);
  });

  it('does not retry an ambiguous network failure on POST', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const sleepFn = vi.fn();
    await expect(ensureProvisioned(await base({ fetchFn, sleepFn })))
      .rejects.toBeInstanceOf(ApiUnreachableError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('preserves pending state when its resume probe is unreachable', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const options = await base({ fetchFn });
    await seedPending(options);
    await expect(ensureProvisioned(options)).rejects.toBeInstanceOf(ApiUnreachableError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expect(loadPendingSession(OLD_ID, options.pendingDir)).resolves.not.toBeNull();
  });

  it.each([
    ['rate limited', response(429, { status: 'rate_limited', retry_after: 7 })],
    ['server error', response(500, { status: 'internal_error', message: 'try later' })],
    ['still pending', response(200, { status: 'pending' })],
    ['unknown', response(200, { status: 'future_status' })],
  ])('preserves pending state instead of rotating when the probe is %s', async (_label, probe) => {
    const fetchFn = vi.fn().mockResolvedValue(probe);
    const options = await base({ fetchFn });
    await seedPending(options);
    await expect(ensureProvisioned(options)).rejects.toThrow(/safely resume/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expect(loadPendingSession(OLD_ID, options.pendingDir)).resolves.not.toBeNull();
  });

  it('rejects incomplete success responses without saving credentials', async () => {
    const options = await base({
      fetchFn: vi.fn().mockResolvedValue(response(201, {
        ...PROVISIONED,
        org_id: undefined,
      })),
    });
    await expect(ensureProvisioned(options)).rejects.toThrow(/omitted required credentials/);
    await expect(loadAgentCredentials({
      apiUrl: API,
      repo: 'acme/web',
      filePath: options.credentialsPath,
    })).resolves.toBeNull();
  });
});
