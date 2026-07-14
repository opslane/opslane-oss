<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { Incident, IncidentFilters, ErrorGroupStatus } from '../types/api';
import { listIncidents } from '../api';
import { getProjectId, statusBadgeClass, formatDate } from '../utils';
import { useTableSort } from '../composables/useTableSort';
import FilterBar from '../components/FilterBar.vue';

const POLL_INTERVAL = 30_000; // 30 seconds

const incidents = ref<Incident[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const projectId = ref('');
const currentFilters = ref<IncidentFilters>({});

const statusOrder: Record<ErrorGroupStatus, number> = {
  new: 0,
  queued: 1,
  analyzing: 2,
  fixing: 3,
  investigated: 4,
  pr_created: 5,
  needs_human: 6,
  resolved: 7,
  merged: 8,
  archived: 9,
};

type SortKey = 'last_seen' | 'occurrences' | 'users' | 'status';

const { sorted: sortedIncidents, toggleSort, sortIndicator } = useTableSort<SortKey, Incident>(
  incidents,
  'last_seen',
  {
    occurrences: (a, b) => a.occurrence_count - b.occurrence_count,
    users: (a, b) => a.affected_users_count - b.affected_users_count,
    status: (a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99),
    last_seen: (a, b) => new Date(a.last_seen).getTime() - new Date(b.last_seen).getTime(),
  },
);

const newIncidentCount = ref(0);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchIncidents(filters?: IncidentFilters) {
  loading.value = true;
  error.value = null;
  newIncidentCount.value = 0;
  try {
    incidents.value = await listIncidents(projectId.value, filters);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Failed to load incidents: ${msg}`;
  } finally {
    loading.value = false;
  }
}

async function pollForNew() {
  try {
    const latest = await listIncidents(projectId.value, currentFilters.value);
    if (latest.length > incidents.value.length) {
      newIncidentCount.value = latest.length - incidents.value.length;
    }
  } catch {
    // Silent — polling failure is non-fatal
  }
}

function loadNewIncidents() {
  fetchIncidents(currentFilters.value);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollForNew, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function onFilterChange(filters: IncidentFilters) {
  currentFilters.value = filters;
  fetchIncidents(filters);
}

onMounted(async () => {
  projectId.value = getProjectId();
  if (!projectId.value) {
    error.value = 'No project configured. Set project_id in query params or localStorage.';
    loading.value = false;
    return;
  }

  await fetchIncidents();
  startPolling();
});

onUnmounted(() => stopPolling());
</script>

<template>
  <div>
    <h2 class="text-lg font-medium text-text mb-2">Incidents</h2>

    <FilterBar
      v-if="projectId"
      :project-id="projectId"
      @filter-change="onFilterChange"
    />

    <button
      v-if="newIncidentCount > 0"
      class="w-full mb-3 rounded-md bg-teal/10 border border-teal/20 px-4 py-2 text-sm text-teal font-medium hover:bg-teal/20 transition-colors text-center"
      @click="loadNewIncidents"
    >
      {{ newIncidentCount }} new incident{{ newIncidentCount === 1 ? '' : 's' }} — click to refresh
    </button>

    <div v-if="loading" class="text-text-muted">Loading incidents...</div>

    <div
      v-else-if="error"
      class="rounded-md bg-red-500/10 border border-red-500/20 p-4 text-sm text-red"
    >
      <p v-text="error"></p>
    </div>

    <div v-else-if="incidents.length === 0" class="flex flex-col items-center justify-center py-16 text-center">
      <svg class="h-12 w-12 text-text-faint mb-4" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <h3 class="text-sm font-medium text-text">No incidents yet</h3>
      <p class="mt-1 text-sm text-text-muted">Events will appear once your SDK starts reporting errors.</p>
      <router-link
        to="/setup"
        class="mt-4 inline-flex items-center btn-primary"
      >
        Setup guide
      </router-link>
    </div>

    <div v-else class="border border-border rounded-lg overflow-hidden">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-surface">
            <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">
              Title
            </th>
            <th
              class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider cursor-pointer hover:text-text select-none"
              @click="toggleSort('status')"
            >
              Status{{ sortIndicator('status') }}
            </th>
            <th
              class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider cursor-pointer hover:text-text select-none"
              @click="toggleSort('occurrences')"
            >
              Events{{ sortIndicator('occurrences') }}
            </th>
            <th
              class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider cursor-pointer hover:text-text select-none"
              @click="toggleSort('users')"
            >
              Users{{ sortIndicator('users') }}
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
            v-for="incident in sortedIncidents"
            :key="incident.id"
            class="border-b border-border-subtle hover:bg-surface transition-colors"
          >
            <td class="py-2.5 px-4">
              <router-link
                :to="{ name: 'incident', params: { id: incident.id }, query: { project_id: projectId } }"
                class="text-teal hover:underline font-medium block truncate max-w-md"
                v-text="incident.title"
              >
              </router-link>
            </td>
            <td class="py-2.5 px-4">
              <span
                class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
                :class="statusBadgeClass(incident.status)"
                v-text="incident.status.replace('_', ' ')"
              >
              </span>
            </td>
            <td class="py-2.5 px-4 text-right text-text-muted tabular-nums">
              {{ incident.occurrence_count }}
            </td>
            <td class="py-2.5 px-4 text-right text-text-muted tabular-nums">
              {{ incident.affected_users_count }}
            </td>
            <td class="py-2.5 px-4 text-right text-text-muted whitespace-nowrap">
              {{ formatDate(incident.last_seen) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
