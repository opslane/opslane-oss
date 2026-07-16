<script setup lang="ts">
// Intentionally inert: no handlers, no reactive state. Clicking must cause
// zero DOM mutations or the friction analyzer treats the click as "answered".
</script>

<template>
  <div>
    <p>This button does nothing.</p>
    <button data-testid="dead-button" type="button">Save changes</button>
  </div>
</template>
