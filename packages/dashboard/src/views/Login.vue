<script setup lang="ts">
function signIn(): void {
  window.location.href = '/auth/login';
}
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center">
    <div class="max-w-sm w-full bg-surface rounded-lg border border-border p-8 text-center">
      <div class="mx-auto mb-6 h-10 w-10 rounded-lg bg-teal/10 flex items-center justify-center">
        <svg class="h-5 w-5 text-teal" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
        </svg>
      </div>
      <h1 class="text-xl font-semibold text-text mb-1">Sign in to Opslane</h1>
      <p class="text-sm text-text-muted mb-8">
        Continue with your configured identity provider.
      </p>

      <button
        @click="signIn"
        class="w-full flex items-center justify-center gap-3 rounded-md bg-surface-2 border border-border px-4 py-3 text-sm font-medium text-text hover:bg-border focus:outline-none focus:ring-2 focus:ring-teal focus:ring-offset-2 focus:ring-offset-background transition-colors"
      >
        <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M10 0C4.477 0 0 4.477 0 10c0 4.42 2.865 8.166 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C17.137 18.163 20 14.418 20 10c0-5.523-4.477-10-10-10z" clip-rule="evenodd" />
        </svg>
        Continue to sign in
      </button>
    </div>
  </div>
</template>
