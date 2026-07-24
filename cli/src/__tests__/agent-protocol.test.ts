import { describe, expect, it, vi } from 'vitest';
import { pollSessionOnce } from '../agent-protocol.js';

const OPTS = {
  apiUrl: 'http://localhost:8082',
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
  pollToken: 'tok_abc',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('pollSessionOnce', () => {
  it('sends the poll token header to the poll endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'pending' }));
    await pollSessionOnce({ ...OPTS, fetchFn });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${OPTS.apiUrl}/api/v1/agent/poll/${OPTS.sessionId}`);
    expect((init.headers as Record<string, string>)['X-Opslane-Poll-Token']).toBe('tok_abc');
  });

  it('passes server progress statuses through verbatim with payloads', async () => {
    for (const status of ['provisioned', 'key_ok', 'app_reporting'] as const) {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, {
        status,
        api_key: 'opk_raw',
        org_id: 'org1',
        project_id: 'proj1',
        repo: 'acme/web',
      }));
      const result = await pollSessionOnce({ ...OPTS, fetchFn });
      expect(result.status).toBe(status);
      if (result.status === status) {
        expect(result.apiKey).toBe('opk_raw');
        expect(result.orgId).toBe('org1');
        expect(result.projectId).toBe('proj1');
      }
    }
  });

  it.each([
    [404, { status: 'not_found' }, 'not_found'],
    [410, { status: 'pending' }, 'expired'],
    [500, { status: 'pending' }, 'internal_error'],
    [401, { status: 'completed', api_key: 'k' }, 'internal_error'],
  ] as const)('maps HTTP %s ahead of body status', async (status, body, expected) => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(status, body));
    expect((await pollSessionOnce({ ...OPTS, fetchFn })).status).toBe(expected);
  });

  it('maps 429 retry hints from body and header', async () => {
    const bodyFetch = vi.fn().mockResolvedValue(
      jsonResponse(429, { status: 'rate_limited', retry_after: 7 }),
    );
    const bodyResult = await pollSessionOnce({ ...OPTS, fetchFn: bodyFetch });
    expect(bodyResult.status === 'rate_limited' && bodyResult.retryAfterSeconds).toBe(7);

    const headerFetch = vi.fn().mockResolvedValue(
      jsonResponse(429, { status: 'rate_limited' }, { 'Retry-After': '11' }),
    );
    const headerResult = await pollSessionOnce({ ...OPTS, fetchFn: headerFetch });
    expect(headerResult.status === 'rate_limited' && headerResult.retryAfterSeconds).toBe(11);
  });

  it('returns unreachable on fetch rejection', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await pollSessionOnce({ ...OPTS, fetchFn })).status).toBe('unreachable');
  });

  it('maps malformed JSON to internal_error carrying raw body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    expect(result.status).toBe('internal_error');
    if (result.status === 'internal_error') expect(result.message).toContain('oops');
  });

  it('uses the error dialect message based on HTTP status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid session id' }));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    expect(result.status).toBe('internal_error');
    if (result.status === 'internal_error') expect(result.message).toBe('invalid session id');
  });

  it('surfaces unknown server statuses without collapsing them', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'wat' }));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    expect(result.status).toBe('unknown');
    if (result.status === 'unknown') expect(result.serverStatus).toBe('wat');
  });
});
