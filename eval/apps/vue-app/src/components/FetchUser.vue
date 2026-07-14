<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { User } from '../types';

const user = ref<User | null>(null);
const error = ref<string | null>(null);
const cachedContent = ref<string | null>(null);
const cachedError = ref<string | null>(null);

const props = defineProps<{ userId: string }>();

onMounted(async () => {
  try {
    const response = await fetch(`/api/users/${props.userId}`);
    if (!response.ok) {
      error.value = `HTTP ${response.status}`;
      return;
    }
    user.value = await response.json();
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});

async function loadCached() {
  try {
    const response = await fetch(`/api/users/${props.userId}`);
    // Clone the response before reading body — allows re-reading
    const cloned = response.clone();
    const _firstRead = await response.text();
    // Read from the clone (safe because it's a separate stream)
    const secondRead = await cloned.text();
    cachedContent.value = secondRead;
    cachedError.value = null;
  } catch (err: unknown) {
    cachedError.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div class="fetch-user">
    <div v-if="error" data-testid="error">{{ error }}</div>
    <div v-else-if="user" data-testid="user">{{ user.name }}</div>
    <div v-else data-testid="loading">Loading...</div>
    <button data-testid="load-cached-btn" @click="loadCached">Load Cached</button>
    <div v-if="cachedContent" data-testid="cached-content">{{ cachedContent }}</div>
    <div v-if="cachedError" data-testid="cached-error">{{ cachedError }}</div>
  </div>
</template>
