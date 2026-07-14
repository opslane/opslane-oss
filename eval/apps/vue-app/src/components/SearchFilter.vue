<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Item } from '../types';

const props = defineProps<{ items: Item[] }>();
const search = ref('');

const filtered = computed(() => {
  const term = search.value?.toLowerCase() ?? '';
  if (!term) return props.items;
  return props.items.filter(item =>
    item.label.toLowerCase().includes(term)
  );
});
</script>

<template>
  <div class="search-filter">
    <input v-model="search" data-testid="search-input" placeholder="Search..." />
    <ul>
      <li v-for="item in filtered" :key="item.id" :data-testid="`filtered-${item.id}`">
        {{ item.label }}
      </li>
    </ul>
    <p v-if="filtered.length === 0" data-testid="no-results">No results</p>
  </div>
</template>
