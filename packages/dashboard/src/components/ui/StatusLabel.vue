<script setup lang="ts">
import { computed } from 'vue';

export type StatusTone = 'neutral' | 'danger' | 'success' | 'warning' | 'progress' | 'insight';

const props = withDefaults(defineProps<{
  tone?: StatusTone;
  label?: string;
}>(), {
  tone: 'neutral',
  label: undefined,
});

const toneClass = computed(() => ({
  neutral: 'border-border-strong bg-surface-subtle text-muted',
  danger: 'border-danger/30 bg-danger-subtle text-danger',
  success: 'border-success/30 bg-success-subtle text-success',
  warning: 'border-warning/30 bg-warning-subtle text-warning',
  progress: 'border-progress/30 bg-progress-subtle text-progress',
  insight: 'border-insight/30 bg-insight-subtle text-insight',
}[props.tone]));

const signal = computed(() => ({
  neutral: '–',
  danger: '!',
  success: '✓',
  warning: '!',
  progress: '→',
  insight: '◆',
}[props.tone]));
</script>

<template>
  <span class="inline-flex min-h-6 items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-semibold leading-none" :class="toneClass">
    <span aria-hidden="true" class="font-mono">{{ signal }}</span>
    <span><slot>{{ label }}</slot></span>
  </span>
</template>
