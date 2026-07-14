import type { eventWithTime } from '@rrweb/types';

const ACTIVE_SOURCES = new Set([1, 2, 3, 4, 5, 6, 7, 9]);
const CRASH_TAIL_MS = 5000;

/** rrweb event types: 2 = FullSnapshot, 3 = IncrementalSnapshot, 4 = Meta. */
export function isActiveEvent(event: eventWithTime): boolean {
  if (event.type === 2 || event.type === 4) return true;
  if (event.type === 3 && event.data) {
    const source = (event.data as { source?: number }).source;
    return source !== undefined && ACTIVE_SOURCES.has(source);
  }
  return false;
}

export function sortedReplayEvents(events: eventWithTime[]): eventWithTime[] {
  return [...events].sort((a, b) => a.timestamp - b.timestamp);
}

export function replayDurationMs(events: eventWithTime[]): number {
  if (!events || events.length < 2) return 0;
  return Math.max(0, events[events.length - 1].timestamp - events[0].timestamp);
}

export function crashSeekMs(events: eventWithTime[], crashTimestamp?: number): number {
  const duration = replayDurationMs(events);
  if (duration <= 0) return 0;
  if (crashTimestamp === undefined) {
    return Math.max(0, duration - CRASH_TAIL_MS);
  }
  const offset = crashTimestamp - events[0].timestamp;
  return Math.min(Math.max(0, offset), duration);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
