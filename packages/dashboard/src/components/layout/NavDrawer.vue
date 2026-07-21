<script setup lang="ts">
import ModalSurface from '../ui/ModalSurface.vue';
import AppNavigation from './AppNavigation.vue';

defineProps<{
  open: boolean;
  projectName: string;
  showAdmin: boolean;
  userEmail?: string;
  /** True while a session hint exists, even if getMe() failed and userEmail is empty. */
  signedIn?: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  signOut: [];
}>();

function close(): void {
  emit('update:open', false);
}

function signOut(): void {
  close();
  emit('signOut');
}
</script>

<template>
  <ModalSurface
    :open="open"
    title="Navigation"
    description="Switch workspace or move to another area of Opslane."
    variant="drawer"
    @update:open="emit('update:open', $event)"
  >
    <div class="nav-drawer flex min-h-full flex-col">
      <section class="border-b border-border px-5 py-5" aria-labelledby="mobile-workspace-label">
        <p
          id="mobile-workspace-label"
          class="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-faint"
        >
          Active project
        </p>
        <p v-if="projectName" class="mt-1 truncate text-sm font-medium text-text" :title="projectName">
          {{ projectName }}
        </p>
        <div class="mt-3 min-w-0 space-y-2 [&_select]:max-w-full [&>div]:min-w-0">
          <slot name="workspace" />
        </div>
      </section>

      <AppNavigation :show-admin="showAdmin" class="min-h-0 flex-1 overflow-y-auto py-5" @navigate="close" />

      <div v-if="signedIn || userEmail" class="border-t border-border px-5 py-4">
        <p v-if="userEmail" class="truncate text-xs text-muted" :title="userEmail">{{ userEmail }}</p>
        <button
          type="button"
          class="mt-2 min-h-11 text-sm font-medium text-muted transition-colors duration-150 hover:text-text motion-reduce:transition-none"
          @click="signOut"
        >
          Sign out
        </button>
      </div>
    </div>
  </ModalSurface>
</template>
