<template>
  <!--
    text-accent-hover, not text-accent: over bg-accent/10 on bg-surface-subtle
    the base accent lands at 4.25:1, under the 4.5:1 AA floor for this size.
    The hover token reaches 5.9:1.
  -->
  <span
    data-testid="last-used-badge"
    class="ml-auto whitespace-nowrap rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent-hover"
  >Last used</span>
</template>
