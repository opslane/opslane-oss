<script setup lang="ts">
import { ref } from 'vue';

const config = ref<string | null>(null);
const syncStatus = ref<string | null>(null);

function loadConfig() {
  config.value = 'Config loaded: region=us-east-1, tier=pro';
}

async function startSync() {
  syncStatus.value = 'Syncing...';
  // BUG: simulates an async operation that rejects after a brief delay
  await new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Sync failed: connection reset by peer')), 100);
  });
  syncStatus.value = 'Done';
}
</script>

<template>
  <div data-testid="async-loader">
    <button data-testid="load-config-btn" @click="loadConfig">Step 1: Load Config</button>
    <p v-if="config" data-testid="config-text">{{ config }}</p>
    <button data-testid="start-sync-btn" @click="startSync">Step 2: Start Sync</button>
    <p v-if="syncStatus" data-testid="sync-status">{{ syncStatus }}</p>
  </div>
</template>
