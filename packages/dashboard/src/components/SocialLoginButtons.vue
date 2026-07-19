<script setup lang="ts">
import type { SocialButton } from '../composables/socialProviders';

defineProps<{
  buttons: SocialButton[];
  dividerLabel: string;
}>();
</script>

<template>
  <div v-if="buttons.length" class="mb-6 space-y-2">
    <a
      v-for="button in buttons"
      :key="button.id"
      :href="button.href"
      class="w-full flex items-center justify-center gap-3 rounded-md bg-surface-2 border border-border px-4 py-3 text-sm font-medium text-text hover:bg-border focus:outline-none focus:ring-2 focus:ring-teal focus:ring-offset-2 focus:ring-offset-background transition-colors"
    >
      {{ button.label }}
    </a>
    <div class="flex items-center gap-3 pt-2 text-xs text-text-muted">
      <span class="h-px flex-1 bg-border"></span>
      {{ dividerLabel }}
      <span class="h-px flex-1 bg-border"></span>
    </div>
  </div>
</template>
