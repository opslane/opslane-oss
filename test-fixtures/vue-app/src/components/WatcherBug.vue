<script setup lang="ts">
import { ref, watch } from 'vue';

const counter = ref(0);

watch(counter, (newVal) => {
  // BUG: throws when counter reaches 3
  if (newVal >= 3) {
    throw new Error(`Watcher validation failed: counter ${newVal} exceeded max limit of 2`);
  }
});

function increment() {
  counter.value++;
}
</script>

<template>
  <div data-testid="watcher-bug">
    <p>Counter: {{ counter }}</p>
    <button data-testid="increment-btn" @click="increment">Increment</button>
  </div>
</template>
