<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  title?: string;
  tone?: 'info' | 'success' | 'warning' | 'danger';
}>(), { title: undefined, tone: 'info' });

const classes = computed(() => ({
  info: 'border-progress/30 bg-progress-subtle text-progress',
  success: 'border-success/30 bg-success-subtle text-success',
  warning: 'border-warning/30 bg-warning-subtle text-warning',
  danger: 'border-danger/30 bg-danger-subtle text-danger',
}[props.tone]));
</script>

<template>
  <div :role="tone === 'danger' ? 'alert' : 'status'" class="rounded-md border px-4 py-3 text-sm" :class="classes">
    <p v-if="title" class="font-semibold">{{ title }}</p>
    <div :class="title ? 'mt-1' : ''"><slot></slot></div>
  </div>
</template>
