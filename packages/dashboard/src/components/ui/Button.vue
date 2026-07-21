<script setup lang="ts">
import { computed } from 'vue';

// `danger` is the solid, high-emphasis destructive action. `dangerSubtle` is the
// tinted, de-emphasized one used where the destructive path is available but
// should not compete with the primary action (e.g. "Disconnect repo").
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerSubtle' | 'ghost';
type ButtonSize = 'sm' | 'md';

const props = withDefaults(defineProps<{
  type?: 'button' | 'submit' | 'reset';
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  busy?: boolean;
}>(), {
  type: 'button',
  variant: 'secondary',
  size: 'md',
  disabled: false,
  busy: false,
});

const emit = defineEmits<{ click: [event: MouseEvent] }>();

const classes = computed(() => [
  'inline-flex min-h-10 max-md:min-h-11 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  'disabled:cursor-not-allowed disabled:opacity-50',
  props.size === 'sm' ? 'px-3 py-1.5' : 'px-4 py-2',
  {
    primary: 'border-accent bg-accent text-on-accent hover:bg-accent-hover',
    secondary: 'border-border-strong bg-surface text-text hover:bg-surface-subtle',
    danger: 'border-danger bg-danger text-white hover:brightness-90',
    dangerSubtle: 'border-transparent bg-danger/10 text-danger hover:bg-danger/20',
    ghost: 'border-transparent bg-transparent text-muted hover:bg-surface-subtle hover:text-text',
  }[props.variant],
]);
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled || busy"
    :aria-busy="busy || undefined"
    @click="emit('click', $event)"
  >
    <span v-if="busy" aria-hidden="true" class="size-3.5 rounded-full border-2 border-current border-r-transparent"></span>
    <slot></slot>
  </button>
</template>
