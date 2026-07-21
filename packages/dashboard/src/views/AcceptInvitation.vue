<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { acceptInvitation } from '../api';
import Button from '../components/ui/Button.vue';

const route = useRoute();
const router = useRouter();
const status = ref<'working' | 'success' | 'error'>('working');
const message = ref('Accepting invitation…');

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : '';
  // Drop the single-use token from the address bar and history entry before
  // any await, matching ResetPassword.vue. router.ts stashes `to.fullPath` in
  // sessionStorage for the post-auth redirect, so the token can otherwise
  // outlive this page in two places.
  window.history.replaceState(window.history.state, '', route.path);
  if (!token) {
    status.value = 'error';
    message.value = 'This invitation link is missing its token.';
    return;
  }
  try {
    await acceptInvitation(token);
    status.value = 'success';
    message.value = 'Invitation accepted. You can now switch to the organization.';
  } catch (err: unknown) {
    status.value = 'error';
    message.value = err instanceof Error ? err.message : 'Unable to accept invitation.';
  } finally {
    // Runs on the failure path too — a rejected accept must not leave the
    // token sitting in sessionStorage.
    sessionStorage.removeItem('opslane_post_auth_path');
  }
});
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center px-6">
    <div class="max-w-md w-full rounded-lg border border-border bg-surface p-8 text-center">
      <h1 class="text-lg font-medium text-text">Organization invitation</h1>
      <p class="mt-3 text-sm" :class="status === 'error' ? 'text-danger' : 'text-muted'" v-text="message"></p>
      <Button variant="primary" class="mt-6" v-if="status === 'success'" @click="router.push('/')">Continue</Button>
      <router-link v-if="status === 'error'" to="/" class="mt-6 inline-block text-sm text-accent hover:underline">Back to Opslane</router-link>
    </div>
  </div>
</template>
