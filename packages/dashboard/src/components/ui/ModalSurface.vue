<script setup lang="ts">
import { inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { routeLocationKey } from 'vue-router';
import IconButton from './IconButton.vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description?: string;
  initialFocus?: string;
  closeOnOverlay?: boolean;
  variant?: 'dialog' | 'drawer';
}>(), {
  description: undefined,
  initialFocus: undefined,
  closeOnOverlay: true,
  variant: 'dialog',
});

const emit = defineEmits<{ 'update:open': [value: boolean]; close: [] }>();
const panel = ref<HTMLElement | null>(null);
const route = inject(routeLocationKey, null);
let restoreFocus: HTMLElement | null = null;
let previousOverflow = '';
let appWasInert = false;
let appAriaHidden: string | null = null;

const focusableSelector = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function close(): void {
  emit('update:open', false);
  emit('close');
}

function activate(): void {
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const app = document.querySelector<HTMLElement>('#app');
  if (app) {
    appWasInert = app.hasAttribute('inert');
    appAriaHidden = app.getAttribute('aria-hidden');
    app.setAttribute('inert', '');
    app.setAttribute('aria-hidden', 'true');
  }
  void nextTick(() => {
    const requested = props.initialFocus ? panel.value?.querySelector<HTMLElement>(props.initialFocus) : null;
    (requested ?? panel.value?.querySelector<HTMLElement>(focusableSelector) ?? panel.value)?.focus();
  });
}

function deactivate(): void {
  document.body.style.overflow = previousOverflow;
  const app = document.querySelector<HTMLElement>('#app');
  if (app) {
    if (!appWasInert) app.removeAttribute('inert');
    if (appAriaHidden === null) app.removeAttribute('aria-hidden');
    else app.setAttribute('aria-hidden', appAriaHidden);
  }
  restoreFocus?.focus();
  restoreFocus = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab' || !panel.value) return;
  const focusable = [...panel.value.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
  if (focusable.length === 0) {
    event.preventDefault();
    panel.value.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

watch(() => props.open, (open) => open ? activate() : deactivate(), { immediate: true, flush: 'post' });
watch(() => route?.fullPath, (current, previous) => {
  if (props.open && previous !== undefined && current !== previous) close();
});
onBeforeUnmount(() => { if (props.open) deactivate(); });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex bg-evidence/55"
      :class="variant === 'drawer' ? 'justify-end' : 'items-center justify-center p-4'"
      @mousedown.self="closeOnOverlay && close()"
    >
      <section
        ref="panel" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1"
        class="flex bg-surface text-text shadow-xl outline-none"
        :class="variant === 'drawer' ? 'h-full w-full max-w-80 flex-col border-l border-border' : 'max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col rounded-lg border border-border'"
        @keydown="onKeydown"
      >
        <header class="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <slot name="header"><h2 class="text-lg font-semibold">{{ title }}</h2></slot>
            <p v-if="description" class="mt-1 text-sm text-muted">{{ description }}</p>
          </div>
          <IconButton label="Close" @click="close">×</IconButton>
        </header>
        <div :class="variant === 'drawer' ? 'min-h-0 flex-1 overflow-hidden p-0' : 'min-h-0 flex-1 overflow-y-auto px-5 py-4'"><slot></slot></div>
        <footer v-if="$slots.footer" class="border-t border-border px-5 py-4"><slot name="footer"></slot></footer>
      </section>
    </div>
  </Teleport>
</template>
