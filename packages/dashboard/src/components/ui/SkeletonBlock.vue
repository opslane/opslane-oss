<script setup lang="ts">
// Purely decorative. Each skeleton used to be its own role="status", so a
// three-placeholder loading block announced "Loading" three times. The
// announcement belongs to the loading region as a whole: wrap the group in a
// container with role="status" (or aria-busy) and one label.
defineProps<{ class?: string }>();
</script>

<template>
  <div aria-hidden="true" class="overflow-hidden rounded-sm bg-surface-subtle" :class="$props.class"></div>
</template>
