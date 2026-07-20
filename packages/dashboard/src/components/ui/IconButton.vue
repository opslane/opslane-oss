<script setup lang="ts">
withDefaults(defineProps<{
  label: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  variant?: 'default' | 'danger';
}>(), {
  type: 'button',
  disabled: false,
  variant: 'default',
});

const emit = defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <button
    :type="type"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
    class="inline-flex size-10 max-md:size-11 shrink-0 items-center justify-center rounded-md border bg-surface transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
    :class="variant === 'danger' ? 'border-danger/40 text-danger hover:bg-danger-subtle' : 'border-border text-muted hover:bg-surface-subtle hover:text-text'"
    @click="emit('click', $event)"
  >
    <slot></slot>
  </button>
</template>
