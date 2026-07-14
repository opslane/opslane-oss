<script setup lang="ts">
import { ref } from 'vue';
import type { Item } from '../types';

const props = defineProps<{ initialItems: Item[] }>();
const items = ref<Item[]>([...props.initialItems]);

function addItem(item: Item) {
  items.value = [...items.value, item];
}

function removeItem(id: string) {
  items.value = items.value.filter(i => i.id !== id);
}

defineExpose({ addItem, removeItem });
</script>

<template>
  <ul class="item-list">
    <li v-for="item in items" :key="item.id" :data-testid="`item-${item.id}`">
      {{ item.label }}
      <span v-if="item.active" data-testid="active-badge">active</span>
    </li>
  </ul>
  <p v-if="items.length === 0" data-testid="empty">No items</p>
</template>
