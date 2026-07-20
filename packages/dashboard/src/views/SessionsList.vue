<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { listSessions } from '../api';
import type { SessionFilters, SessionSummary } from '../types/api';
import { formatDate, getProjectId, safeUrl } from '../utils';
import { applySessionFilters, sessionPageRequest } from '../components/session-list-query';
import { useEnvironmentFilter } from '../composables/useEnvironmentFilter';

const sessions = ref<SessionSummary[]>([]);
const projectId = ref('');
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);
const endUserId = ref('');
const accountId = ref('');
const from = ref('');
const to = ref('');
const appliedFilters = ref<SessionFilters>({});
let fetchGeneration = 0;
const {
  environments,
  rollupReady,
  selectedEnvironmentId,
} = useEnvironmentFilter(projectId);

watch(rollupReady, (ready) => {
  if (ready) applyFilters();
});

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function filters(): SessionFilters {
  return {
    end_user_id: endUserId.value.trim() || undefined,
    account_id: accountId.value.trim() || undefined,
    environment_id: rollupReady.value ? selectedEnvironmentId.value || undefined : undefined,
    from: isoDate(from.value),
    to: isoDate(to.value),
  };
}

async function fetchSessions(cursor?: string): Promise<void> {
  const generation = ++fetchGeneration;
  if (cursor) loadingMore.value = true;
  else {
    loading.value = true;
    loadingMore.value = false;
  }
  error.value = null;
  try {
    const request = sessionPageRequest(appliedFilters.value, cursor);
    const response = await listSessions(projectId.value, request.filters, request.cursor);
    if (generation !== fetchGeneration) return;
    sessions.value = cursor ? [...sessions.value, ...response.sessions] : response.sessions;
    nextCursor.value = response.next_cursor ?? null;
  } catch (caught: unknown) {
    if (generation !== fetchGeneration) return;
    const message = caught instanceof Error ? caught.message : String(caught);
    error.value = `Failed to load sessions: ${message}`;
  } finally {
    if (generation === fetchGeneration) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function applyFilters(): void {
  // Invalidate any in-flight page before it can append rows produced by the
  // previous filter snapshot.
  fetchGeneration++;
  const applied = applySessionFilters(filters());
  appliedFilters.value = applied.filters;
  nextCursor.value = applied.cursor;
  void fetchSessions();
}

function duration(session: SessionSummary): string {
  if (!session.last_chunk_at) return '\u2014';
  const ms = new Date(session.last_chunk_at).getTime() - new Date(session.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '\u2014';
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function sessionBadge(status: string): string {
  if (status === 'recording') return 'bg-teal/10 text-teal';
  if (status === 'analysis_failed') return 'bg-red/10 text-red';
  if (status === 'analyzing') return 'bg-indigo/10 text-indigo';
  if (status === 'analyzed') return 'bg-green/10 text-green';
  return 'bg-surface-2 text-text-muted';
}

onMounted(() => {
  projectId.value = getProjectId();
  if (!projectId.value) {
    error.value = 'No project configured.';
    loading.value = false;
    return;
  }
  void fetchSessions();
});
</script>

<template>
  <div>
    <div class="flex items-center justify-between gap-4 mb-4">
      <div>
        <h2 class="text-lg font-medium text-text">Sessions</h2>
        <p class="mt-1 text-sm text-text-muted">Browse scrubbed recordings by user, account, and time.</p>
      </div>
    </div>

    <form class="grid gap-3 mb-5 md:grid-cols-2 xl:grid-cols-6" @submit.prevent="applyFilters">
      <input v-model="endUserId" type="text" placeholder="End-user ID" class="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm" />
      <input v-model="accountId" type="text" placeholder="Account ID" class="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm" />
      <label v-if="rollupReady" class="text-xs text-text-muted">
        Environment
        <select
          v-model="selectedEnvironmentId"
          class="mt-1 block w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text"
          @change="applyFilters"
        >
          <option value="">All environments</option>
          <option
            v-for="environment in environments"
            :key="environment.id"
            :value="environment.id"
            v-text="environment.name"
          ></option>
        </select>
      </label>
      <label class="text-xs text-text-muted">
        From
        <input v-model="from" type="datetime-local" class="mt-1 block w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text" />
      </label>
      <label class="text-xs text-text-muted">
        To
        <input v-model="to" type="datetime-local" class="mt-1 block w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text" />
      </label>
      <button type="submit" class="btn-primary self-end" :disabled="loading">Apply filters</button>
    </form>

    <div v-if="loading" class="text-text-muted">Loading sessions...</div>
    <div v-else-if="error" class="rounded-md bg-red/10 border border-red/20 p-4 text-sm text-red">
      <p v-text="error"></p>
    </div>
    <div v-else-if="sessions.length === 0" class="py-16 text-center">
      <h3 class="text-sm font-medium text-text">No sessions found</h3>
      <p class="mt-1 text-sm text-text-muted">Recordings appear after their first chunk has been accepted.</p>
    </div>
    <div v-else class="border border-border rounded-lg overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-surface text-left text-xs font-medium uppercase tracking-wider text-text-muted">
            <th class="py-2.5 px-4">Started</th>
            <th class="py-2.5 px-4">User</th>
            <th class="py-2.5 px-4">Duration</th>
            <th class="py-2.5 px-4">Chunks</th>
            <th class="py-2.5 px-4">Size</th>
            <th class="py-2.5 px-4">Status</th>
            <th class="py-2.5 px-4">Page</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in sessions" :key="item.id" class="border-b border-border-subtle hover:bg-surface transition-colors">
            <td class="py-2.5 px-4 whitespace-nowrap">
              <router-link
                v-if="item.playable_chunk_count > 0"
                :to="{ name: 'session-detail', params: { sessionId: item.id } }"
                class="text-teal hover:underline font-medium"
              >{{ formatDate(item.started_at) }}</router-link>
              <span v-else>{{ formatDate(item.started_at) }}</span>
            </td>
            <td class="py-2.5 px-4 text-text-muted" v-text="item.end_user?.email || item.end_user?.external_user_id || '\u2014'"></td>
            <td class="py-2.5 px-4 text-text-muted whitespace-nowrap">{{ duration(item) }}</td>
            <td class="py-2.5 px-4 text-text-muted whitespace-nowrap">
              {{ item.playable_chunk_count }}/{{ item.chunk_count }}
              <span v-if="item.playable_chunk_count === 0" class="ml-1 text-amber">processing</span>
            </td>
            <td class="py-2.5 px-4 text-text-muted whitespace-nowrap">{{ formatBytes(item.bytes_stored) }}</td>
            <td class="py-2.5 px-4">
              <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-medium" :class="sessionBadge(item.status)" v-text="item.status.replace('_', ' ')"></span>
            </td>
            <td class="py-2.5 px-4 max-w-72 truncate">
              <a v-if="safeUrl(item.page_url ?? undefined)" :href="safeUrl(item.page_url ?? undefined)" target="_blank" rel="noopener noreferrer" class="text-teal hover:underline" v-text="item.page_url"></a>
              <span v-else class="text-text-faint">\u2014</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="nextCursor" class="mt-4 text-center">
      <button class="btn-secondary text-sm" :disabled="loadingMore" @click="fetchSessions(nextCursor)">
        {{ loadingMore ? 'Loading...' : 'Load more' }}
      </button>
    </div>
  </div>
</template>
