<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { Account } from '../types/api';
import { listAccounts } from '../api';
import { getProjectId, formatDate } from '../utils';
import { useTableSort } from '../composables/useTableSort';

const accounts = ref<Account[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const projectId = ref('');
const searchQuery = ref('');
let searchTimeout: ReturnType<typeof setTimeout> | null = null;

type SortKey = 'name' | 'users' | 'incidents' | 'last_seen';

const { sorted: sortedAccounts, toggleSort, sortIndicator } = useTableSort<SortKey, Account>(
  accounts,
  'last_seen',
  {
    name: (a, b) => (a.account_name ?? a.external_account_id).localeCompare(b.account_name ?? b.external_account_id),
    users: (a, b) => a.user_count - b.user_count,
    incidents: (a, b) => a.incident_count - b.incident_count,
    last_seen: (a, b) => new Date(a.last_seen).getTime() - new Date(b.last_seen).getTime(),
  },
  (key) => key === 'name' ? 'asc' : 'desc',
);

async function fetchAccounts(query?: string) {
  loading.value = true;
  error.value = null;
  try {
    accounts.value = await listAccounts(projectId.value, query || undefined);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Failed to load accounts: ${msg}`;
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    fetchAccounts(searchQuery.value);
  }, 300);
}

onMounted(async () => {
  projectId.value = getProjectId();
  if (!projectId.value) {
    error.value = 'No project configured.';
    loading.value = false;
    return;
  }
  await fetchAccounts();
});
</script>

<template>
  <div>
    <h2 class="text-lg font-medium text-text mb-4">Accounts</h2>

    <div class="mb-4">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="Search accounts..."
        class="w-full max-w-md border border-border rounded-md bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-teal"
        @input="onSearch"
      />
    </div>

    <div v-if="loading" class="text-text-muted">Loading accounts...</div>

    <div
      v-else-if="error"
      class="rounded-md bg-red-500/10 border border-red-500/20 p-4 text-sm text-red"
    >
      <p v-text="error"></p>
    </div>

    <div v-else-if="accounts.length === 0" class="flex flex-col items-center justify-center py-16 text-center">
      <svg class="h-12 w-12 text-text-faint mb-4" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
      <h3 class="text-sm font-medium text-text">No accounts yet</h3>
      <p class="mt-1 text-sm text-text-muted">
        Account data will appear once your SDK sends <code class="rounded bg-surface-2 px-1 py-0.5 text-xs">context.user</code> with account information.
      </p>
    </div>

    <div v-else class="border border-border rounded-lg overflow-hidden">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-surface">
            <th
              class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider cursor-pointer hover:text-text select-none"
              @click="toggleSort('name')"
            >
              Account{{ sortIndicator('name') }}
            </th>
            <th
              class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider cursor-pointer hover:text-text select-none"
              @click="toggleSort('users')"
            >
              Users{{ sortIndicator('users') }}
            </th>
            <th
              class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider cursor-pointer hover:text-text select-none"
              @click="toggleSort('incidents')"
            >
              Incidents{{ sortIndicator('incidents') }}
            </th>
            <th
              class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider cursor-pointer hover:text-text select-none"
              @click="toggleSort('last_seen')"
            >
              Last Seen{{ sortIndicator('last_seen') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="account in sortedAccounts"
            :key="account.external_account_id"
            class="border-b border-border-subtle hover:bg-surface transition-colors"
          >
            <td class="py-2.5 px-4">
              <router-link
                :to="{ name: 'account-detail', params: { accountId: account.external_account_id }, query: { project_id: projectId } }"
                class="text-teal hover:underline font-medium"
                v-text="account.account_name || account.external_account_id"
              >
              </router-link>
            </td>
            <td class="py-2.5 px-4 text-right text-text-muted tabular-nums">
              {{ account.user_count }}
            </td>
            <td class="py-2.5 px-4 text-right text-text-muted tabular-nums">
              {{ account.incident_count }}
            </td>
            <td class="py-2.5 px-4 text-right text-text-muted whitespace-nowrap">
              {{ formatDate(account.last_seen) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
