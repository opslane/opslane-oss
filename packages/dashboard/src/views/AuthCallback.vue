<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { completePostAuth } from '../post-auth';

const router = useRouter();
const error = ref('');

onMounted(async () => {
  try {
    await completePostAuth(router);
  } catch {
    error.value = 'Authentication failed — please try signing in again.';
  }
});
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center">
    <div class="max-w-sm w-full bg-surface rounded-lg border border-border p-8 text-center">
      <div v-if="error">
        <p class="text-red text-sm mb-4" v-text="error"></p>
        <router-link
          to="/login"
          class="text-sm text-teal hover:underline"
        >
          Back to sign in
        </router-link>
      </div>
      <div v-else>
        <div class="animate-spin h-8 w-8 border-2 border-teal border-t-transparent rounded-full mx-auto mb-4"></div>
        <p class="text-sm text-text-muted">Completing sign in...</p>
      </div>
    </div>
  </div>
</template>
