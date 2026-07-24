import { describe, expect, it, vi } from 'vitest';
import { waitForAppReporting } from '../wait.js';

const SESSION = '123e4567-e89b-42d3-a456-426614174000';
const OPTS = {
  apiUrl: 'http://localhost:8082',
  sessionId: SESSION,
  pollToken: 'ptok',
  timeoutMs: 60_000,
  sleepFn: vi.fn().mockResolvedValue(undefined),
};

function seq(...entries: Array<{ status: number; body: unknown }>) {
  const fetchFn = vi.fn();
  for (const entry of entries) {
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify(entry.body), {
      status: entry.status,
    }));
  }
  return fetchFn;
}

describe('waitForAppReporting', () => {
  it('waits through provisioned and key_ok until app_reporting', async () => {
    const fetchFn = seq(
      { status: 200, body: { status: 'provisioned', api_key: 'k' } },
      { status: 200, body: { status: 'key_ok', api_key: 'k' } },
      { status: 200, body: { status: 'app_reporting' } },
    );
    await expect(waitForAppReporting({ ...OPTS, fetchFn }))
      .resolves.toMatchObject({ status: 'app_reporting' });
  });

  it('accepts completed as terminal success', async () => {
    const fetchFn = seq({ status: 200, body: { status: 'completed' } });
    await expect(waitForAppReporting({ ...OPTS, fetchFn }))
      .resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects a failed session once with its reason', async () => {
    const fetchFn = seq({
      status: 200,
      body: { status: 'failed', failure_reason: 'github_error' },
    });
    await expect(waitForAppReporting({ ...OPTS, fetchFn })).rejects.toThrow(/github_error/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [410, { status: 'expired' }, 'expired'],
    [404, { status: 'not_found' }, 'not found'],
  ])('rejects HTTP %s with remediation', async (status, body, message) => {
    const fetchFn = seq({ status, body });
    await expect(waitForAppReporting({ ...OPTS, fetchFn })).rejects.toThrow(message);
  });

  it('honors rate-limit retry_after before polling again', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fetchFn = seq(
      { status: 429, body: { status: 'rate_limited', retry_after: 9 } },
      { status: 200, body: { status: 'app_reporting' } },
    );
    await expect(waitForAppReporting({ ...OPTS, fetchFn, sleepFn })).resolves.toBeDefined();
    expect(sleepFn).toHaveBeenCalledWith(9_000);
  });

  it('caps Retry-After sleep to the remaining timeout', async () => {
    let current = 0;
    const nowFn = () => current;
    const sleepFn = vi.fn(async (ms: number) => { current += ms; });
    const fetchFn = seq({
      status: 429,
      body: { status: 'rate_limited', retry_after: 3_600 },
    });
    await expect(waitForAppReporting({
      ...OPTS,
      timeoutMs: 1_000,
      fetchFn,
      sleepFn,
      nowFn,
    })).rejects.toThrow(/timed out/);
    expect(sleepFn).toHaveBeenCalledWith(1_000);
  });

  it('bounds unreachable retries', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(waitForAppReporting({ ...OPTS, fetchFn, maxUnreachable: 3 }))
      .rejects.toThrow(/unreachable/i);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('times out with the session id in its message', async () => {
    const nowFn = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(61_000);
    const fetchFn = seq({ status: 200, body: { status: 'pending' } });
    await expect(waitForAppReporting({ ...OPTS, fetchFn, nowFn }))
      .rejects.toThrow(SESSION);
  });
});
