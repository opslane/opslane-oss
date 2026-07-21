<script setup lang="ts">
import { computed, useAttrs, useId } from 'vue';

export interface SelectOption { value: string; label: string; disabled?: boolean }

// See TextInput: fallthrough attrs belong on the control, not the wrapper label.
defineOptions({ inheritAttrs: false });
// class/style stay on the wrapping <label> (callers style the field as a unit);
// everything else (name, autofocus, maxlength, min/max, ...) goes to the control.
const controlAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = useAttrs();
  return rest;
});

const props = withDefaults(defineProps<{
  modelValue?: string;
  label: string;
  options: SelectOption[];
  id?: string;
  /** Visually hide the label but keep it for assistive tech. */
  labelHidden?: boolean;
  hint?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}>(), {
  modelValue: '', id: undefined, labelHidden: false, hint: undefined, error: undefined, disabled: false, required: false,
});
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const generatedId = useId();
const inputId = computed(() => props.id ?? generatedId);
const descriptionId = computed(() => props.error || props.hint ? `${inputId.value}-description` : undefined);
</script>

<template>
  <label class="grid gap-1.5 text-sm text-text" :class="$attrs.class as string" :for="inputId">
    <span :class="labelHidden ? 'sr-only' : 'font-medium'">{{ label }}<span v-if="required" aria-hidden="true" class="text-danger"> *</span></span>
    <select
      v-bind="controlAttrs"
      :id="inputId" :value="modelValue" :disabled="disabled" :required="required"
      :aria-invalid="error ? 'true' : undefined" :aria-describedby="descriptionId"
      class="min-h-10 max-md:min-h-11 rounded-md border bg-surface px-3 py-2 pr-9 text-text disabled:cursor-not-allowed disabled:opacity-60"
      :class="error ? 'border-danger' : 'border-border-strong'"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option>
    </select>
    <span v-if="error || hint" :id="descriptionId" class="text-xs" :class="error ? 'text-danger' : 'text-muted'">{{ error ?? hint }}</span>
  </label>
</template>
