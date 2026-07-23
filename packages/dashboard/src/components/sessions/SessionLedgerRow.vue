<script setup lang="ts">
import { computed, ref } from 'vue';
import { format } from 'date-fns';
import type { SessionSummary } from '../../types/api';
import { formatDuration } from '../../admin-format';
import {
  frictionSignalRecipe,
  sessionStatusRecipe,
  type StatusRecipe,
} from '../../status-recipes';
import { safeUrl } from '../../utils';
import StatusLabel from '../ui/StatusLabel.vue';

const props = defineProps<{
  session: SessionSummary;
}>();

const copied = ref(false);

const displayName = computed(() =>
  props.session.end_user?.email
  ?? props.session.end_user?.external_user_id
  ?? 'Anonymous');

const isAnonymous = computed(() => !props.session.end_user);
const startedLabel = computed(() => {
  const date = new Date(props.session.started_at);
  return Number.isNaN(date.getTime()) ? '\u2014' : format(date, 'MMM d, h:mm a');
});
const durationLabel = computed(() => {
  if (!props.session.last_chunk_at) return formatDuration(null);
  const elapsed = new Date(props.session.last_chunk_at).getTime()
    - new Date(props.session.started_at).getTime();
  return formatDuration(elapsed / 1_000);
});
const releaseLabel = computed(() => {
  const release = props.session.sdk_release?.trim();
  if (!release) return null;
  return release.startsWith('v') ? release : `v${release}`;
});
const metadataSegments = computed(() => {
  const result: Array<{ text: string; mono?: boolean; accessibleLabel?: string }> = [];
  if (isAnonymous.value) {
    result.push({
      text: props.session.id.slice(-8),
      mono: true,
      accessibleLabel: `Session ID ${props.session.id}`,
    });
  }
  const account = props.session.end_user?.account_name
    ?? props.session.end_user?.external_account_id;
  if (account) result.push({ text: account });
  if (releaseLabel.value) result.push({ text: releaseLabel.value });
  return result;
});
const pagePath = computed(() => {
  const value = safeUrl(props.session.page_url ?? undefined);
  if (!value) return null;
  const parsed = new URL(value);
  return `${parsed.pathname}${parsed.search}`;
});

const signals = computed<StatusRecipe[]>(() => {
  const result: StatusRecipe[] = [];
  if (props.session.error_count > 0) {
    result.push(frictionSignalRecipe('error', props.session.error_count));
  }
  if (props.session.rage_click_count > 0) {
    result.push(frictionSignalRecipe('rage_click', props.session.rage_click_count));
  }
  if (props.session.dead_click_count > 0) {
    result.push(frictionSignalRecipe('dead_click', props.session.dead_click_count));
  }
  if (props.session.form_abandon_count > 0) {
    result.push(frictionSignalRecipe('form_abandon', props.session.form_abandon_count));
  }

  switch (props.session.status) {
    case 'recording':
      result.push(frictionSignalRecipe('recording'));
      break;
    case 'closed':
      result.push(frictionSignalRecipe('queued'));
      break;
    case 'analyzing':
      result.push(frictionSignalRecipe('analyzing'));
      break;
    case 'analysis_failed':
      result.push(frictionSignalRecipe('analysis_failed'));
      break;
    case 'deleting':
      result.push(sessionStatusRecipe('deleting'));
      break;
    case 'analyzed':
      break;
  }
  return result;
});

const unavailableLabel = computed(() => {
  if (['recording', 'closed', 'analyzing'].includes(props.session.status)) return 'Processing';
  if (props.session.status === 'analysis_failed' || props.session.chunk_count > 0) return 'Unavailable';
  return 'No recording';
});

const playbackLabel = computed(() =>
  `Play session for ${displayName.value}, ${durationLabel.value}, ${startedLabel.value}`);

