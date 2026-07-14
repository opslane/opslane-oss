<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import type { Incident, AffectedUser } from '../types/api';
import { getIncident, getReplay, listAffectedUsers, triggerFix, resolveIncident, archiveIncident, unarchiveIncident, type ReplayRecording } from '../api';
import { getProjectId, statusBadgeClass, safeUrl, formatDate, formatAbsolute } from '../utils';
import PipelineIndicator from '../components/PipelineIndicator.vue';
import ReplayPlayer from '../components/ReplayPlayer.vue';
import type { eventWithTime } from '@rrweb/types';

const route = useRoute();
const incidentId = route.params['id'] as string;
const incident = ref<Incident | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const projectId = ref('');
const replay = ref<ReplayRecording | null>(null);
const replayLoading = ref(false);
const replayError = ref<string | null>(null);

// Tabs
const activeTab = ref<'overview' | 'affected-users'>('overview');
const affectedUsers = ref<AffectedUser[]>([]);
const affectedUsersLoading = ref(false);
const affectedUsersLoaded = ref(false);

async function loadAffectedUsers() {
  if (affectedUsersLoaded.value || affectedUsersLoading.value) return;
  affectedUsersLoading.value = true;
  try {
    affectedUsers.value = await listAffectedUsers(projectId.value, incidentId);
    affectedUsersLoaded.value = true;
  } catch {
    // Non-fatal
  } finally {
    affectedUsersLoading.value = false;
  }
}

async function loadReplay() {
  const id = incident.value?.replay_id;
  if (!id || replay.value || replayLoading.value) return;
  replayLoading.value = true;
  replayError.value = null;
  try {
    replay.value = await getReplay(projectId.value, id);
  } catch (e: unknown) {
    replayError.value = e instanceof Error ? e.message : String(e);
  } finally {
    replayLoading.value = false;
  }
}

// Find Fix form state
const guidance = ref('');
const fixLoading = ref(false);
const fixError = ref<string | null>(null);
let fixPollTimer: ReturnType<typeof setInterval> | null = null;
let fixPollCount = 0;
const fixTimedOut = ref(false);
const MAX_FIX_POLLS = 60; // 5 minutes at 5s intervals

async function handleTriggerFix() {
  if (fixLoading.value || !incident.value) return;
  fixLoading.value = true;
  fixError.value = null;
  fixTimedOut.value = false;
  try {
    await triggerFix(projectId.value, incidentId, guidance.value || undefined);
    incident.value = { ...incident.value, status: 'fixing' };
    startFixPolling();
  } catch (e: unknown) {
    fixError.value = e instanceof Error ? e.message : String(e);
  } finally {
    fixLoading.value = false;
  }
}

function startFixPolling() {
  if (fixPollTimer) return;
  fixPollCount = 0;
  fixPollTimer = setInterval(async () => {
    fixPollCount++;
    if (fixPollCount > MAX_FIX_POLLS) {
      stopFixPolling();
      fixTimedOut.value = true;
      return;
    }
    try {
      const updated = await getIncident(projectId.value, incidentId);
      incident.value = updated;
      void loadReplay();
      if (updated.status !== 'fixing') {
        stopFixPolling();
      }
    } catch {
      // Non-fatal
    }
  }, 5000);
}

function stopFixPolling() {
  if (fixPollTimer) {
    clearInterval(fixPollTimer);
    fixPollTimer = null;
  }
}

onUnmounted(() => stopFixPolling());

function switchTab(tab: 'overview' | 'affected-users') {
  activeTab.value = tab;
  if (tab === 'affected-users') {
    loadAffectedUsers();
  }
}

const actionLoading = ref(false);

function getActionFn(action: 'resolve' | 'archive' | 'unarchive') {
  switch (action) {
    case 'resolve': return resolveIncident;
    case 'archive': return archiveIncident;
    case 'unarchive': return unarchiveIncident;
  }
}

