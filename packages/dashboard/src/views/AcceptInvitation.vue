<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { acceptInvitation } from '../api';

const route = useRoute();
const router = useRouter();
const status = ref<'working' | 'success' | 'error'>('working');
const message = ref('Accepting invitation…');

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : '';
  if (!token) {
    status.value = 'error';
    message.value = 'This invitation link is missing its token.';
    return;
  }
  try {
    await acceptInvitation(token);
    status.value = 'success';
    message.value = 'Invitation accepted. You can now switch to the organization.';
    sessionStorage.removeItem('opslane_post_auth_path');
  } catch (err: unknown) {
    status.value = 'error';
    message.value = err instanceof Error ? err.message : 'Unable to accept invitation.';
  }
});
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center px-6">
    <div class="max-w-md w-full rounded-lg border border-border bg-surface p-8 text-center">
      <h1 class="text-lg font-medium text-text">Organization invitation</h1>
      <p class="mt-3 text-sm" :class="status === 'error' ? 'text-red' : 'text-text-muted'" v-text="message"></p>
      <button v-if="status === 'success'" class="btn-primary mt-6" @click="router.push('/')">Continue</button>
      <router-link v-if="status === 'error'" to="/" class="mt-6 inline-block text-sm text-teal hover:underline">Back to Opslane</router-link>
    </div>
  </div>
</template>
