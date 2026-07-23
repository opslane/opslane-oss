<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { formatDuration } from '../admin-format';
import ReplayPlayer from '../components/ReplayPlayer.vue';
import { useSessionPlayback } from '../composables/useSessionPlayback';
import { formatAbsolute, getProjectId, safeUrl } from '../utils';
import Button from '../components/ui/Button.vue';

const route = useRoute();
const projectId = getProjectId();
const sessionId = route.params['sessionId'] as string;
const rawSeek = Array.isArray(route.query['t']) ? route.query['t'][0] : route.query['t'];
const parsedSeek = typeof rawSeek === 'string' && rawSeek.trim() ? Number(rawSeek) : undefined;
const seekAtMs = parsedSeek !== undefined && Number.isFinite(parsedSeek) ? parsedSeek : undefined;

const {
  state,
  session,
  segments,
  activeSegment,
  events,
  seekMs,
  missingChunks,
  approximate,
  pollAttempt,
  pollsRemaining,
  error,
  loadSegment,
} = useSessionPlayback(projectId, sessionId, { windowed: false, seekAtMs });

const activeChunksLabel = computed(() => {
  const segment = segments.value[activeSegment.value];
  if (!segment?.length) return '';
  return `chunks ${segment[0].seq}\u2013${segment[segment.length - 1].seq}`;
});

function duration(): string {
  if (!session.value?.last_chunk_at) return formatDuration(null);
  const ms = new Date(session.value.last_chunk_at).getTime() - new Date(session.value.started_at).getTime();
  return formatDuration(ms / 1_000);
}
</script>

<template>
  <div>
    <router-link :to="{ name: 'sessions' }" class="text-accent hover:underline text-sm">&larr; Back to sessions</router-link>

    <div class="mt-4 flex flex-col gap-6 xl:flex-row">
      <section class="min-w-0 flex-1" aria-label="Session replay">
        <div v-if="state === 'loading'" class="text-muted">Loading session...</div>
        <div v-else-if="state === 'processing'" class="rounded-lg border border-warning/20 bg-warning/10 p-5">
          <p class="font-medium text-warning">Recording is still processing</p>
          <p class="mt-1 text-sm text-muted">Checking every 5 seconds (attempt {{ pollAttempt }}/24, {{ pollsRemaining }} remaining).</p>
        </div>
        <div v-else-if="state === 'error'" class="rounded-lg border border-danger/20 bg-danger/10 p-5 text-danger">
          <p v-text="error || 'Failed to load session.'"></p>
        </div>
        <div v-else-if="state === 'unavailable'" class="rounded-lg border border-border bg-surface p-5 text-muted">
          This recording is unavailable or contains no playable events.
        </div>
        <div v-else class="space-y-4">
          <div v-if="state === 'partial'" class="rounded-md border border-warning/20 bg-warning/10 p-3 text-sm text-warning">
            {{ missingChunks.missing }} of {{ missingChunks.total }} chunks unavailable. Playing the remaining recording.
          </div>
          <div v-if="approximate" class="text-sm text-warning">Playback position is approximate.</div>
          <ReplayPlayer :events="events" :crash-timestamp="seekMs" />

          <div v-if="segments.length > 1" class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
            <Button variant="secondary" :disabled="activeSegment === 0" @click="loadSegment(activeSegment - 1)">Previous segment</Button>
            <span class="text-sm text-muted">Segment {{ activeSegment + 1 }} of {{ segments.length }} &middot; {{ activeChunksLabel }}</span>
            <Button variant="secondary" :disabled="activeSegment === segments.length - 1" @click="loadSegment(activeSegment + 1)">Next segment</Button>
          </div>
        </div>
      </section>

      <aside v-if="session" class="w-full shrink-0 xl:w-72">
        <div class="rounded-lg border border-border bg-surface p-4">
          <h2 class="font-medium text-text">Session details</h2>
          <dl class="mt-4 space-y-3 text-sm">
            <div><dt class="text-faint">Started</dt><dd class="text-muted">{{ formatAbsolute(session.started_at) }}</dd></div>
            <div><dt class="text-faint">Duration</dt><dd class="text-muted">{{ duration() }}</dd></div>
            <div><dt class="text-faint">User</dt><dd class="text-muted" v-text="session.end_user?.email || session.end_user?.external_user_id || '\u2014'"></dd></div>
            <div><dt class="text-faint">Status</dt><dd class="text-muted" v-text="session.status.replace('_', ' ')"></dd></div>
            <div><dt class="text-faint">Chunks</dt><dd class="text-muted">{{ session.playable_chunk_count }}/{{ session.chunk_count }} playable</dd></div>
            <div>
              <dt class="text-faint">Page</dt>
              <dd>
                <a v-if="safeUrl(session.page_url ?? undefined)" :href="safeUrl(session.page_url ?? undefined)" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline break-all" v-text="session.page_url"></a>
                <span v-else class="text-muted">\u2014</span>
              </dd>
            </div>
          </dl>
        </div>
      </aside>
    </div>
  </div>
</template>
