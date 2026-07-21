import { ref, type Ref } from 'vue';
import type {
  AuthConfig,
  ForgotPasswordResult,
  OAuthEmailVerificationResult,
  PasswordAuthResult,
} from '../types/api';

export type VerificationMode = 'embedded' | 'oauth';

export type LoginFlowMode =
  | 'loading'
  | 'config-error'
  | 'redirect'
  | 'signin'
  | 'signup'
  | 'verify-code'
  | 'forgot'
  | 'forgot-sent'
  | 'success';

export interface LoginFlowDependencies {
  fetchAuthConfig: () => Promise<AuthConfig>;
  passwordLogin: (email: string, password: string) => Promise<PasswordAuthResult>;
  signup: (email: string, password: string) => Promise<PasswordAuthResult>;
  verifyEmail: (pendingToken: string, code: string) => Promise<PasswordAuthResult>;
  verifyOAuthEmail: (code: string) => Promise<OAuthEmailVerificationResult>;
  forgotPassword: (email: string) => Promise<ForgotPasswordResult>;
  completeAuthentication: () => Promise<void>;
  navigate: (target: string) => void;
}

export interface LoginFlow {
  mode: Ref<LoginFlowMode>;
  config: Ref<AuthConfig | null>;
  email: Ref<string>;
  password: Ref<string>;
  code: Ref<string>;
  pendingAuthenticationToken: Ref<string>;
  verificationMode: Ref<VerificationMode>;
  error: Ref<string>;
  submitting: Ref<boolean>;
  loadConfig: () => Promise<void>;
  showSignin: () => void;
  showSignup: () => void;
  showForgot: () => void;
  beginOAuthVerification: () => void;
  restartAuthentication: () => void;
  submitCredentials: () => Promise<void>;
  submitVerification: () => Promise<void>;
  submitForgotPassword: () => Promise<void>;
}

export function useLoginFlow(deps: LoginFlowDependencies): LoginFlow {
  const mode = ref<LoginFlowMode>('loading');
  const config = ref<AuthConfig | null>(null);
  const email = ref('');
  const password = ref('');
  const code = ref('');
  const pendingAuthenticationToken = ref('');
  const verificationMode = ref<VerificationMode>('embedded');
  const error = ref('');
  const submitting = ref(false);

  async function loadConfig(): Promise<void> {
    mode.value = 'loading';
    error.value = '';
    try {
      config.value = await deps.fetchAuthConfig();
      mode.value = config.value.supports_password ? 'signin' : 'redirect';
    } catch {
      mode.value = 'config-error';
      error.value = 'Unable to load authentication configuration. Please try again.';
    }
  }

  function showSignin(): void {
    error.value = '';
    code.value = '';
    pendingAuthenticationToken.value = '';
    verificationMode.value = 'embedded';
    mode.value = 'signin';
  }

  function showSignup(): void {
    if (!config.value?.supports_signup) return;
    error.value = '';
    mode.value = 'signup';
  }

  function showForgot(): void {
    if (!config.value?.supports_reset) return;
    error.value = '';
    mode.value = 'forgot';
  }

  function beginOAuthVerification(): void {
    email.value = '';
    password.value = '';
    code.value = '';
    pendingAuthenticationToken.value = '';
    verificationMode.value = 'oauth';
    error.value = '';
    mode.value = 'verify-code';
  }

  function restartAuthentication(): void {
    if (verificationMode.value === 'oauth') {
      deps.navigate('/auth/login');
      return;
    }
    showSignin();
  }

  async function finishAuthentication(fallbackMode: 'signin' | 'signup' | 'verify-code'): Promise<void> {
    mode.value = 'success';
    try {
      await deps.completeAuthentication();
    } catch {
      mode.value = fallbackMode;
      error.value = 'Authentication succeeded, but the dashboard could not finish loading. Please try again.';
    }
  }

  async function handleAuthResult(
    result: PasswordAuthResult,
    fallbackMode: 'signin' | 'signup' | 'verify-code',
  ): Promise<void> {
    if (result.status === 'authenticated') {
      await finishAuthentication(fallbackMode);
      return;
    }
    if (result.status === 'email_verification_required') {
      pendingAuthenticationToken.value = result.pending_authentication_token;
      verificationMode.value = 'embedded';
      password.value = '';
      code.value = '';
      error.value = '';
      mode.value = 'verify-code';
      return;
    }
    error.value = result.message;
  }

  async function submitCredentials(): Promise<void> {
    if (mode.value !== 'signin' && mode.value !== 'signup') return;
    const submittedMode = mode.value;
    error.value = '';
    submitting.value = true;
    try {
      const result = submittedMode === 'signup'
        ? await deps.signup(email.value.trim(), password.value)
        : await deps.passwordLogin(email.value.trim(), password.value);
      await handleAuthResult(result, submittedMode);
    } finally {
      submitting.value = false;
    }
  }

  async function submitVerification(): Promise<void> {
    if (mode.value !== 'verify-code') return;
    if (verificationMode.value === 'embedded' && !pendingAuthenticationToken.value) return;
    error.value = '';
    submitting.value = true;
    try {
      if (verificationMode.value === 'oauth') {
        const result = await deps.verifyOAuthEmail(code.value.trim());
        if (result.status === 'verified') {
          mode.value = 'success';
          deps.navigate(result.redirect_to);
        } else {
          error.value = result.message;
        }
        return;
      }
      const result = await deps.verifyEmail(pendingAuthenticationToken.value, code.value.trim());
      await handleAuthResult(result, 'verify-code');
    } finally {
      submitting.value = false;
    }
  }

  async function submitForgotPassword(): Promise<void> {
    if (mode.value !== 'forgot') return;
    error.value = '';
    submitting.value = true;
    try {
      const result = await deps.forgotPassword(email.value.trim());
      if (result.status === 'sent') {
        mode.value = 'forgot-sent';
      } else {
        error.value = result.message;
      }
    } finally {
      submitting.value = false;
    }
  }

  return {
    mode,
    config,
    email,
    password,
    code,
    pendingAuthenticationToken,
    verificationMode,
    error,
    submitting,
    loadConfig,
    showSignin,
    showSignup,
    showForgot,
    beginOAuthVerification,
    restartAuthentication,
    submitCredentials,
    submitVerification,
    submitForgotPassword,
  };
}
