import type { eventWithTime } from '@rrweb/types';
import type { SessionChunkMeta } from '../types/api';

export interface ChunkEnvelope {
  events: unknown[];
  meta?: Record<string, unknown>;
}

/** A segment is bounded by measured decoded bytes, not compressed size. */
export const SEGMENT_BUDGET_BYTES = 64 * 1024 * 1024;
export const UNKNOWN_DECODED_BYTES = 20 * 1024 * 1024;
/** This cap remains effective even when stored decoded sizes are inaccurate. */
export const MAX_SEGMENT_CHUNKS = 8;

const ERROR_WINDOW_BEFORE_MS = 60_000;
const ERROR_WINDOW_AFTER_MS = 10_000;

function isReplayEvent(value: unknown): value is eventWithTime {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; timestamp?: unknown };
  return (
    typeof candidate.type === 'number'
    && Number.isFinite(candidate.type)
    && typeof candidate.timestamp === 'number'
    && Number.isFinite(candidate.timestamp)
  );
}

function orderedChunks(chunks: SessionChunkMeta[]): SessionChunkMeta[] {
  return [...chunks].sort((a, b) => a.seq - b.seq);
}

function validBounds(chunk: SessionChunkMeta): { first: number; last: number } | null {
  const first = chunk.first_event_ms;
  const last = chunk.last_event_ms;
  if (
    typeof first !== 'number'
    || typeof last !== 'number'
    || !Number.isFinite(first)
    || !Number.isFinite(last)
  ) {
    return null;
  }
  return first <= last ? { first, last } : { first: last, last: first };
}

export function stitchChunkEvents(chunks: ChunkEnvelope[]): eventWithTime[] {
  return chunks
    .flatMap((chunk) => Array.isArray(chunk.events) ? chunk.events : [])
    .filter(isReplayEvent)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function decodedCharge(chunk: SessionChunkMeta): number {
  const size = chunk.decoded_size_bytes;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0
    ? size
    : UNKNOWN_DECODED_BYTES;
}

export function planSegments(
  chunks: SessionChunkMeta[],
  budgetBytes = SEGMENT_BUDGET_BYTES,
): SessionChunkMeta[][] {
  const segments: SessionChunkMeta[][] = [];
  let current: SessionChunkMeta[] = [];
  let currentBytes = 0;
  const budget = Math.max(0, budgetBytes);

  for (const chunk of orderedChunks(chunks)) {
    const charge = decodedCharge(chunk);
    if (
      current.length > 0
      && (current.length >= MAX_SEGMENT_CHUNKS || currentBytes + charge > budget)
    ) {
      segments.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(chunk);
    currentBytes += charge;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export interface ErrorWindow {
  chunks: SessionChunkMeta[];
  approximate: boolean;
}

export function hasErrorWindowCoverage(
  chunks: SessionChunkMeta[],
  errorAtMs: number,
): boolean {
  if (!Number.isFinite(errorAtMs)) return false;
  const windowStart = errorAtMs - ERROR_WINDOW_BEFORE_MS;
  const windowEnd = errorAtMs + ERROR_WINDOW_AFTER_MS;
  return chunks.some((chunk) => {
    const bounds = validBounds(chunk);
    return bounds !== null && bounds.last >= windowStart && bounds.first <= windowEnd;
  });
}

function distanceToBounds(errorAtMs: number, bounds: { first: number; last: number }): number {
  if (errorAtMs < bounds.first) return bounds.first - errorAtMs;
  if (errorAtMs > bounds.last) return errorAtMs - bounds.last;
  return 0;
}

function neighborWindow(
  chunks: SessionChunkMeta[],
  center: number,
  max: number,
): SessionChunkMeta[] {
  const count = Math.min(max, chunks.length);
  let start = Math.max(0, center - Math.floor((count - 1) / 2));
  start = Math.min(start, chunks.length - count);
  return chunks.slice(start, start + count);
}

export function pickErrorWindow(
  chunks: SessionChunkMeta[],
  errorAtMs: number,
  max = 6,
): ErrorWindow {
  const ordered = orderedChunks(chunks);
  const limit = Math.max(0, Math.floor(max));
  if (ordered.length === 0 || limit === 0) return { chunks: [], approximate: false };

  const bounded = ordered.map((chunk) => validBounds(chunk));
  if (!Number.isFinite(errorAtMs)) {
    return { chunks: ordered.slice(-limit), approximate: true };
  }

  const windowStart = errorAtMs - ERROR_WINDOW_BEFORE_MS;
  const windowEnd = errorAtMs + ERROR_WINDOW_AFTER_MS;
  const overlaps = ordered.filter((_, index) => {
    const bounds = bounded[index];
    return bounds !== null && bounds.last >= windowStart && bounds.first <= windowEnd;
  });
  if (overlaps.length > 0) {
    if (overlaps.length <= limit) return { chunks: overlaps, approximate: false };
    const closest = overlaps
      .map((chunk) => ({ chunk, bounds: validBounds(chunk)! }))
      .sort((a, b) => distanceToBounds(errorAtMs, a.bounds) - distanceToBounds(errorAtMs, b.bounds))
      .slice(0, limit)
      .map(({ chunk }) => chunk)
      .sort((a, b) => a.seq - b.seq);
    return { chunks: closest, approximate: false };
  }

  if (bounded.some((bounds) => bounds === null)) {
    return { chunks: ordered.slice(-limit), approximate: true };
  }

  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  bounded.forEach((bounds, index) => {
    const distance = distanceToBounds(errorAtMs, bounds!);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return {
    chunks: neighborWindow(ordered, nearestIndex, limit),
    approximate: true,
  };
}

export function clampSeek(events: eventWithTime[], tMs: number): number {
  if (!Number.isFinite(tMs) || events.length === 0) return 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (!Number.isFinite(event.timestamp)) continue;
    first = Math.min(first, event.timestamp);
    last = Math.max(last, event.timestamp);
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.min(Math.max(tMs, first), last);
}
