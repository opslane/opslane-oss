<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { Incident, AffectedUser, SampleEvent } from '../types/api';
import { APIError, getIncident, getSampleEvent, getReplay, listAffectedUsers, triggerFix, resolveIncident, archiveIncident, unarchiveIncident, type ReplayRecording } from '../api';
import { getProjectId, statusBadgeClass, statusLabel, safeUrl, formatDate, formatAbsolute } from '../utils';
import { kindBadge, fixControlsVisible } from '../components/incident-kind';
import EvidenceCard from '../components/EvidenceCard.vue';
import PipelineIndicator from '../components/PipelineIndicator.vue';
import ReplayPlayer from '../components/ReplayPlayer.vue';
import CodeBlock from '../components/CodeBlock.vue';
import { formatBreadcrumb, getRequestContext } from '../components/sample-event';
import type { eventWithTime } from '@rrweb/types';
import { useSessionPlayback } from '../composables/useSessionPlayback';

const route = useRoute();
const incidentId = route.params['id'] as string;
const incident = ref<Incident | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const projectId = ref('');
const replay = ref<ReplayRecording | null>(null);
const replayLoading = ref(false);
const replayError = ref<string | null>(null);
const sampleEvent = ref<SampleEvent | null>(null);
const sampleEventError = ref<string | null>(null);
const requestContext = computed(() => (
  sampleEvent.value ? getRequestContext(sampleEvent.value.context) : null
));
const breadcrumbs = computed(() => (
  sampleEvent.value?.breadcrumbs.flatMap((breadcrumb) => {
    const formatted = formatBreadcrumb(breadcrumb);
    return formatted ? [formatted] : [];
  }) ?? []
));

// Breadcrumb timestamps are client-supplied and only narrowed to string:
// format parseable ones like the rest of the view, show the raw value otherwise.
function formatBreadcrumbTime(timestamp: string): string {
  return Number.isNaN(Date.parse(timestamp)) ? timestamp : formatAbsolute(timestamp);
}

async function loadSampleEvent() {
  sampleEvent.value = null;
  sampleEventError.value = null;
  try {
    sampleEvent.value = await getSampleEvent(projectId.value, incidentId);
  } catch (e: unknown) {
    if (e instanceof APIError && e.status === 404) return;
    sampleEventError.value = e instanceof Error ? e.message : String(e);
  }
}

const pointerSessionId = computed(() => incident.value?.session_pointer?.session_id ?? '');
const pointerErrorAt = computed(() => incident.value?.session_pointer?.error_at);
const {
  state: sessionReplayState,
  events: sessionReplayEvents,
  seekMs: sessionReplaySeekMs,
  missingChunks: sessionMissingChunks,
  approximate: sessionReplayApproximate,
  pollAttempt: sessionPollAttempt,
  pollsRemaining: sessionPollsRemaining,
  terminalUnavailable: sessionTerminalUnavailable,
  error: sessionReplayError,
  stopPolling: stopSessionPolling,
} = useSessionPlayback(projectId, pointerSessionId, {
  errorAt: pointerErrorAt,
  windowed: true,
});

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
  if (incident.value?.session_pointer && !sessionTerminalUnavailable.value) return;
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

watch(sessionTerminalUnavailable, (unavailable) => {
  if (unavailable) void loadReplay();
});

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

