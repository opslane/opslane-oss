<script setup lang="ts">
import { ref } from 'vue';
import type { User } from '../types';

const props = defineProps<{ user: User }>();

const exportResult = ref<string | null>(null);
const exportError = ref<string | null>(null);

function exportUserData() {
  try {
    const payload = {
      name: props.user.profile?.name ?? 'Unknown',
      email: props.user.profile?.email ?? '',
      exportedAt: new Date().toISOString(),
    };
    exportResult.value = JSON.stringify(payload);
    exportError.value = null;
  } catch (err: unknown) {
    exportError.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div class="user-card">
    <h2>{{ user.profile?.name ?? 'No profile' }}</h2>
    <p>{{ user.profile?.email ?? '' }}</p>
    <button data-testid="export-btn" @click="exportUserData">Export</button>
    <p v-if="exportResult" data-testid="export-result">{{ exportResult }}</p>
    <p v-if="exportError" data-testid="export-error">{{ exportError }}</p>
  </div>
</template>
