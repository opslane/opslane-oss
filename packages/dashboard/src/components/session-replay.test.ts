import { describe, expect, it } from 'vitest';
import type { SessionChunkMeta } from '../types/api';
import {
  MAX_SEGMENT_CHUNKS,
  UNKNOWN_DECODED_BYTES,
  clampSeek,
  hasErrorWindowCoverage,
  pickErrorWindow,
  planSegments,
  stitchChunkEvents,
} from './session-replay';

const chunk = (seq: number, overrides: Partial<SessionChunkMeta> = {}): SessionChunkMeta => ({
  seq,
  decoded_size_bytes: 1,
  has_full_snapshot: true,
  first_event_ms: seq * 1_000,
  last_event_ms: seq * 1_000 + 999,
  ...overrides,
});

describe('stitchChunkEvents', () => {
  it('concatenates envelopes, drops malformed events, and sorts timestamps', () => {
    expect(stitchChunkEvents([
      { events: [{ type: 3, timestamp: 30 }, null, { type: 2 }] },
      { events: [{ type: 2, timestamp: 10 }, { type: '3', timestamp: 20 }] },
    ]).map((event) => event.timestamp)).toEqual([10, 30]);
  });
});

describe('planSegments', () => {
  it('partitions consecutive chunks on measured decoded bytes', () => {
    const result = planSegments([
      chunk(2, { decoded_size_bytes: 6 }),
      chunk(0, { decoded_size_bytes: 6 }),
      chunk(1, { decoded_size_bytes: 4 }),
    ], 10);
    expect(result.map((segment) => segment.map((item) => item.seq))).toEqual([[0, 1], [2]]);
  });

  it('charges unknown decoded sizes at the inflate limit', () => {
    expect(planSegments([
      chunk(0, { decoded_size_bytes: null }),
      chunk(1, { decoded_size_bytes: UNKNOWN_DECODED_BYTES }),
    ], UNKNOWN_DECODED_BYTES).map((segment) => segment.length)).toEqual([1, 1]);
  });

  it('enforces the hard count cap and keeps an oversized chunk alone', () => {
    const many = Array.from({ length: MAX_SEGMENT_CHUNKS + 1 }, (_, seq) => chunk(seq));
    expect(planSegments(many, 1_000).map((segment) => segment.length)).toEqual([8, 1]);
    expect(planSegments([chunk(0, { decoded_size_bytes: 100 }), chunk(1)], 10)
      .map((segment) => segment.map((item) => item.seq))).toEqual([[0], [1]]);
  });
});

describe('pickErrorWindow', () => {
  it('selects only chunks overlapping the error window and caps the result', () => {
    const chunks = Array.from({ length: 10 }, (_, seq) => chunk(seq, {
      first_event_ms: seq * 10_000,
      last_event_ms: seq * 10_000 + 9_999,
    }));
    const result = pickErrorWindow(chunks, 75_000, 3);
    expect(result.chunks).toHaveLength(3);
    expect(result.approximate).toBe(false);
    expect(hasErrorWindowCoverage(chunks, 75_000)).toBe(true);
  });

  it('falls back to the tail when bounds are missing or time is invalid', () => {
    const chunks = [0, 1, 2].map((seq) => chunk(seq, { first_event_ms: null, last_event_ms: null }));
    expect(pickErrorWindow(chunks, 1_500, 2)).toEqual({ chunks: chunks.slice(1), approximate: true });
    expect(pickErrorWindow(chunks, Number.NaN, 1)).toEqual({ chunks: [chunks[2]], approximate: true });
  });

  it('uses the nearest bounded chunk and neighbors when clocks do not overlap', () => {
    const chunks = [chunk(0), chunk(1), chunk(2), chunk(3)];
    const result = pickErrorWindow(chunks, 100_000, 3);
    expect(result.chunks.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(result.approximate).toBe(true);
    expect(hasErrorWindowCoverage(chunks, 100_000)).toBe(false);
  });
});

describe('clampSeek', () => {
  const events = [
    { type: 3, timestamp: 3_000, data: {} },
    { type: 2, timestamp: 1_000, data: {} },
  ] as never[];

  it('clamps targets into the event time range', () => {
    expect(clampSeek(events, 500)).toBe(1_000);
    expect(clampSeek(events, 2_000)).toBe(2_000);
    expect(clampSeek(events, 4_000)).toBe(3_000);
  });

  it('returns zero for invalid targets or empty streams', () => {
    expect(clampSeek(events, Number.NaN)).toBe(0);
    expect(clampSeek([], 1_000)).toBe(0);
  });
});
