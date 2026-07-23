<script setup lang="ts">
import { ref } from 'vue';
import { switchOrg } from '../api';
import type { AuthMembership } from '../types/api';
import { shouldSwitchOrg } from './org-switcher';

const props = defineProps<{
  memberships: AuthMembership[];
  activeOrgId: string;
}>();

const selected = ref(props.activeOrgId);
const switching = ref(false);
const error = ref('');

async function handleSwitch(): Promise<void> {
  if (!shouldSwitchOrg(selected.value, props.activeOrgId, switching.value)) return;
  switching.value = true;
  error.value = '';
  try {
    await switchOrg(selected.value);
    window.location.reload();
  } catch (err: unknown) {
    selected.value = props.activeOrgId;
    error.value = err instanceof Error ? err.message : 'Unable to switch organization';
  } finally {
    switching.value = false;
  }
}
</script>

<template>
  <div v-if="memberships.length > 1" class="flex items-center gap-2">
    <label for="org-switcher" class="sr-only">Organization</label>
    <select
      id="org-switcher"
      v-model="selected"
      :disabled="switching"
      class="rounded-md border border-border bg-surface-subtle pl-2 pr-8 py-1 text-sm text-text"
      @change="handleSwitch"
    >
      <option
        v-for="membership in memberships"
        :key="membership.org_id"
        :value="membership.org_id"
        v-text="membership.name"
      ></option>
    </select>
    <span v-if="error" class="text-xs text-danger" v-text="error"></span>
  </div>
</template>
