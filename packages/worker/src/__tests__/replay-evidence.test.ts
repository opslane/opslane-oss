import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  buildReplayEvidenceFromRecording,
  fetchChunkViaIngestion,
  pickEvidenceChunks,
  waitForErrorWindowCoverage,
} from '../replay-evidence.js';
import type { SessionChunkMeta } from '../db.js';

// Minimal rrweb-shaped recording: a page with a heading + button, the user clicks
// the button, then a crash. Mirrors the real captured shape (node.type 2=Element,
// 3=Text; incremental source 2 = MouseInteraction, data.type 2 = Click).
function sampleRecording() {
  const node = {
    type: 0, id: 1, childNodes: [
      { type: 2, tagName: 'html', id: 2, attributes: {}, childNodes: [
        { type: 2, tagName: 'body', id: 3, attributes: {}, childNodes: [
          { type: 2, tagName: 'div', id: 4, attributes: { id: 'app' }, childNodes: [
            { type: 2, tagName: 'h1', id: 5, attributes: {}, childNodes: [{ type: 3, id: 6, textContent: 'Eval Demo' }] },
            { type: 2, tagName: 'button', id: 16, attributes: { 'data-testid': 'crash-btn' }, childNodes: [{ type: 3, id: 17, textContent: 'Load user profile' }] },
          ] },
        ] },
      ] },
    ],
  };
  return {
    meta: { crash_timestamp: 1000, page_url: 'http://localhost:5173/users/2' },
    events: [
      { type: 4, data: { href: 'http://localhost:5173/users/2' }, timestamp: 800 },
      { type: 2, data: { node }, timestamp: 810 },
      { type: 3, data: { source: 2, type: 2, id: 16 }, timestamp: 900 }, // click button
      { type: 3, data: { source: 0, adds: [{ parentId: 4, node: { type: 2, tagName: 'div', id: 20, attributes: { class: 'user-card' }, childNodes: [{ type: 3, id: 21, textContent: 'No profile' }] } }] }, timestamp: 990 },
    ],
  };
}

describe('buildReplayEvidenceFromRecording', () => {
  it('returns null for an empty recording', () => {
    expect(buildReplayEvidenceFromRecording({ events: [] }, null)).toBeNull();
  });

  it('extracts route, visible UI, last user action, and crash DOM from rrweb events', () => {
    const ev = buildReplayEvidenceFromRecording(sampleRecording(), {
      errorType: 'TypeError',
      errorMessage: "Cannot read properties of null (reading 'profile')",
    });
    expect(ev).not.toBeNull();
    // route + visible UI
    expect(ev!.whatUserSaw).toContain('localhost:5173/users/2');
    expect(ev!.whatUserSaw).toContain('Load user profile');
    // the click is reconstructed and attributed to the button
    expect(ev!.failureMoment.toLowerCase()).toContain('clicked');
    expect(ev!.failureMoment).toContain('Load user profile');
    // crash DOM addition (the user-card that rendered) shows up
    expect(ev!.failureMoment).toContain('No profile');
    // error surfaced in uxImpact
    expect(ev!.uxImpact).toContain('TypeError');
    expect(ev!.confidence).toBe('high');
  });

  it('ignores events after crash_timestamp', () => {
    const rec = sampleRecording();
    rec.events.push({ type: 3, data: { source: 2, type: 2, id: 16 }, timestamp: 5000 } as never);
    const ev = buildReplayEvidenceFromRecording(rec, null);
    // only the one pre-crash click is counted
    expect(ev!.failureMoment).toContain('1 user action');
  });

  it('resolves reused node ids against their own full-snapshot epoch', () => {
    const snapshot = (label: string, timestamp: number) => ({
      type: 2,
      timestamp,
      data: { node: { type: 0, id: 1, childNodes: [{
        type: 2, tagName: 'button', id: 42, childNodes: [{ type: 3, id: 43, textContent: label }],
      }] } },
    });
    const recording = {
      meta: { crash_timestamp: 300 },
      events: [
        snapshot('Save', 100),
        { type: 3, timestamp: 150, data: { source: 2, type: 2, id: 42 } },
        snapshot('Delete', 200),
        { type: 3, timestamp: 250, data: { source: 2, type: 2, id: 42 } },
      ],
    };

    const evidence = buildReplayEvidenceFromRecording(recording, null);
    expect(evidence?.failureMoment).toContain('clicked button "Save"');
    expect(evidence?.failureMoment).toContain('clicked button "Delete"');
  });

  it('indexes mutation additions and removes their full subtree', () => {
    const recording = {
      meta: { crash_timestamp: 400 },
      events: [
        { type: 2, timestamp: 100, data: { node: { type: 0, id: 1, childNodes: [] } } },
        {
          type: 3,
          timestamp: 150,
          data: {
            source: 0,
            adds: [{
              node: {
                type: 2,
                tagName: 'div',
                id: 50,
                childNodes: [{
                  type: 2,
                  tagName: 'button',
                  id: 51,
                  childNodes: [{ type: 3, id: 52, textContent: 'Confirm' }],
                }],
              },
            }],
          },
        },
        { type: 3, timestamp: 200, data: { source: 2, type: 2, id: 51 } },
        { type: 3, timestamp: 250, data: { source: 0, removes: [{ id: 50 }] } },
        { type: 3, timestamp: 300, data: { source: 2, type: 2, id: 51 } },
      ],
    };

    const evidence = buildReplayEvidenceFromRecording(recording, null);
    expect(evidence?.failureMoment).toContain('clicked button "Confirm"');
    expect(evidence?.failureMoment).toContain('clicked an element');
  });
});

