import {
  computed,
  getCurrentScope,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue';
import type { eventWithTime } from '@rrweb/types';
import { APIError, getSession, getSessionChunk } from '../api';
import type { SessionChunkMeta, SessionDetail } from '../types/api';
import {
  clampSeek,
  hasErrorWindowCoverage,
  pickErrorWindow,
  planSegments,
  stitchChunkEvents,
  type ChunkEnvelope,
} from '../components/session-replay';

export const SESSION_POLL_INTERVAL_MS = 5_000;
export const MAX_SESSION_POLLS = 24;
const CHUNK_FETCH_CONCURRENCY = 4;

export type SessionPlaybackState =
  | 'loading'
  | 'processing'
  | 'ready'
  | 'partial'
  | 'unavailable'
  | 'error';

export interface MissingChunks {
  missing: number;
  total: number;
}

export interface SessionPlaybackOptions {
  /** Incident mode: fetch only the bounded window around this RFC3339 time. */
  errorAt?: MaybeRefOrGetter<string | undefined>;
  /** False for a full session, even when seekAtMs is provided by a deep link. */
  windowed?: boolean;
  /** Absolute event epoch milliseconds to seek within full-session playback. */
  seekAtMs?: MaybeRefOrGetter<number | undefined>;
}

interface FetchResult {
  envelope: ChunkEnvelope | null;
  failed: boolean;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => run()),
  );
  return results;
}

