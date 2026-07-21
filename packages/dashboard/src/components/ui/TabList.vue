<script setup lang="ts">
import { nextTick, ref } from 'vue';

export interface TabOption { id: string; label: string; disabled?: boolean }

const props = withDefaults(defineProps<{
  modelValue: string;
  tabs: TabOption[];
  label: string;
  /**
   * Prefix for the generated tab/panel ids. Each panel must render with
   * id="{idPrefix}-{tabId}-panel" and aria-labelledby="{idPrefix}-{tabId}-tab",
   * otherwise aria-controls points at nothing and the tabs pattern is only
   * half-implemented.
   */
  idPrefix?: string;
}>(), { idPrefix: 'tab' });

function tabId(id: string): string {
  return `${props.idPrefix}-${id}-tab`;
}
function panelId(id: string): string {
  return `${props.idPrefix}-${id}-panel`;
}
defineExpose({ tabId, panelId });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const tablist = ref<HTMLElement | null>(null);

function select(id: string): void {
  if (!props.tabs.find((tab) => tab.id === id)?.disabled) emit('update:modelValue', id);
}

function onKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const enabled = props.tabs.filter((tab) => !tab.disabled);
  const current = Math.max(0, enabled.findIndex((tab) => tab.id === props.modelValue));
  const target = event.key === 'Home' ? enabled[0]
    : event.key === 'End' ? enabled[enabled.length - 1]
      : enabled[(current + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
  if (!target) return;
  event.preventDefault();
  select(target.id);
  void nextTick(() => tablist.value?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(target.id)}"]`)?.focus());
}
</script>

<template>
  <div ref="tablist" role="tablist" :aria-label="label" class="flex max-w-full gap-1 overflow-x-auto border-b border-border" @keydown="onKeydown">
    <button
      v-for="tab in tabs" :key="tab.id" type="button" role="tab" :data-tab-id="tab.id"
      :id="tabId(tab.id)" :aria-controls="panelId(tab.id)"
      :aria-selected="tab.id === modelValue" :tabindex="tab.id === modelValue ? 0 : -1" :disabled="tab.disabled"
      class="min-h-10 max-md:min-h-11 border-b-2 px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50"
      :class="tab.id === modelValue ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'"
      @click="select(tab.id)"
    >{{ tab.label }}</button>
  </div>
</template>
