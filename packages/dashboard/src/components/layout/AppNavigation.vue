<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { APP_NAVIGATION, isNavigationItemActive, type AppNavigationItem } from './navigation';

const props = defineProps<{
  showAdmin: boolean;
}>();

const emit = defineEmits<{
  navigate: [];
}>();

const route = useRoute();
const visibleNavigation = computed(() => APP_NAVIGATION.filter((item) => !item.adminOnly || props.showAdmin));

function linkClass(item: AppNavigationItem): string {
  return isNavigationItemActive(item, route.name)
    ? 'border-accent text-accent'
    : 'border-transparent text-muted hover:border-border-strong hover:bg-surface-subtle hover:text-text';
}
</script>

<template>
  <nav aria-label="Primary navigation" class="app-navigation">
    <p class="mb-2 px-4 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-faint">
      Workspace
    </p>
    <ul class="space-y-1">
      <li v-for="(item, index) in visibleNavigation" :key="item.routeName">
        <router-link
          :to="{ name: item.routeName }"
          :aria-current="isNavigationItemActive(item, route.name) ? 'page' : undefined"
          class="flex min-h-11 items-center gap-3 border-l-2 px-4 py-2 text-sm transition-colors duration-150 motion-reduce:transition-none"
          :class="linkClass(item)"
          @click="emit('navigate')"
        >
          <span aria-hidden="true" class="w-5 font-mono text-[0.6875rem] text-faint">
            {{ String(index + 1).padStart(2, '0') }}
          </span>
          <span>{{ item.label }}</span>
        </router-link>
      </li>
    </ul>
  </nav>
</template>