async function copySessionId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.session.id);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 2_000);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <tr class="group border-b border-border last:border-b-0 hover:bg-surface-subtle">
    <td class="min-w-0 px-2 py-3 sm:px-4">
      <div class="flex min-w-0 items-start">
        <router-link
          v-if="session.playable_chunk_count > 0"
          :to="{ name: 'session-detail', params: { sessionId: session.id } }"
          :aria-label="playbackLabel"
          class="flex min-w-0 flex-1 items-start gap-2 text-text no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span class="flex size-11 shrink-0 items-center justify-center border border-border-strong bg-surface text-text" aria-hidden="true">
            <span class="ml-0.5 text-base">▶</span>
          </span>
          <span class="min-w-0 pt-0.5">
            <span
              class="block truncate text-sm font-semibold leading-5 decoration-accent underline-offset-4 hover:text-accent hover:underline"
              v-text="displayName"
            ></span>
            <span class="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <template v-for="(segment, index) in metadataSegments" :key="`${segment.text}-${index}`">
                <span v-if="index > 0" aria-hidden="true">·</span>
                <span
                  class="max-w-40 truncate"
                  :class="segment.mono ? 'font-mono' : ''"
                  :aria-label="segment.accessibleLabel"
                  v-text="segment.text"
                ></span>
              </template>
              <span v-if="pagePath && metadataSegments.length" class="hidden lg:inline" aria-hidden="true">·</span>
              <span v-if="pagePath" class="hidden min-w-0 max-w-48 truncate lg:inline" v-text="pagePath"></span>
              <span v-if="metadataSegments.length" class="sm:hidden" aria-hidden="true">·</span>
              <span class="sm:hidden" v-text="durationLabel"></span>
            </span>
            <span v-if="signals.length" class="mt-2 flex flex-wrap gap-1.5 sm:hidden">
              <StatusLabel
                v-for="signal in signals"
                :key="signal.label"
                :tone="signal.tone"
                :label="signal.label"
              />
            </span>
          </span>
        </router-link>

        <span
          v-else
          aria-disabled="true"
          :title="unavailableLabel"
          class="flex min-w-0 flex-1 items-start gap-2 text-text"
        >
          <span class="flex size-11 shrink-0 items-center justify-center border border-border bg-surface-subtle text-faint" aria-hidden="true">
            <span class="ml-0.5 text-base">▶</span>
          </span>
          <span class="min-w-0 pt-0.5">
            <span class="block truncate text-sm font-semibold leading-5" v-text="displayName"></span>
            <span class="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <template v-for="(segment, index) in metadataSegments" :key="`${segment.text}-${index}`">
                <span v-if="index > 0" aria-hidden="true">·</span>
                <span
                  class="max-w-40 truncate"
                  :class="segment.mono ? 'font-mono' : ''"
                  :aria-label="segment.accessibleLabel"
                  v-text="segment.text"
                ></span>
              </template>
              <span v-if="pagePath && metadataSegments.length" class="hidden lg:inline" aria-hidden="true">·</span>
              <span v-if="pagePath" class="hidden min-w-0 max-w-48 truncate lg:inline" v-text="pagePath"></span>
              <span v-if="metadataSegments.length" class="sm:hidden" aria-hidden="true">·</span>
              <span class="sm:hidden" v-text="durationLabel"></span>
            </span>
            <span v-if="signals.length" class="mt-2 flex flex-wrap gap-1.5 sm:hidden">
              <StatusLabel
                v-for="signal in signals"
                :key="signal.label"
                :tone="signal.tone"
                :label="signal.label"
              />
            </span>
          </span>
        </span>

        <button
          type="button"
          aria-label="Copy session ID"
          :title="copied ? 'Session ID copied' : 'Copy session ID'"
          class="ml-1 flex size-9 shrink-0 items-center justify-center text-muted opacity-100 hover:bg-surface-subtle hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          @click="copySessionId"
        >
          <span aria-hidden="true">{{ copied ? '✓' : '⧉' }}</span>
        </button>
      </div>
    </td>
    <td class="hidden px-3 py-3 align-middle sm:table-cell sm:px-4">
      <div v-if="signals.length" class="flex flex-wrap gap-1.5">
        <StatusLabel
          v-for="signal in signals"
          :key="signal.label"
          :tone="signal.tone"
          :label="signal.label"
        />
      </div>
    </td>
    <td class="px-2 py-3 align-middle sm:px-4">
      <time :datetime="session.started_at" class="block whitespace-nowrap text-sm font-medium text-text">
        {{ startedLabel }}
      </time>
      <span class="mt-1.5 hidden text-xs text-muted sm:block" v-text="durationLabel"></span>
    </td>
  </tr>
</template>