function chunk(seq: number, first: number | null, last: number | null): SessionChunkMeta {
  return {
    seq,
    size_bytes: 100,
    decoded_size_bytes: 1000,
    has_full_snapshot: true,
    first_event_ms: first,
    last_event_ms: last,
  };
}

describe('session pointer evidence helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['INGESTION_BASE_URL'];
    delete process.env['INTERNAL_READ_TOKEN'];
  });

  it('selects overlapping chunks and falls back to the tail when bounds are missing', () => {
    const chunks = [chunk(0, 1_000, 2_000), chunk(1, 50_000, 60_000), chunk(2, 90_000, 100_000)];
    expect(pickEvidenceChunks(chunks, 95_000).map((item) => item.seq)).toEqual([1, 2]);
    expect(pickEvidenceChunks(chunks.map((item) => ({ ...item, first_event_ms: null, last_event_ms: null })), 65_000, 2)
      .map((item) => item.seq)).toEqual([1, 2]);
  });

  it('uses the nearest bounded chunk and neighbors when clocks do not overlap', () => {
    const chunks = [chunk(0, 1_000, 2_000), chunk(1, 3_000, 4_000), chunk(2, 5_000, 6_000), chunk(3, 7_000, 8_000)];
    expect(pickEvidenceChunks(chunks, 100_000, 3).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('caps overlapping chunks by distance to the error instead of taking the earliest', () => {
    const chunks = [
      chunk(0, 40_000, 45_000),
      chunk(1, 50_000, 55_000),
      chunk(2, 60_000, 65_000),
      chunk(3, 70_000, 75_000),
      chunk(4, 80_000, 85_000),
      chunk(5, 90_000, 95_000),
      chunk(6, 100_000, 105_000),
      chunk(7, 105_000, 110_000),
    ];

    expect(pickEvidenceChunks(chunks, 100_000, 6).map((item) => item.seq)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('uses the tail when no overlap exists and any chunk has missing bounds', () => {
    const chunks = [chunk(0, 90_000, 91_000), chunk(1, null, null), chunk(2, 1_000, 2_000)];
    expect(pickEvidenceChunks(chunks, 1_000_000, 2).map((item) => item.seq)).toEqual([1, 2]);
  });

  it('still selects bounded overlaps when other chunks have missing bounds', () => {
    const chunks = [chunk(0, null, null), chunk(1, 50_000, 60_000), chunk(2, null, null)];
    expect(pickEvidenceChunks(chunks, 55_000, 2).map((item) => item.seq)).toEqual([1]);
  });

  it('waits for error-window coverage rather than accepting older playable chunks', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce([chunk(0, 1_000, 2_000)])
      .mockResolvedValueOnce([chunk(0, 1_000, 2_000)])
      .mockResolvedValueOnce([chunk(0, 1_000, 2_000), chunk(1, 70_000, 80_000)]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForErrorWindowCoverage('sess', 'proj', 75_000, {
      attempts: 5,
      intervalMs: 15_000,
      load,
      sleep,
    });

    expect(load).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.map((item) => item.seq)).toEqual([0, 1]);
  });

  it('returns the latest approximate footage after five total attempts', async () => {
    const load = vi.fn().mockResolvedValue([chunk(0, 1_000, 2_000)]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForErrorWindowCoverage('sess', 'proj', 1_000_000, { load, sleep });

    expect(load).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(result).toHaveLength(1);
  });

  it('fetches decoded chunks through ingestion with encoded ids and the internal token', async () => {
    process.env['INGESTION_BASE_URL'] = 'http://ingestion:8080/';
    process.env['INTERNAL_READ_TOKEN'] = 'secret';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events: [{ type: 2, timestamp: 123, data: {} }],
      meta: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const envelope = await fetchChunkViaIngestion('project/a', 'session b', 3);

    expect(envelope?.events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ingestion:8080/internal/v1/projects/project%2Fa/sessions/session%20b/chunks/3',
      { headers: { 'X-Internal-Token': 'secret' } },
    );
  });

  it('skips non-successful chunk responses', async () => {
    process.env['INGESTION_BASE_URL'] = 'http://ingestion:8080';
    process.env['INTERNAL_READ_TOKEN'] = 'secret';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));
    await expect(fetchChunkViaIngestion('proj', 'sess', 9)).resolves.toBeNull();
  });
});
