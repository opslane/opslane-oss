<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import type { Account, Incident } from '../types/api';
import { getAccount, listAccountIncidents } from '../api';
import { getProjectId, statusBadgeClass, formatDate } from '../utils';

const route = useRoute();
const accountId = route.params['accountId'] as string;
const account = ref<Account | null>(null);
const incidents = ref<Incident[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const projectId = ref('');

onMounted(async () => {
  projectId.value = getProjectId();
  if (!projectId.value) {
    error.value = 'No project configured.';
    loading.value = false;
    return;
  }

  try {
    const [acct, inc] = await Promise.all([
      getAccount(projectId.value, accountId),
      listAccountIncidents(projectId.value, accountId),
    ]);
    account.value = acct;
    incidents.value = inc;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Failed to load account: ${msg}`;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <router-link :to="{ name: 'accounts' }" class="text-teal hover:underline text-sm">
      &larr; Back to accounts
    </router-link>

    <div v-if="loading" class="mt-4 text-text-muted">Loading account...</div>

    <div
      v-else-if="error"
      class="mt-4 rounded-md bg-red-500/10 border border-red-500/20 p-4 text-sm text-red"
    >
      <p v-text="error"></p>
    </div>

    <div v-else-if="!account" class="mt-8 flex flex-col items-center justify-center py-16 text-center">
      <svg class="h-12 w-12 text-text-faint mb-4" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
      <h3 class="text-sm font-medium text-text">Account not found</h3>
      <p class="mt-1 text-sm text-text-muted">This account may not exist or has no tracked data.</p>
      <router-link :to="{ name: 'accounts' }" class="mt-4 text-teal hover:underline text-sm">Back to accounts</router-link>
    </div>

    <div v-else class="mt-4 space-y-6">
      <!-- Account header -->
      <div>
        <h2 class="text-xl font-semibold text-text" v-text="account.account_name || account.external_account_id"></h2>
        <div class="mt-2 flex flex-wrap gap-4 text-sm text-text-muted">
          <span>{{ account.user_count }} users</span>
          <span>{{ account.incident_count }} incidents</span>
          <span>Last seen {{ formatDate(account.last_seen) }}</span>
        </div>
        <p class="mt-1 text-xs text-text-faint font-mono" v-text="account.external_account_id"></p>
      </div>

      <!-- Incidents -->
      <div>
        <h3 class="text-sm font-medium text-text-muted mb-3">Incidents</h3>

        <div v-if="incidents.length === 0" class="flex flex-col items-center justify-center py-12 text-center">
          <p class="text-sm text-text-muted">No incidents for this account.</p>
        </div>

        <div v-else class="border border-border rounded-lg overflow-hidden">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="border-b border-border bg-surface">
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Title</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Status</th>
                <th class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider">Events</th>
                <th class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider">Users</th>
                <th class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="incident in incidents"
                :key="incident.id"
                class="border-b border-border-subtle hover:bg-surface transition-colors"
              >
                <td class="py-2.5 px-4">
                  <router-link
                    :to="{ name: 'incident', params: { id: incident.id }, query: { project_id: projectId } }"
                    class="text-teal hover:underline font-medium block truncate max-w-md"
                    v-text="incident.title"
                  ></router-link>
                </td>
                <td class="py-2.5 px-4">
                  <span
                    class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
                    :class="statusBadgeClass(incident.status)"
                    v-text="incident.status.replace('_', ' ')"
                  ></span>
                </td>
                <td class="py-2.5 px-4 text-right text-text-muted tabular-nums">{{ incident.occurrence_count }}</td>
                <td class="py-2.5 px-4 text-right text-text-muted tabular-nums">{{ incident.affected_users_count }}</td>
                <td class="py-2.5 px-4 text-right text-text-muted whitespace-nowrap">{{ formatDate(incident.last_seen) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
