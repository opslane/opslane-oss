<script setup lang="ts">
import { ref, onMounted } from 'vue';

const data = ref<string | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const retryResult = ref<string | null>(null);
const retryError = ref<string | null>(null);

const props = defineProps<{ loadFn: () => Promise<string> }>();

onMounted(async () => {
  try {
    data.value = await props.loadFn();
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

async function retryLoad() {
  try {
    const result = await Promise.any([
      new Promise<string>((resolve) => setTimeout(() => resolve('strategy-1-ok'), 50)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new RangeError('strategy-2-fail')), 100)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new URIError('strategy-3-fail')), 150)),
    ]);
    retryResult.value = result;
    retryError.value = null;
  } catch (err: unknown) {
    retryError.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div class="async-loader">
    <div v-if="loading" data-testid="loading">Loading...</div>
    <div v-else-if="error" data-testid="error">Error: {{ error }}</div>
    <div v-else data-testid="data">{{ data }}</div>
    <button data-testid="retry-btn" @click="retryLoad">Retry</button>
    <div v-if="retryResult" data-testid="retry-result">{{ retryResult }}</div>
    <div v-if="retryError" data-testid="retry-error">{{ retryError }}</div>
  </div>
</template>
