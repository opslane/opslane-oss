<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { resetPassword } from '../api';

const route = useRoute();

function queryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

const token = queryValue(route.query.token);
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const submitting = ref(false);
const complete = ref(false);

onMounted(() => {
  if (token) {
    window.history.replaceState(window.history.state, '', route.path);
  }
});

async function submit(): Promise<void> {
  error.value = '';
  if (!token) {
    error.value = 'This reset link is incomplete or expired. Request a new one from the sign-in page.';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Passwords do not match.';
    return;
  }

  submitting.value = true;
  try {
    const result = await resetPassword(token, newPassword.value);
    if (result.status === 'reset') {
      complete.value = true;
      newPassword.value = '';
      confirmPassword.value = '';
    } else {
      error.value = `${result.message} Request a new reset link if this link has expired.`;
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center px-4 py-8">
    <div class="max-w-sm w-full bg-surface rounded-lg border border-border p-8">
      <div class="mx-auto mb-6 h-10 w-10 rounded-lg bg-teal/10 flex items-center justify-center">
        <svg class="h-5 w-5 text-teal" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 00-9 0v3.75m-.75 10.5h10.5A2.25 2.25 0 0019.5 18.75v-6A2.25 2.25 0 0017.25 10.5H6.75A2.25 2.25 0 004.5 12.75v6A2.25 2.25 0 006.75 21z" />
        </svg>
      </div>

      <div v-if="complete" class="text-center">
        <h1 class="text-xl font-semibold text-text mb-2">Password updated</h1>
        <p class="text-sm text-text-muted mb-6">Your password has been changed. You can now sign in.</p>
        <router-link to="/login" class="text-sm font-medium text-teal hover:underline">
          Return to sign in
        </router-link>
      </div>

      <div v-else>
        <h1 class="text-xl font-semibold text-text text-center mb-1">Choose a new password</h1>
        <p class="text-sm text-text-muted text-center mb-6">Enter and confirm your new password.</p>
        <form class="space-y-4" @submit.prevent="submit">
          <div>
            <label for="new-password" class="block text-sm font-medium text-text mb-1.5">New password</label>
            <input
              id="new-password"
              v-model="newPassword"
              type="password"
              autocomplete="new-password"
              required
              autofocus
              class="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-text focus:border-teal focus:outline-none focus:ring-1 focus:ring-teal"
            />
          </div>
          <div>
            <label for="confirm-password" class="block text-sm font-medium text-text mb-1.5">Confirm password</label>
            <input
              id="confirm-password"
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              required
              class="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-text focus:border-teal focus:outline-none focus:ring-1 focus:ring-teal"
            />
          </div>
          <p v-if="error" class="text-sm text-red" role="alert" v-text="error"></p>
          <button
            type="submit"
            :disabled="submitting"
            class="w-full rounded-md bg-teal px-4 py-3 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ submitting ? 'Updating...' : 'Update password' }}
          </button>
        </form>
        <router-link to="/login" class="mt-5 block text-center text-sm text-teal hover:underline">
          Back to sign in
        </router-link>
      </div>
    </div>
  </div>
</template>
