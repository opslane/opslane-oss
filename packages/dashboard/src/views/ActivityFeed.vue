<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { Incident, IncidentFilters, ErrorGroupStatus } from '../types/api';
import { listIncidents } from '../api';
import { getProjectId } from '../utils';
import { useTableSort } from '../composables/useTableSort';
import FilterBar from '../components/FilterBar.vue';
import IncidentLedgerRow from '../components/incidents/IncidentLedgerRow.vue';
import InlineAlert from '../components/ui/InlineAlert.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import SkeletonBlock from '../components/ui/SkeletonBlock.vue';

const POLL_INTERVAL = 30_000; // 30 seconds

const incidents = ref<Incident[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const projectId = ref('');
const currentFilters = ref<IncidentFilters>({});
let fetchGeneration = 0;

const statusOrder: Record<ErrorGroupStatus, number> = {
  candidate: -1,
  new: 0,
  queued: 1,
  analyzing: 2,
  fixing: 3,
  investigated: 4,
  awaiting_approval: 4,
  pr_draft: 5,
  pr_created: 6,
  needs_human: 7,
  insight: 8,
  resolved: 8,
  merged: 9,
  archived: 10,
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
  const generation = ++fetchGeneration;
  loading.value = true;
  error.value = null;
  newIncidentCount.value = 0;
  try {
    const result = await listIncidents(projectId.value, filters);
    if (generation !== fetchGeneration) return;
    incidents.value = result;
  } catch (e: unknown) {
    if (generation !== fetchGeneration) return;
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Failed to load incidents: ${msg}`;
  } finally {
    if (generation === fetchGeneration) loading.value = false;
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

  startPolling();
});

onUnmounted(() => stopPolling());
</script>

<template>
  <div class="mx-auto w-full max-w-[1120px]">
    <header class="mb-7 border-b border-border pb-5">
      <p class="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Incident ledger</p>
      <div class="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight text-text">Production incidents</h1>
          <p class="mt-1 max-w-2xl text-sm text-muted">Review current outcomes, affected users, and the evidence behind each investigation.</p>
        </div>
        <p v-if="!loading && !error" class="font-mono text-xs text-muted">{{ incidents.length }} record{{ incidents.length === 1 ? '' : 's' }}</p>
      </div>
    </header>

    <FilterBar
      v-if="projectId"
      :project-id="projectId"
      @filter-change="onFilterChange"
    />

    <button
      v-if="newIncidentCount > 0"
      class="mb-4 w-full border border-accent bg-surface px-4 py-2 text-center text-sm font-semibold text-accent hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      @click="loadNewIncidents"
    >
      {{ newIncidentCount }} new incident{{ newIncidentCount === 1 ? '' : 's' }} — click to refresh
    </button>

    <div
      v-if="loading"
      role="status"
      aria-busy="true"
      aria-label="Loading incident ledger"
      class="grid gap-3 border-y border-border py-5"
    >
      <SkeletonBlock class="h-14" />
      <SkeletonBlock class="h-14" />
      <SkeletonBlock class="h-14" />
    </div>

    <InlineAlert
      v-else-if="error"
      tone="danger"
      title="Unable to load incidents"
    >
      <p v-text="error"></p>
    </InlineAlert>

    <EmptyState v-else-if="incidents.length === 0" title="No incidents yet" description="Events will appear once your SDK starts reporting errors.">
      <router-link
        to="/setup"
        class="inline-flex min-h-10 items-center bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        Setup guide
      </router-link>
    </EmptyState>

    <div v-else class="overflow-x-auto border-y border-border">
      <table class="min-w-full text-sm" aria-label="Production incidents">
        <thead>
          <tr class="border-b border-border bg-surface-subtle">
            <th class="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:px-5">
              Title
            </th>
            <th class="hidden px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted md:table-cell">
              Kind
            </th>
            <th
              class="cursor-pointer select-none px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted hover:text-text"
              @click="toggleSort('status')"
            >
              Status{{ sortIndicator('status') }}
            </th>
            <th
              class="hidden cursor-pointer select-none px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted hover:text-text sm:table-cell"
              @click="toggleSort('occurrences')"
            >
              Events{{ sortIndicator('occurrences') }}
            </th>
            <th
              class="hidden cursor-pointer select-none px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted hover:text-text lg:table-cell"
              :title="currentFilters.environment_id ? 'users across all environments' : undefined"
              @click="toggleSort('users')"
            >
              Users{{ sortIndicator('users') }}
              <span v-if="currentFilters.environment_id" class="block text-[10px] normal-case tracking-normal">
                across all environments
              </span>
            </th>
            <th
              class="hidden cursor-pointer select-none px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted hover:text-text xl:table-cell"
              @click="toggleSort('last_seen')"
            >
              Last Seen{{ sortIndicator('last_seen') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <IncidentLedgerRow
            v-for="incident in sortedIncidents"
            :key="incident.id"
            :incident="incident"
            :project-id="projectId"
          />
        </tbody>
      </table>
    </div>
  </div>
</template>
