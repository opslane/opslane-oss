<script setup lang="ts">
import AppNavigation from './AppNavigation.vue';

defineProps<{
  projectName: string;
  showAdmin: boolean;
  userEmail?: string;
  /** True while a session hint exists, even if getMe() failed and userEmail is empty. */
  signedIn?: boolean;
}>();

const emit = defineEmits<{
  signOut: [];
}>();
</script>

<template>
  <aside
    class="app-rail fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-border bg-surface md:flex"
    aria-label="Application rail"
  >
    <div class="border-b border-border px-5 py-5">
      <router-link
        :to="{ name: 'activity' }"
        class="inline-flex min-h-10 items-center text-text transition-colors duration-150 hover:text-accent motion-reduce:transition-none"
      >
        <span class="font-mono text-sm font-semibold uppercase tracking-[0.18em]">Opslane</span>
      </router-link>
      <p class="mt-1 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-faint">
        Incident ledger
      </p>
    </div>

    <div class="border-b border-border px-4 py-4">
      <p class="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-faint">
        Active project
      </p>
      <p v-if="projectName" class="mt-1 truncate text-sm font-medium text-text" :title="projectName">
        {{ projectName }}
      </p>
      <div class="mt-3 min-w-0 space-y-2 [&_select]:max-w-full [&>div]:min-w-0">
        <slot name="workspace" />
      </div>
    </div>

    <AppNavigation :show-admin="showAdmin" class="min-h-0 flex-1 overflow-y-auto py-5" />

    <div v-if="signedIn || userEmail" class="border-t border-border px-5 py-4">
      <p v-if="userEmail" class="truncate text-xs text-muted" :title="userEmail">{{ userEmail }}</p>
      <button
        type="button"
        class="mt-2 min-h-10 text-sm font-medium text-muted transition-colors duration-150 hover:text-text motion-reduce:transition-none"
        @click="emit('signOut')"
      >
        Sign out
      </button>
    </div>
  </aside>
</template>
