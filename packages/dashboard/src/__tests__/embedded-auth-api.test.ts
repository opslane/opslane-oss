import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

describe('embedded auth API', () => {
  it('maps a successful password login to an authenticated result', async () => {
    const user = {
      id: 'user_1',
      org_id: 'org_1',
      email: 'person@example.com',
      name: 'Person',
      is_admin: false,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const { passwordLogin } = await import('../api');

    await expect(passwordLogin('person@example.com', 'secret')).resolves.toEqual({
      status: 'authenticated',
      user,
    });
  });

  it('preserves the pending token for email verification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'email_verification_required',
      pending_authentication_token: 'pat_123',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })));
    const { signup } = await import('../api');

    await expect(signup('person@example.com', 'secret')).resolves.toEqual({
      status: 'email_verification_required',
      pending_authentication_token: 'pat_123',
    });
  });

  it('maps an auth rejection to an inline error result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid email or password',
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })));
    const { passwordLogin } = await import('../api');

    await expect(passwordLogin('person@example.com', 'wrong')).resolves.toEqual({
      status: 'error',
      code: 401,
      message: 'invalid email or password',
    });
  });

  it('maps a network rejection to an inline error result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { passwordLogin } = await import('../api');

    await expect(passwordLogin('person@example.com', 'secret')).resolves.toEqual({
      status: 'error',
      code: 0,
      message: 'Unable to reach the server. Please try again.',
    });
  });

  it('submits a password reset using the token-only WorkOS link contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'reset' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    storage.set('opslane_authed', '1');
    const { resetPassword } = await import('../api');

    await expect(resetPassword('reset-token', 'NewPassw0rd!')).resolves.toEqual({ status: 'reset' });
    expect(fetchMock).toHaveBeenCalledWith('/auth/password/reset', expect.objectContaining({
      body: JSON.stringify({ token: 'reset-token', new_password: 'NewPassw0rd!' }),
    }));
    expect(storage.has('opslane_authed')).toBe(false);
  });
});
