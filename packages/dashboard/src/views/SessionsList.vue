<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { listSessions } from '../api';
import type { SessionFilters, SessionStatus, SessionSummary } from '../types/api';
import { formatDate, getProjectId, safeUrl } from '../utils';
import { sessionStatusRecipe } from '../status-recipes';
import { applySessionFilters, sessionPageRequest } from '../components/session-list-query';
import { useEnvironmentFilter } from '../composables/useEnvironmentFilter';
import SelectField from '../components/ui/SelectField.vue';
import TextInput from '../components/ui/TextInput.vue';
import Button from '../components/ui/Button.vue';

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
const environmentOptions = computed(() => [
  { value: '', label: 'All environments' },
  ...environments.value.map((environment) => ({ value: environment.id, label: environment.name })),
]);

function selectEnvironment(value: string): void {
  selectedEnvironmentId.value = value;
  applyFilters();
}

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

function sessionBadge(status: SessionStatus): string {
  return sessionStatusRecipe(status).class;
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
        <p class="mt-1 text-sm text-muted">Browse scrubbed recordings by user, account, and time.</p>
      </div>
    </div>

    <form class="grid gap-3 mb-5 md:grid-cols-2 xl:grid-cols-6" @submit.prevent="applyFilters">
      <TextInput v-model="endUserId" label="End-user ID" placeholder="End-user ID" />
      <TextInput v-model="accountId" label="Account ID" placeholder="Account ID" />
      <SelectField
        v-if="rollupReady"
        :model-value="selectedEnvironmentId"
        label="Environment"
        :options="environmentOptions"
        @update:model-value="selectEnvironment"
      />
      <TextInput v-model="from" label="From" type="datetime-local" />
      <TextInput v-model="to" label="To" type="datetime-local" />
      <Button variant="primary" class="self-end" type="submit" :disabled="loading">Apply filters</Button>
    </form>

    <div v-if="loading" class="text-muted">Loading sessions...</div>
    <div v-else-if="error" class="rounded-md bg-danger/10 border border-danger/20 p-4 text-sm text-danger">
      <p v-text="error"></p>
    </div>
    <div v-else-if="sessions.length === 0" class="py-16 text-center">
      <h3 class="text-sm font-medium text-text">No sessions found</h3>
      <p class="mt-1 text-sm text-muted">Recordings appear after their first chunk has been accepted.</p>
    </div>
    <div v-else class="border border-border rounded-lg overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-surface text-left text-xs font-medium uppercase tracking-wider text-muted">
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
          <tr v-for="item in sessions" :key="item.id" class="border-b border-border hover:bg-surface transition-colors">
            <td class="py-2.5 px-4 whitespace-nowrap">
              <router-link
                v-if="item.playable_chunk_count > 0"
                :to="{ name: 'session-detail', params: { sessionId: item.id } }"
                class="text-accent hover:underline font-medium"
              >{{ formatDate(item.started_at) }}</router-link>
              <span v-else>{{ formatDate(item.started_at) }}</span>
            </td>
            <td class="py-2.5 px-4 text-muted" v-text="item.end_user?.email || item.end_user?.external_user_id || '\u2014'"></td>
            <td class="py-2.5 px-4 text-muted whitespace-nowrap">{{ duration(item) }}</td>
            <td class="py-2.5 px-4 text-muted whitespace-nowrap">
              {{ item.playable_chunk_count }}/{{ item.chunk_count }}
              <span v-if="item.playable_chunk_count === 0" class="ml-1 text-warning">processing</span>
            </td>
            <td class="py-2.5 px-4 text-muted whitespace-nowrap">{{ formatBytes(item.bytes_stored) }}</td>
            <td class="py-2.5 px-4">
              <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-medium" :class="sessionBadge(item.status)" v-text="item.status.replace('_', ' ')"></span>
            </td>
            <td class="py-2.5 px-4 max-w-72 truncate">
              <a v-if="safeUrl(item.page_url ?? undefined)" :href="safeUrl(item.page_url ?? undefined)" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline" v-text="item.page_url"></a>
              <span v-else class="text-faint">\u2014</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="nextCursor" class="mt-4 text-center">
      <Button variant="secondary" :disabled="loadingMore" @click="fetchSessions(nextCursor)">
        {{ loadingMore ? 'Loading...' : 'Load more' }}
      </Button>
    </div>
  </div>
</template>