async function doAction(action: 'resolve' | 'archive' | 'unarchive') {
  if (!incident.value || actionLoading.value) return;
  actionLoading.value = true;
  try {
    incident.value = await getActionFn(action)(projectId.value, incidentId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Action failed: ${msg}`;
  } finally {
    actionLoading.value = false;
  }
}

onMounted(async () => {
  projectId.value = getProjectId();
  if (!projectId.value) {
    error.value = 'No project configured. Set project_id in query params or localStorage.';
    loading.value = false;
    return;
  }

  try {
    incident.value = await getIncident(projectId.value, incidentId);
    void loadReplay();
    if (incident.value.status === 'fixing') {
      startFixPolling();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Failed to load incident: ${msg}`;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <router-link to="/" class="text-teal hover:underline text-sm">
      &larr; Back to incidents
    </router-link>

    <div v-if="loading" class="mt-4 text-text-muted">Loading incident...</div>

    <div
      v-else-if="error"
      class="mt-4 rounded-md bg-red-500/10 border border-red-500/20 p-4 text-sm text-red"
    >
      <p v-text="error"></p>
    </div>

    <div v-else-if="!incident" class="mt-8 flex flex-col items-center justify-center py-16 text-center">
      <svg class="h-12 w-12 text-text-faint mb-4" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <h3 class="text-sm font-medium text-text">Incident not found</h3>
      <p class="mt-1 text-sm text-text-muted">This incident may have been resolved or doesn't exist.</p>
      <router-link to="/" class="mt-4 text-teal hover:underline text-sm">Back to incidents</router-link>
    </div>

    <div v-else class="mt-4 space-y-6">
      <!-- Header -->
      <div>
        <div class="flex items-start gap-3">
          <h2 class="text-xl font-semibold text-text flex-1" v-text="incident.title"></h2>
          <span
            class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap mt-1"
            :class="statusBadgeClass(incident.status)"
            v-text="incident.status.replace('_', ' ')"
          >
          </span>
        </div>
        <div class="mt-2 flex flex-wrap gap-4 text-sm text-text-muted">
          <span>{{ incident.occurrence_count }} occurrences</span>
          <span>{{ incident.affected_users_count }} users affected</span>
          <span>First seen {{ formatDate(incident.first_seen) }}</span>
          <span>Last seen {{ formatDate(incident.last_seen) }}</span>
          <span v-if="incident.confidence" class="text-text-faint">
            {{ incident.confidence }} confidence
          </span>
        </div>
      </div>

      <!-- Pipeline -->
      <PipelineIndicator :status="incident.status" />

      <!-- Actions -->
      <div class="flex items-center gap-2">
        <button
          v-if="incident.status !== 'resolved' && incident.status !== 'archived'"
          class="btn-primary bg-green"
          :disabled="actionLoading"
          @click="doAction('resolve')"
        >
          Resolve
        </button>
        <button
          v-if="incident.status !== 'archived'"
          class="btn-secondary text-sm disabled:opacity-50"
          :disabled="actionLoading"
          @click="doAction('archive')"
        >
          Archive
        </button>
        <button
          v-if="incident.status === 'archived'"
          class="btn-primary bg-indigo"
          :disabled="actionLoading"
          @click="doAction('unarchive')"
        >
          Unarchive
        </button>
      </div>

      <!-- Tabs -->
      <div class="border-b border-border">
        <nav class="-mb-px flex gap-6">
          <button
            class="py-2 px-1 text-sm font-medium border-b-2 transition-colors"
            :class="activeTab === 'overview' ? 'tab-active' : 'tab-inactive'"
            @click="switchTab('overview')"
          >
            Overview
          </button>
          <button
            class="py-2 px-1 text-sm font-medium border-b-2 transition-colors"
            :class="activeTab === 'affected-users' ? 'tab-active' : 'tab-inactive'"
            @click="switchTab('affected-users')"
          >
            Affected Users ({{ incident.affected_users_count }})
          </button>
        </nav>
      </div>

      <!-- Overview Tab -->
      <div v-if="activeTab === 'overview'" class="space-y-6">
        <!-- Replay -->
        <div v-if="incident.replay_id" class="p-4 bg-surface border border-border rounded-lg space-y-2">
          <p class="text-xs font-medium text-text-muted uppercase tracking-wide">Session Replay</p>
          <div v-if="replayLoading" class="text-sm text-text-muted">Loading replay...</div>
          <div v-else-if="replayError" class="text-sm text-red-500">Replay unavailable: {{ replayError }}</div>
          <ReplayPlayer
            v-else-if="replay && replay.events && replay.events.length"
            :events="(replay.events as eventWithTime[])"
            :crash-timestamp="replay.meta?.crash_timestamp"
          />
          <div v-else class="text-sm text-text-muted">Replay recorded but empty.</div>
        </div>
        <div v-else class="text-sm text-text-faint">No replay captured for this error.</div>

        <!-- PR link -->
        <div
          v-if="safeUrl(incident.pr_url)"
          class="p-4 bg-green-500/10 border border-green-500/20 border-l-2 border-l-green rounded-lg"
        >
          <p class="text-sm font-medium text-green">Fix PR created</p>
          <a
            :href="safeUrl(incident.pr_url)"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-1 inline-flex items-center text-green font-medium hover:underline text-sm"
            v-text="incident.pr_url"
          >
          </a>
        </div>

        <!-- Investigation results (investigated, fixing, or preserved on needs_human) -->
        <div
          v-if="(incident.status === 'investigated' || incident.status === 'fixing' || incident.status === 'needs_human') && incident.root_cause"
          class="p-4 bg-teal-500/10 border border-teal-500/20 border-l-2 border-l-teal rounded-lg space-y-3"
        >
          <div>
            <p class="text-xs font-medium text-teal uppercase tracking-wide">
              Root Cause
            </p>
            <pre
              class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
              v-text="incident.root_cause"
            ></pre>
          </div>
          <div v-if="incident.suggested_mitigation">
            <p class="text-xs font-medium text-teal uppercase tracking-wide">
              Suggested Fix
            </p>
            <pre
              class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
              v-text="incident.suggested_mitigation"
            ></pre>
          </div>
        </div>

        <!-- Find Fix button (investigated state) -->
        <div
          v-if="incident.status === 'investigated'"
          class="p-4 bg-surface border border-border rounded-lg space-y-3"
        >
          <div>
            <label for="guidance" class="block text-sm font-medium text-text-muted">
              Guide the agent (optional)
            </label>
            <textarea
              id="guidance"
              v-model="guidance"
              rows="3"
              maxlength="2000"
              placeholder="Add context to help the agent find the right fix..."
              class="mt-1 block w-full rounded-md border border-border bg-surface-2 text-text focus:border-teal focus:ring-teal text-sm"
            ></textarea>
            <p class="mt-1 text-xs text-text-faint">{{ guidance.length }}/2000</p>
          </div>
          <div class="flex items-center gap-3">
            <button
              :disabled="fixLoading"
              class="inline-flex items-center btn-primary disabled:cursor-not-allowed"
              @click="handleTriggerFix"
            >
              <span v-if="fixLoading">Triggering...</span>
              <span v-else>Find Fix</span>
            </button>
            <p
              v-if="fixError"
              class="text-sm text-red"
              v-text="fixError"
            ></p>
          </div>
        </div>

        <!-- Fixing indicator -->
        <div
          v-if="incident.status === 'fixing'"
          class="p-4 bg-indigo-500/10 border border-indigo-500/20 border-l-2 border-l-indigo rounded-lg"
        >
          <div v-if="fixTimedOut">
            <p class="text-sm font-medium text-amber">This is taking longer than expected.</p>
            <p class="mt-1 text-xs text-amber">Refresh the page to check the latest status.</p>
          </div>
          <div v-else>
            <div class="flex items-center gap-2">
              <svg class="animate-spin h-4 w-4 text-indigo" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span class="text-sm font-medium text-indigo">Agent is working on a fix...</span>
            </div>
            <p class="mt-1 text-xs text-indigo">This page will update automatically when the fix is ready.</p>
          </div>
        </div>

        <!-- Needs human reason -->
        <div
          v-if="incident.status === 'needs_human' && incident.reason"
          class="p-4 bg-amber-500/10 border border-amber-500/20 border-l-2 border-l-amber rounded-lg space-y-3"
        >
          <div>
            <p class="text-xs font-medium text-amber uppercase tracking-wide">
              Reason
            </p>
            <p
              class="mt-1 text-sm text-amber font-medium"
              v-text="incident.reason.reason_message"
            ></p>
          </div>
          <div>
            <p class="text-xs font-medium text-amber uppercase tracking-wide">
              Remediation
            </p>
            <pre
              class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
              v-text="incident.reason.remediation"
            ></pre>
          </div>
          <div>
            <p class="text-xs text-text-faint">
              Code: <span v-text="incident.reason.reason_code"></span>
            </p>
          </div>
        </div>

        <!-- Metadata -->
        <div class="border-t border-border pt-4">
          <dl class="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
            <div>
              <dt class="text-text-muted">First seen</dt>
              <dd class="text-text-muted">{{ formatAbsolute(incident.first_seen) }}</dd>
            </div>
            <div>
              <dt class="text-text-muted">Last seen</dt>
              <dd class="text-text-muted">{{ formatAbsolute(incident.last_seen) }}</dd>
            </div>
            <div v-if="incident.merged_at">
              <dt class="text-text-muted">Merged</dt>
              <dd class="text-text-muted">{{ formatAbsolute(incident.merged_at) }}</dd>
            </div>
            <div v-if="incident.resolved_at">
              <dt class="text-text-muted">Resolved</dt>
              <dd class="text-text-muted">{{ formatAbsolute(incident.resolved_at) }}</dd>
            </div>
            <div v-if="incident.archived_at">
              <dt class="text-text-muted">Archived</dt>
              <dd class="text-text-muted">{{ formatAbsolute(incident.archived_at) }}</dd>
            </div>
            <div>
              <dt class="text-text-muted">Fingerprint</dt>
              <dd class="text-text-muted font-mono">{{ incident.fingerprint }}</dd>
            </div>
            <div>
              <dt class="text-text-muted">ID</dt>
              <dd class="text-text-muted font-mono">{{ incident.id }}</dd>
            </div>
            <div v-if="incident.trace_url">
              <dt class="text-text-muted">Trace</dt>
              <dd>
                <a
                  :href="incident.trace_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-teal hover:underline text-xs"
                >View in Langfuse</a>
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <!-- Affected Users Tab -->
      <div v-if="activeTab === 'affected-users'">
        <div v-if="affectedUsersLoading" class="text-text-muted text-sm">
          Loading affected users...
        </div>
        <div v-else-if="affectedUsers.length === 0" class="flex flex-col items-center justify-center py-12 text-center">
          <p class="text-sm text-text-muted">No affected users tracked for this incident.</p>
        </div>
        <div v-else class="border border-border rounded-lg overflow-hidden">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="border-b border-border bg-surface">
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">User ID</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Email</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Account</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">First seen</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Last seen</th>
                <th class="py-2.5 px-4 text-right text-xs font-medium text-text-muted uppercase tracking-wider">Occurrences</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="user in affectedUsers"
                :key="user.end_user_id"
                class="border-b border-border-subtle hover:bg-surface transition-colors"
              >
                <td class="py-2.5 px-4 font-mono text-xs" v-text="user.external_user_id"></td>
                <td class="py-2.5 px-4" v-text="user.email || '—'"></td>
                <td class="py-2.5 px-4" v-text="user.external_account_id || '—'"></td>
                <td class="py-2.5 px-4 whitespace-nowrap">{{ formatDate(user.first_seen) }}</td>
                <td class="py-2.5 px-4 whitespace-nowrap">{{ formatDate(user.last_seen) }}</td>
                <td class="py-2.5 px-4 text-right tabular-nums">{{ user.occurrence_count }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
