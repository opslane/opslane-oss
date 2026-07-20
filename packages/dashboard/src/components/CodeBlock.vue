<script setup lang="ts">
import CopyButton from './CopyButton.vue';

defineProps<{
  code: string;
  language?: string;
}>();
</script>

<template>
  <div class="relative rounded-lg bg-surface-subtle text-text text-sm">
    <div class="absolute top-2 right-2">
      <CopyButton :text="code" />
    </div>
    <pre class="p-4 pr-20 overflow-x-auto"><code v-text="code"></code></pre>
  </div>
</template>
