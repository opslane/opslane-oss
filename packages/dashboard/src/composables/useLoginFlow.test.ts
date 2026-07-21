import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig, PasswordAuthResult } from '../types/api';
import { useLoginFlow, type LoginFlowDependencies } from './useLoginFlow';

const embeddedConfig: AuthConfig = {
  provider: 'workos',
  supports_password: true,
  supports_signup: true,
  supports_reset: true,
  social_providers: [],
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
    verifyOAuthEmail: () => Promise.resolve({ status: 'error', code: 401, message: 'invalid code' }),
    forgotPassword: () => Promise.resolve({ status: 'sent' }),
    completeAuthentication: () => Promise.resolve(),
    navigate: vi.fn(),
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

  it('begins OAuth code verification without holding a pending token', () => {
    const flow = useLoginFlow(dependencies());

    flow.beginOAuthVerification();

    expect(flow.mode.value).toBe('verify-code');
    expect(flow.verificationMode.value).toBe('oauth');
    expect(flow.pendingAuthenticationToken.value).toBe('');
  });

  it('submits only the code for OAuth verification and navigates to the returned redirect', async () => {
    const verifyEmail = vi.fn();
    const verifyOAuthEmail = vi.fn().mockResolvedValue({
      status: 'verified',
      redirect_to: 'http://127.0.0.1:8765/callback?code=cli-code',
    });
    const completeAuthentication = vi.fn();
    const navigate = vi.fn();
    const flow = useLoginFlow(dependencies({
      verifyEmail,
      verifyOAuthEmail,
      completeAuthentication,
      navigate,
    }));
    flow.beginOAuthVerification();
    flow.code.value = ' 123456 ';

    await flow.submitVerification();

    expect(verifyOAuthEmail).toHaveBeenCalledWith('123456');
    expect(verifyEmail).not.toHaveBeenCalled();
    expect(completeAuthentication).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('http://127.0.0.1:8765/callback?code=cli-code');
    expect(flow.mode.value).toBe('success');
  });

  it('restarts an OAuth challenge through the hosted login route', () => {
    const navigate = vi.fn();
    const flow = useLoginFlow(dependencies({ navigate }));
    flow.beginOAuthVerification();

    flow.restartAuthentication();

    expect(navigate).toHaveBeenCalledWith('/auth/login');
    expect(flow.mode.value).toBe('verify-code');
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