onUnmounted(() => {
  stopFixPolling();
  stopSessionPolling();
});

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
    if (incident.value.kind === 'error') {
      void loadSampleEvent();
    }
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
      class="mt-4 rounded-md bg-red/10 border border-red/20 p-4 text-sm text-red"
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
            :class="kindBadge(incident.kind, incident.adjudication_status).class"
            v-text="kindBadge(incident.kind, incident.adjudication_status).label"
          >
          </span>
          <span
            class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap mt-1"
            :class="statusBadgeClass(incident.status)"
            v-text="statusLabel(incident.status)"
          >
          </span>
        </div>
        <div
          v-if="incident.adjudication_status === 'unchecked'"
          class="mt-3 p-3 bg-amber/10 border border-amber/20 border-l-2 border-l-amber rounded-lg text-sm text-amber"
        >
          The automated friction check for this detection could not complete
          (it exhausted its retries). It is shown for visibility only: it has
          no impact counts and cannot be fixed automatically.
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
      <div class="border-b border-border pb-3">
        <nav class="flex gap-2">
          <button
            class="text-sm font-medium transition-colors"
            :class="activeTab === 'overview' ? 'tab-active' : 'tab-inactive'"
            @click="switchTab('overview')"
          >
            Overview
          </button>
          <button
            class="text-sm font-medium transition-colors"
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
        <div v-if="incident.session_pointer || incident.replay_id" class="p-4 bg-surface border border-border rounded-lg space-y-2">
          <p class="text-xs font-medium text-text-muted uppercase tracking-wide">Session Replay</p>
          <template v-if="incident.session_pointer && !sessionTerminalUnavailable">
            <div v-if="sessionReplayState === 'loading'" class="text-sm text-text-muted">Loading replay...</div>
            <div v-else-if="sessionReplayState === 'processing'" class="rounded-md border border-amber/20 bg-amber/10 p-3 text-sm text-amber">
              Recording is processing. Checking again shortly (attempt {{ sessionPollAttempt }}/24, {{ sessionPollsRemaining }} remaining).
            </div>
            <div v-else-if="sessionReplayState === 'error'" class="text-sm text-red">Replay unavailable: {{ sessionReplayError }}</div>
            <template v-else-if="sessionReplayState === 'ready' || sessionReplayState === 'partial'">
              <div v-if="sessionReplayState === 'partial'" class="text-sm text-amber">
                {{ sessionMissingChunks.missing }} of {{ sessionMissingChunks.total }} chunks unavailable.
              </div>
              <div v-if="sessionReplayApproximate" class="text-sm text-amber">Playback position is approximate.</div>
              <ReplayPlayer :events="sessionReplayEvents" :crash-timestamp="sessionReplaySeekMs" />
              <router-link
                :to="{
                  name: 'session-detail',
                  params: { sessionId: incident.session_pointer.session_id },
                  query: { t: Date.parse(incident.session_pointer.error_at) },
                }"
                class="inline-flex text-sm text-teal hover:underline"
              >Open full session &rarr;</router-link>
            </template>
          </template>
          <template v-else-if="incident.replay_id">
            <div v-if="replayLoading" class="text-sm text-text-muted">Loading replay...</div>
            <div v-else-if="replayError" class="text-sm text-red">Replay unavailable: {{ replayError }}</div>
            <ReplayPlayer
              v-else-if="replay && replay.events && replay.events.length"
              :events="(replay.events as eventWithTime[])"
              :crash-timestamp="replay.meta?.crash_timestamp"
            />
            <div v-else class="text-sm text-text-muted">Replay recorded but empty.</div>
          </template>
          <div v-else class="text-sm text-text-muted">Session recording is no longer available.</div>
        </div>
        <div v-else class="text-sm text-text-faint">No replay captured for this error.</div>

        <!-- PR link -->
        <div
          v-if="safeUrl(incident.pr_url)"
          class="p-4 border border-l-2 rounded-lg"
          :class="incident.status === 'pr_draft'
            ? 'bg-amber/10 border-amber/20 border-l-amber'
            : 'bg-green/10 border-green/20 border-l-green'"
        >
          <p
            class="text-sm font-medium"
            :class="incident.status === 'pr_draft' ? 'text-amber' : 'text-green'"
          >
            {{ incident.status === 'pr_draft' ? 'Draft fix PR — verification pending' : 'Fix PR ready for review' }}
          </p>
          <p v-if="incident.status === 'pr_draft'" class="mt-1 text-xs text-amber">
            Opslane did not reach the ready-for-review evidence bar locally. Review the repository CI results before marking this PR ready.
          </p>
          <a
            :href="safeUrl(incident.pr_url)"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-1 inline-flex items-center font-medium hover:underline text-sm"
            :class="incident.status === 'pr_draft' ? 'text-amber' : 'text-green'"
            v-text="incident.pr_url"
          >
          </a>
        </div>

        <!-- Representative error payload -->
        <section
          v-if="sampleEvent || sampleEventError"
          data-testid="sample-event"
          class="p-4 bg-surface border border-border rounded-lg space-y-4"
        >
          <p v-if="sampleEventError" class="text-sm text-amber">
            Couldn't load stack trace.
          </p>
          <template v-if="sampleEvent">
            <div>
              <h3 class="text-xs font-medium text-text-muted uppercase tracking-wide">Stack trace</h3>
              <CodeBlock class="mt-2" :code="sampleEvent.error.stack" />
            </div>

            <div v-if="requestContext" class="space-y-2">
              <h3 class="text-xs font-medium text-text-muted uppercase tracking-wide">Request</h3>
              <dl class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt class="text-text-muted">Method</dt>
                  <dd class="text-text" v-text="requestContext.method || '—'"></dd>
                </div>
                <div>
                  <dt class="text-text-muted">Path</dt>
                  <dd class="text-text font-mono text-xs" v-text="requestContext.path || '—'"></dd>
                </div>
                <div v-if="requestContext.remote_addr">
                  <dt class="text-text-muted">Client IP</dt>
                  <dd class="text-text font-mono text-xs" v-text="requestContext.remote_addr"></dd>
                </div>
              </dl>
              <details v-if="requestContext.headers" class="text-sm">
                <summary class="cursor-pointer text-text-muted">Headers</summary>
                <dl class="mt-2 space-y-1 rounded bg-surface-2 p-3">
                  <div
                    v-for="header in requestContext.headers"
                    :key="header.name"
                    class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3"
                  >
                    <dt class="font-mono text-xs text-text-muted" v-text="header.name"></dt>
                    <dd class="break-all font-mono text-xs text-text" v-text="header.value"></dd>
                  </div>
                </dl>
              </details>
            </div>

            <div v-if="breadcrumbs.length" class="space-y-2">
              <h3 class="text-xs font-medium text-text-muted uppercase tracking-wide">Breadcrumbs</h3>
              <ol class="space-y-2">
                <li
                  v-for="(breadcrumb, index) in breadcrumbs"
                  :key="`${breadcrumb.timestamp || 'breadcrumb'}-${index}`"
                  class="rounded border border-border p-3 text-sm"
                >
                  <div class="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <time
                      v-if="breadcrumb.timestamp"
                      :datetime="breadcrumb.timestamp"
                      v-text="formatBreadcrumbTime(breadcrumb.timestamp)"
                    ></time>
                    <span
                      v-if="breadcrumb.label"
                      class="rounded-full bg-surface-2 px-2 py-0.5 text-text"
                      v-text="breadcrumb.label"
                    ></span>
                    <span v-if="breadcrumb.level" v-text="breadcrumb.level"></span>
                  </div>
                  <p v-if="breadcrumb.message" class="mt-1 text-text" v-text="breadcrumb.message"></p>
                </li>
              </ol>
            </div>
          </template>
        </section>

        <!-- Investigation results, including context preserved on drafts and needs_human -->
        <div
          v-if="(incident.status === 'investigated' || incident.status === 'awaiting_approval' || incident.status === 'fixing' || incident.status === 'pr_draft' || incident.status === 'needs_human') && incident.root_cause"
          class="p-4 bg-teal/10 border border-teal/20 border-l-2 border-l-teal rounded-lg space-y-3"
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

        <!-- Insight card (friction, no code cause — terminal, never a PR; design v4-4) -->
        <div
          v-if="incident.status === 'insight'"
          class="p-4 bg-purple/10 border border-purple/20 border-l-2 border-l-purple rounded-lg space-y-3"
        >
          <p class="text-sm font-medium text-purple">Insight — no code cause</p>
          <p class="text-xs text-text-muted">
            Opslane investigated this friction and found no code change that would fix it.
            No PR will be created; use the findings below to guide a product or UX change.
          </p>
          <div v-if="incident.root_cause">
            <p class="text-xs font-medium text-purple uppercase tracking-wide">What users hit</p>
            <pre
              class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
              v-text="incident.root_cause"
            ></pre>
          </div>
        </div>

        <!-- Fix trigger: errors when investigated; friction only when a human
             approval is awaited (awaiting_approval). Insight, candidates, and
             unchecked diagnostics never render fix controls. -->
        <div
          v-if="fixControlsVisible(incident.kind, incident.status)"
          class="p-4 bg-surface border border-border rounded-lg space-y-3"
        >
          <p v-if="incident.status === 'awaiting_approval'" class="text-xs text-text-muted">
            This friction fix has a code cause and is waiting for your approval.
            It will open a <strong>Suggestion</strong> PR — repo tests must pass,
            but the friction itself is not re-verified.
          </p>
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
              <span v-else>{{ incident.status === 'awaiting_approval' ? 'Generate fix' : 'Find Fix' }}</span>
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
          class="p-4 bg-indigo/10 border border-indigo/20 border-l-2 border-l-indigo rounded-lg"
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
          class="p-4 bg-amber/10 border border-amber/20 border-l-2 border-l-amber rounded-lg space-y-3"
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

        <EvidenceCard
          v-if="incident.verification_evidence"
          :evidence="incident.verification_evidence"
        />

        <!-- Candidate diff -->
        <div
          v-if="incident.status === 'needs_human' && incident.candidate_diff"
          class="p-4 bg-surface border border-border rounded-lg space-y-2"
        >
          <p class="text-xs font-medium text-text-muted uppercase tracking-wide">Candidate diff</p>
          <pre
            class="text-xs bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre text-text max-h-96"
            v-text="incident.candidate_diff"
          ></pre>
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
