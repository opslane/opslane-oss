<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  fetchAuthConfig,
  forgotPassword,
  passwordLogin,
  signup,
  verifyEmail,
} from '../api';
import { useLoginFlow } from '../composables/useLoginFlow';
import { completePostAuth } from '../post-auth';

const router = useRouter();
const {
  mode,
  config,
  email,
  password,
  code,
  error,
  submitting,
  loadConfig,
  showSignin,
  showSignup,
  showForgot,
  submitCredentials,
  submitVerification,
  submitForgotPassword,
} = useLoginFlow({
  fetchAuthConfig,
  passwordLogin,
  signup,
  verifyEmail,
  forgotPassword,
  completeAuthentication: () => completePostAuth(router),
});

function redirectSignIn(): void {
  window.location.href = '/auth/login';
}

onMounted(loadConfig);
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center px-4 py-8">
    <div class="max-w-sm w-full bg-surface rounded-lg border border-border p-8">
      <div class="mx-auto mb-6 h-10 w-10 rounded-lg bg-teal/10 flex items-center justify-center">
        <svg class="h-5 w-5 text-teal" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
        </svg>
      </div>

      <div v-if="mode === 'loading' || mode === 'success'" class="text-center">
        <div class="animate-spin h-8 w-8 border-2 border-teal border-t-transparent rounded-full mx-auto mb-4"></div>
        <p class="text-sm text-text-muted">
          {{ mode === 'success' ? 'Completing sign in...' : 'Loading sign in...' }}
        </p>
      </div>

      <div v-else-if="mode === 'config-error'" class="text-center">
        <h1 class="text-xl font-semibold text-text mb-2">Sign in unavailable</h1>
        <p class="text-sm text-red mb-6" v-text="error"></p>
        <button
          type="button"
          class="w-full rounded-md bg-teal px-4 py-3 text-sm font-medium text-background hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-teal focus:ring-offset-2 focus:ring-offset-background"
          @click="loadConfig"
        >
          Try again
        </button>
      </div>

      <div v-else-if="mode === 'redirect'" class="text-center">
        <h1 class="text-xl font-semibold text-text mb-1">Sign in to Opslane</h1>
        <p class="text-sm text-text-muted mb-8">
          Continue with your configured identity provider.
        </p>

        <button
          @click="redirectSignIn"
          class="w-full flex items-center justify-center gap-3 rounded-md bg-surface-2 border border-border px-4 py-3 text-sm font-medium text-text hover:bg-border focus:outline-none focus:ring-2 focus:ring-teal focus:ring-offset-2 focus:ring-offset-background transition-colors"
        >
          <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 0C4.477 0 0 4.477 0 10c0 4.42 2.865 8.166 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C17.137 18.163 20 14.418 20 10c0-5.523-4.477-10-10-10z" clip-rule="evenodd" />
          </svg>
          Continue to sign in
        </button>
      </div>

      <div v-else-if="mode === 'verify-code'">
        <h1 class="text-xl font-semibold text-text text-center mb-1">Verify your email</h1>
        <p class="text-sm text-text-muted text-center mb-6">
          Enter the 6-digit code sent to <span class="text-text" v-text="email"></span>.
        </p>
        <form class="space-y-4" @submit.prevent="submitVerification">
          <div>
            <label for="verification-code" class="block text-sm font-medium text-text mb-1.5">Verification code</label>
            <input
              id="verification-code"
              v-model="code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              required
              autofocus
              class="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-text placeholder:text-text-muted focus:border-teal focus:outline-none focus:ring-1 focus:ring-teal"
              placeholder="123456"
            />
          </div>
          <p v-if="error" class="text-sm text-red" role="alert" v-text="error"></p>
          <button
            type="submit"
            :disabled="submitting"
            class="w-full rounded-md bg-teal px-4 py-3 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-teal focus:ring-offset-2 focus:ring-offset-background"
          >
            {{ submitting ? 'Verifying...' : 'Verify email' }}
          </button>
        </form>
        <p class="mt-5 text-center text-sm text-text-muted">
          Lost the code?
          <button type="button" class="text-teal hover:underline" @click="showSignin">
            Sign in again to get a new one.
          </button>
        </p>
      </div>

      <div v-else-if="mode === 'forgot'">
        <h1 class="text-xl font-semibold text-text text-center mb-1">Reset your password</h1>
        <p class="text-sm text-text-muted text-center mb-6">
          We’ll email you a link to choose a new password.
        </p>
        <form class="space-y-4" @submit.prevent="submitForgotPassword">
          <div>
            <label for="reset-email" class="block text-sm font-medium text-text mb-1.5">Email</label>
            <input
              id="reset-email"
              v-model="email"
              type="email"
              autocomplete="email"
              required
              autofocus
              class="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-text placeholder:text-text-muted focus:border-teal focus:outline-none focus:ring-1 focus:ring-teal"
              placeholder="you@example.com"
            />
          </div>
          <p v-if="error" class="text-sm text-red" role="alert" v-text="error"></p>
          <button
            type="submit"
            :disabled="submitting"
            class="w-full rounded-md bg-teal px-4 py-3 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ submitting ? 'Sending...' : 'Send reset link' }}
          </button>
        </form>
        <button type="button" class="mt-5 w-full text-sm text-teal hover:underline" @click="showSignin">
          Back to sign in
        </button>
      </div>

      <div v-else-if="mode === 'forgot-sent'" class="text-center">
        <h1 class="text-xl font-semibold text-text mb-2">Check your email</h1>
        <p class="text-sm text-text-muted mb-6">
          If an account exists for <span class="text-text" v-text="email"></span>, a password reset link is on its way.
        </p>
        <button type="button" class="text-sm text-teal hover:underline" @click="showSignin">
          Back to sign in
        </button>
      </div>

      <div v-else>
        <h1 class="text-xl font-semibold text-text text-center mb-1">
          {{ mode === 'signup' ? 'Create your Opslane account' : 'Sign in to Opslane' }}
        </h1>
        <p class="text-sm text-text-muted text-center mb-6">
          {{ mode === 'signup' ? 'Start resolving production errors.' : 'Welcome back.' }}
        </p>

        <div v-if="config?.supports_signup" class="mb-6 grid grid-cols-2 rounded-md bg-surface-2 p-1" role="tablist" aria-label="Authentication mode">
          <button
            type="button"
            role="tab"
            :aria-selected="mode === 'signin'"
            class="rounded px-3 py-2 text-sm font-medium transition-colors"
            :class="mode === 'signin' ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'"
            @click="showSignin"
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="mode === 'signup'"
            class="rounded px-3 py-2 text-sm font-medium transition-colors"
            :class="mode === 'signup' ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'"
            @click="showSignup"
          >
            Sign up
          </button>
        </div>

        <form class="space-y-4" @submit.prevent="submitCredentials">
          <div>
            <label for="auth-email" class="block text-sm font-medium text-text mb-1.5">Email</label>
            <input
              id="auth-email"
              v-model="email"
              type="email"
              autocomplete="email"
              required
              autofocus
              class="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-text placeholder:text-text-muted focus:border-teal focus:outline-none focus:ring-1 focus:ring-teal"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <label for="auth-password" class="block text-sm font-medium text-text">Password</label>
              <button
                v-if="mode === 'signin' && config?.supports_reset"
                type="button"
                class="text-xs text-teal hover:underline"
                @click="showForgot"
              >
                Forgot password?
              </button>
            </div>
            <input
              id="auth-password"
              v-model="password"
              type="password"
              :autocomplete="mode === 'signup' ? 'new-password' : 'current-password'"
              required
              class="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-text placeholder:text-text-muted focus:border-teal focus:outline-none focus:ring-1 focus:ring-teal"
              placeholder="Enter your password"
            />
          </div>
          <p v-if="error" class="text-sm text-red" role="alert" v-text="error"></p>
          <button
            type="submit"
            :disabled="submitting"
            class="w-full rounded-md bg-teal px-4 py-3 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-teal focus:ring-offset-2 focus:ring-offset-background"
          >
            {{ submitting ? 'Please wait...' : mode === 'signup' ? 'Create account' : 'Sign in' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
