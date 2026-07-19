import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig, PasswordAuthResult } from '../types/api';
import { useLoginFlow, type LoginFlowDependencies } from './useLoginFlow';

const embeddedConfig: AuthConfig = {
  provider: 'workos',
  supports_password: true,
  supports_signup: true,
  supports_reset: true,
};

function authResult(result: PasswordAuthResult): () => Promise<PasswordAuthResult> {
  return () => Promise.resolve(result);
}

function dependencies(overrides: Partial<LoginFlowDependencies> = {}): LoginFlowDependencies {
  return {
    fetchAuthConfig: () => Promise.resolve(embeddedConfig),
    passwordLogin: authResult({ status: 'error', code: 401, message: 'invalid email or password' }),
    signup: authResult({ status: 'error', code: 409, message: 'email already registered' }),
    verifyEmail: authResult({ status: 'error', code: 401, message: 'invalid code' }),
    forgotPassword: () => Promise.resolve({ status: 'sent' }),
    completeAuthentication: () => Promise.resolve(),
    ...overrides,
  };
}

describe('useLoginFlow', () => {
  it('shows a retryable config error when discovery fails', async () => {
    const flow = useLoginFlow(dependencies({
      fetchAuthConfig: () => Promise.reject(new Error('offline')),
    }));

    await flow.loadConfig();

    expect(flow.mode.value).toBe('config-error');
    expect(flow.error.value).toContain('configuration');
  });

  it('uses redirect mode when password authentication is unavailable', async () => {
    const flow = useLoginFlow(dependencies({
      fetchAuthConfig: () => Promise.resolve({
        ...embeddedConfig,
        supports_password: false,
      }),
    }));

    await flow.loadConfig();

    expect(flow.mode.value).toBe('redirect');
  });

  it('keeps a login failure inline', async () => {
    const flow = useLoginFlow(dependencies());
    await flow.loadConfig();
    flow.email.value = 'person@example.com';
    flow.password.value = 'wrong';

    await flow.submitCredentials();

    expect(flow.mode.value).toBe('signin');
    expect(flow.error.value).toBe('invalid email or password');
  });

  it('moves to code verification and retains the pending token', async () => {
    const flow = useLoginFlow(dependencies({
      signup: authResult({
        status: 'email_verification_required',
        pending_authentication_token: 'pat_123',
      }),
    }));
    await flow.loadConfig();
    flow.showSignup();
    flow.email.value = 'person@example.com';
    flow.password.value = 'secret';

    await flow.submitCredentials();

    expect(flow.mode.value).toBe('verify-code');
    expect(flow.pendingAuthenticationToken.value).toBe('pat_123');
  });

  it('shows a neutral check-email state after a reset request', async () => {
    const flow = useLoginFlow(dependencies());
    await flow.loadConfig();
    flow.showForgot();
    flow.email.value = 'person@example.com';

    await flow.submitForgotPassword();

    expect(flow.mode.value).toBe('forgot-sent');
    expect(flow.error.value).toBe('');
  });

  it('runs shared post-auth completion after a verified code succeeds', async () => {
    const completeAuthentication = vi.fn().mockResolvedValue(undefined);
    const flow = useLoginFlow(dependencies({
      signup: authResult({
        status: 'email_verification_required',
        pending_authentication_token: 'pat_123',
      }),
      verifyEmail: authResult({
        status: 'authenticated',
        user: {
          id: 'user_1',
          org_id: 'org_1',
          email: 'person@example.com',
          name: 'Person',
          is_admin: false,
        },
      }),
      completeAuthentication,
    }));
    await flow.loadConfig();
    flow.showSignup();
    await flow.submitCredentials();
    flow.code.value = '123456';

    await flow.submitVerification();

    expect(completeAuthentication).toHaveBeenCalledOnce();
    expect(flow.mode.value).toBe('success');
  });
});
