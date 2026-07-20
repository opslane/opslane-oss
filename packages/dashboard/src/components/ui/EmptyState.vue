<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="border-y border-border py-12 text-center">
    <div v-if="$slots.icon" aria-hidden="true" class="mx-auto mb-3 flex size-10 items-center justify-center text-faint"><slot name="icon"></slot></div>
    <h2 class="text-base font-semibold text-text">{{ title }}</h2>
    <p v-if="description" class="mx-auto mt-1 max-w-prose text-sm text-muted">{{ description }}</p>
    <div v-if="$slots.default" class="mt-5"><slot></slot></div>
  </div>
</template>
