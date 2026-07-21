<script setup lang="ts">
import type { Component } from 'vue';

import type { SocialButton } from '../composables/socialProviders';
import type { LastAuthMethod } from '../composables/useLastAuthMethod';
import type { SocialProviderId } from '../types/api';
import GitHubIcon from './icons/GitHubIcon.vue';
import GoogleIcon from './icons/GoogleIcon.vue';
import LastUsedBadge from './LastUsedBadge.vue';

defineProps<{
  buttons: SocialButton[];
  dividerLabel: string;
  lastUsed?: LastAuthMethod | null;
}>();

defineEmits<{ select: [id: SocialProviderId] }>();

// Adding a provider is intentionally a compile error until its brand icon is
// supplied here.
const ICONS: Record<SocialProviderId, Component> = {
  google: GoogleIcon,
  github: GitHubIcon,
};
</script>

<template>
  <div v-if="buttons.length" class="mb-6 space-y-2">
    <a
      v-for="button in buttons"
      :key="button.id"
      :href="button.href"
      class="w-full flex items-center gap-3 rounded-md bg-surface-subtle border border-border px-4 py-3 text-sm font-medium text-text hover:bg-border focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background transition-colors"
      @click="$emit('select', button.id)"
    >
      <component :is="ICONS[button.id]" />
      <span class="min-w-0 truncate">{{ button.label }}</span>
      <LastUsedBadge v-if="button.id === lastUsed" />
    </a>
    <div class="flex items-center gap-3 pt-2 text-xs text-muted">
      <span class="h-px flex-1 bg-border"></span>
      {{ dividerLabel }}
      <span class="h-px flex-1 bg-border"></span>
    </div>
  </div>
</template>
