<script setup lang="ts">
import { ref, onMounted, toRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Account, IncidentFilters } from '../types/api';
import { listAccounts } from '../api';
import { environmentFilterQuery, useEnvironmentFilter } from '../composables/useEnvironmentFilter';

const props = defineProps<{
  projectId: string;
}>();

const emit = defineEmits<{
  (e: 'filter-change', filters: IncidentFilters): void;
}>();

const route = useRoute();
const router = useRouter();
const accounts = ref<Account[]>([]);
const selectedAccountId = ref((route.query['account_id'] as string) || '');
const selectedStatus = ref((route.query['status'] as string) || '');
const {
  environments,
  rollupReady,
  selectedEnvironmentId,
} = useEnvironmentFilter(toRef(props, 'projectId'));

onMounted(async () => {
  try {
    accounts.value = await listAccounts(props.projectId);
  } catch {
    // Non-fatal: filter bar still works without account list
  }
  emitFilters();
});

function emitFilters() {
  const filters: IncidentFilters = {};
  if (selectedAccountId.value) filters.account_id = selectedAccountId.value;
  if (selectedStatus.value) filters.status = selectedStatus.value;
  if (rollupReady.value && selectedEnvironmentId.value) {
    filters.environment_id = selectedEnvironmentId.value;
  }
  emit('filter-change', filters);
}

function onFilterChange() {
  // Sync to URL query params
  const query = environmentFilterQuery(route.query, selectedEnvironmentId.value);
  if (selectedAccountId.value) {
    query['account_id'] = selectedAccountId.value;
  } else {
    delete query['account_id'];
  }
  if (selectedStatus.value) {
    query['status'] = selectedStatus.value;
  } else {
    delete query['status'];
  }
  router.replace({ query });
  emitFilters();
}

watch([selectedAccountId, selectedStatus, selectedEnvironmentId, rollupReady], onFilterChange);
</script>

<template>
  <div class="flex flex-wrap gap-3 items-center py-3">
    <div class="flex items-center gap-2">
      <label class="text-sm text-text-muted whitespace-nowrap">Account:</label>
      <select
        v-model="selectedAccountId"
        class="text-sm rounded-md px-2 py-1.5"
      >
        <option value="">All accounts</option>
        <option
          v-for="account in accounts"
          :key="account.external_account_id"
          :value="account.external_account_id"
          v-text="account.account_name || account.external_account_id"
        ></option>
      </select>
    </div>

    <div class="flex items-center gap-2">
      <label class="text-sm text-text-muted whitespace-nowrap">Status:</label>
      <select
        v-model="selectedStatus"
        class="text-sm rounded-md px-2 py-1.5"
      >
        <option value="">All statuses</option>
        <option value="new">New</option>
        <option value="queued">Queued</option>
        <option value="analyzing">Analyzing</option>
        <option value="pr_draft">Draft PR</option>
        <option value="pr_created">PR Created</option>
        <option value="merged">Merged</option>
        <option value="needs_human">Needs Human</option>
        <option value="resolved">Resolved</option>
        <option value="archived">Archived</option>
      </select>
    </div>

    <div v-if="rollupReady" class="flex items-center gap-2">
      <label class="text-sm text-text-muted whitespace-nowrap">Environment:</label>
      <select
        v-model="selectedEnvironmentId"
        aria-label="Environment"
        class="text-sm rounded-md px-2 py-1.5"
      >
        <option value="">All environments</option>
        <option
          v-for="environment in environments"
          :key="environment.id"
          :value="environment.id"
          v-text="environment.name"
        ></option>
      </select>
    </div>
  </div>
</template>