function segmentForTime(segments: SessionChunkMeta[][], target: number): number {
  if (!Number.isFinite(target) || segments.length === 0) return 0;
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  segments.forEach((segment, index) => {
    const bounds = segment.flatMap((chunk) => {
      const first = chunk.first_event_ms;
      const last = chunk.last_event_ms;
      return typeof first === 'number' && typeof last === 'number'
        ? [{ first: Math.min(first, last), last: Math.max(first, last) }]
        : [];
    });
    if (bounds.length === 0) return;
    const first = Math.min(...bounds.map((bound) => bound.first));
    const last = Math.max(...bounds.map((bound) => bound.last));
    if (target >= first && target <= last) {
      nearestIndex = index;
      nearestDistance = 0;
      return;
    }
    const distance = target < first ? first - target : target - last;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

export function useSessionPlayback(
  projectId: MaybeRefOrGetter<string>,
  sessionId: MaybeRefOrGetter<string>,
  opts: SessionPlaybackOptions = {},
) {
  const state = ref<SessionPlaybackState>('loading');
  const session = ref<SessionDetail | null>(null);
  const segments = ref<SessionChunkMeta[][]>([]);
  const activeSegment = ref(0);
  const events = ref<eventWithTime[]>([]);
  /** Absolute event timestamp; ReplayPlayer converts it to an offset. */
  const seekMs = ref<number | undefined>(undefined);
  const missingChunks = ref<MissingChunks>({ missing: 0, total: 0 });
  const approximate = ref(false);
  const pollAttempt = ref(0);
  const pollsRemaining = computed(() => Math.max(0, MAX_SESSION_POLLS - pollAttempt.value));
  const terminalUnavailable = ref(false);
  const error = ref<string | null>(null);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let loadSequence = 0;

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function reset(): void {
    stopPolling();
    generation++;
    loadSequence++;
    state.value = 'loading';
    session.value = null;
    segments.value = [];
    activeSegment.value = 0;
    events.value = [];
    seekMs.value = undefined;
    missingChunks.value = { missing: 0, total: 0 };
    approximate.value = false;
    pollAttempt.value = 0;
    terminalUnavailable.value = false;
    error.value = null;
  }

  async function loadChunks(
    chunks: SessionChunkMeta[],
    requestGeneration: number,
    loadToken: number,
  ): Promise<void> {
    const pid = toValue(projectId);
    const sid = toValue(sessionId);
    events.value = [];
    missingChunks.value = { missing: 0, total: chunks.length };

    const results = await mapConcurrent(chunks, CHUNK_FETCH_CONCURRENCY, async (chunk): Promise<FetchResult> => {
      try {
        return { envelope: await getSessionChunk(pid, sid, chunk.seq), failed: false };
      } catch {
        return { envelope: null, failed: true };
      }
    });
    if (requestGeneration !== generation || loadToken !== loadSequence) return;

    const failed = results.filter((result) => (
      result.failed
      || result.envelope === null
      || stitchChunkEvents([result.envelope]).length === 0
    )).length;
    const stitched = stitchChunkEvents(
      results.flatMap((result) => result.envelope ? [result.envelope] : []),
    );
    missingChunks.value = { missing: failed, total: chunks.length };
    events.value = stitched;
    if (stitched.length === 0) {
      state.value = 'unavailable';
      terminalUnavailable.value = true;
      return;
    }

    const target = opts.windowed
      ? Date.parse(toValue(opts.errorAt) ?? '')
      : toValue(opts.seekAtMs);
    seekMs.value = typeof target === 'number' && Number.isFinite(target)
      ? clampSeek(stitched, target)
      : stitched[0].timestamp;
    state.value = failed > 0 ? 'partial' : 'ready';
  }

  async function loadSegment(index: number): Promise<void> {
    if (index < 0 || index >= segments.value.length) return;
    const requestGeneration = generation;
    const loadToken = ++loadSequence;
    activeSegment.value = index;
    await loadChunks(segments.value[index], requestGeneration, loadToken);
  }

  function schedulePoll(requestGeneration: number): void {
    stopPolling();
    state.value = 'processing';
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (requestGeneration !== generation) return;
      pollAttempt.value++;
      void refresh(requestGeneration);
    }, SESSION_POLL_INTERVAL_MS);
  }

  async function acceptPlayable(
    detail: SessionDetail,
    requestGeneration: number,
    forcedApproximate = false,
  ): Promise<void> {
    if (opts.windowed) {
      const errorAtMs = Date.parse(toValue(opts.errorAt) ?? '');
      const picked = pickErrorWindow(detail.chunks, errorAtMs);
      approximate.value = forcedApproximate || picked.approximate;
      segments.value = picked.chunks.length > 0 ? [picked.chunks] : [];
      activeSegment.value = 0;
      if (picked.chunks.length === 0) {
        state.value = 'unavailable';
        terminalUnavailable.value = true;
        return;
      }
      await loadChunks(picked.chunks, requestGeneration, ++loadSequence);
      return;
    }

    approximate.value = false;
    segments.value = planSegments(detail.chunks);
    const target = toValue(opts.seekAtMs);
    const index = typeof target === 'number' ? segmentForTime(segments.value, target) : 0;
    activeSegment.value = index;
    await loadChunks(segments.value[index] ?? [], requestGeneration, ++loadSequence);
  }

  async function refresh(requestGeneration: number): Promise<void> {
    const pid = toValue(projectId);
    const sid = toValue(sessionId);
    if (!pid || !sid || requestGeneration !== generation) return;

    try {
      const detail = await getSession(pid, sid);
      if (requestGeneration !== generation) return;
      session.value = detail;
      const chunks = detail.chunks ?? [];

      if (!opts.windowed) {
        if (chunks.length > 0) {
          stopPolling();
          await acceptPlayable(detail, requestGeneration);
        } else if (pollAttempt.value >= MAX_SESSION_POLLS) {
          state.value = 'unavailable';
          terminalUnavailable.value = true;
        } else {
          schedulePoll(requestGeneration);
        }
        return;
      }

      const errorAtMs = Date.parse(toValue(opts.errorAt) ?? '');
      const covered = hasErrorWindowCoverage(chunks, errorAtMs);
      if (covered || (!Number.isFinite(errorAtMs) && chunks.length > 0)) {
        stopPolling();
        await acceptPlayable(detail, requestGeneration, !covered);
      } else if (pollAttempt.value >= MAX_SESSION_POLLS) {
        stopPolling();
        if (chunks.length > 0) {
          await acceptPlayable(detail, requestGeneration, true);
        } else {
          state.value = 'unavailable';
          terminalUnavailable.value = true;
        }
      } else {
        schedulePoll(requestGeneration);
      }
    } catch (caught: unknown) {
      if (requestGeneration !== generation) return;
      stopPolling();
      error.value = caught instanceof Error ? caught.message : String(caught);
      if (caught instanceof APIError && caught.status === 404) {
        state.value = 'unavailable';
        terminalUnavailable.value = true;
      } else {
        state.value = 'error';
      }
    }
  }

  watch(
    () => [
      toValue(projectId),
      toValue(sessionId),
      toValue(opts.errorAt),
      toValue(opts.seekAtMs),
    ] as const,
    ([pid, sid]) => {
      reset();
      if (pid && sid) void refresh(generation);
    },
    { immediate: true },
  );

  if (getCurrentScope()) onScopeDispose(() => {
    generation++;
    stopPolling();
  });

  return {
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
    terminalUnavailable,
    error,
    loadSegment,
    stopPolling,
  };
}
