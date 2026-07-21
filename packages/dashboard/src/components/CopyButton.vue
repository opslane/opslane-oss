<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  text: string;
}>();

const copied = ref(false);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    // Fallback: ignore silently
  }
}
</script>

<template>
  <button
    type="button"
    @click="copy"
    class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors"
    :class="copied
      ? 'bg-success/10 text-success'
      : 'bg-surface-subtle text-muted hover:bg-border'"
  >
    {{ copied ? 'Copied!' : 'Copy' }}
  </button>
</template>
