<script setup lang="ts">
import { computed, useAttrs, useId } from 'vue';

// Fallthrough attrs must reach the <input>, not the wrapping <label>: call sites
// pass name, autofocus, maxlength, min/max, and similar, and silently binding
// those to the label would drop them.
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
  id?: string;
  /** Visually hide the label but keep it for assistive tech. */
  labelHidden?: boolean;
  type?: 'text' | 'email' | 'password' | 'url' | 'search' | 'datetime-local' | 'number' | 'tel';
  placeholder?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  autocomplete?: string;
}>(), {
  modelValue: '',
  id: undefined,
  labelHidden: false,
  type: 'text',
  placeholder: undefined,
  hint: undefined,
  error: undefined,
  disabled: false,
  required: false,
  autocomplete: undefined,
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const generatedId = useId();
const inputId = computed(() => props.id ?? generatedId);
const descriptionId = computed(() => props.error || props.hint ? `${inputId.value}-description` : undefined);
</script>

<template>
  <label class="grid gap-1.5 text-sm text-text" :class="$attrs.class as string" :for="inputId">
    <span :class="labelHidden ? 'sr-only' : 'font-medium'">{{ label }}<span v-if="required" aria-hidden="true" class="text-danger"> *</span></span>
    <input
      v-bind="controlAttrs"
      :id="inputId"
      :value="modelValue"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      :autocomplete="autocomplete"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="descriptionId"
      class="min-h-10 max-md:min-h-11 rounded-md border bg-surface px-3 py-2 text-text placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
      :class="error ? 'border-danger' : 'border-border-strong'"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <span v-if="error || hint" :id="descriptionId" class="text-xs" :class="error ? 'text-danger' : 'text-muted'">{{ error ?? hint }}</span>
  </label>
</template>
