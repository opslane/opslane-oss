import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType, type eventWithTime } from '@rrweb/types';
import type { ErrorEventPayload } from '@opslane/shared';
import { addBreadcrumb, clearBreadcrumbs } from '../breadcrumbs';
import { loadConfig, resetConfig } from '../config';
import { enqueueEvent, flushEvents, _resetQueue } from '../transport';
import { _resetThrottle } from '../throttle';
import {
  _resetReplayState,
  snapshotRrwebEvents,
  startReplayCapture,
  stopReplayCapture,
  uploadReplayForTrigger,
} from '../replay';

type RecordOptions = {
  emit?: (event: eventWithTime, isCheckout?: boolean) => void;
  checkoutEveryNms?: number;
  maskAllInputs?: boolean;
  maskTextSelector?: string;
  blockSelector?: string;
  recordCanvas?: boolean;
};

const rrwebState = vi.hoisted(() => {
  const state = {
    options: undefined as unknown,
    stop: vi.fn(),
    record: vi.fn(),
  };
  state.record.mockImplementation((options: unknown) => {
    state.options = options;
    return state.stop;
  });
  return state;
});

vi.mock('rrweb', () => ({
  record: rrwebState.record,
}));

function installRecordMock(): void {
  rrwebState.options = undefined;
  rrwebState.stop.mockClear();
  rrwebState.record.mockReset();
  rrwebState.record.mockImplementation((options: unknown) => {
    rrwebState.options = options;
    return rrwebState.stop;
  });
}

function recordOptions(): RecordOptions {
  expect(rrwebState.options).toBeTruthy();
  return rrwebState.options as RecordOptions;
}

function emit(event: eventWithTime, isCheckout?: boolean): void {
  const options = recordOptions();
  expect(typeof options.emit).toBe('function');
  options.emit?.(event, isCheckout);
}

function fullSnapshot(timestamp: number): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp,
    data: {
      node: { id: 1, type: 0, childNodes: [] },
      initialOffset: { top: 0, left: 0 },
    },
  } as unknown as eventWithTime;
}

function customEvent(timestamp: number, payload: Record<string, unknown> = {}): eventWithTime {
  return {
    type: EventType.Custom,
    timestamp,
    data: {
      tag: 'opslane.test',
      payload,
    },
  } as eventWithTime;
}

function makeEvent(overrides?: Partial<ErrorEventPayload>): ErrorEventPayload {
  return {
    timestamp: new Date().toISOString(),
    error: {
      type: 'TypeError',
      message: 'Cannot read properties of null',
      stack: 'TypeError: Cannot read properties of null\n at UserCard.vue:8:20',
    },
    breadcrumbs: [],
    context: {
      url: 'http://localhost:4173/user',
      user_agent: 'vitest',
    },
    sdk_version: '0.2.0',
    ...overrides,
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForFetchCallCount(count: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (fetchMockCallCount() >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function fetchMockCallCount(): number {
  return vi.mocked(globalThis.fetch).mock.calls.length;
}

describe('rrweb replay capture', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    installRecordMock();
    _resetQueue();
    _resetThrottle();
    _resetReplayState();
    clearBreadcrumbs();
    resetConfig();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    stopReplayCapture();
    _resetQueue();
    _resetReplayState();
    clearBreadcrumbs();
    resetConfig();
    vi.restoreAllMocks();
  });

  it('does not start rrweb when replay is disabled', async () => {
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: 'key-abc' });

    await startReplayCapture();

    expect(rrwebState.record).not.toHaveBeenCalled();
    expect(snapshotRrwebEvents()).toEqual([]);
  });

  it('lazy-loads and starts rrweb with fixed C4 masking options', async () => {
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: 'key-abc', replay: { enabled: true } });

    await startReplayCapture();

    expect(rrwebState.record).toHaveBeenCalledTimes(1);
    expect(recordOptions()).toMatchObject({
      checkoutEveryNms: 30_000,
      maskAllInputs: true,
      maskTextSelector: '.opslane-mask',
      blockSelector: '.opslane-block',
      recordCanvas: false,
    });
  });

  it('keeps two rrweb windows and preserves a full snapshot at the start', async () => {
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: 'key-abc', replay: { enabled: true } });
    await startReplayCapture();

    emit(fullSnapshot(1_000), true);
    emit(customEvent(1_100, { phase: 'first-window' }));
    emit(fullSnapshot(31_000), true);
    emit(customEvent(31_100, { phase: 'second-window' }));

    const events = snapshotRrwebEvents();
    expect(events).toHaveLength(4);
    expect(events[0]?.type).toBe(EventType.FullSnapshot);
    expect(events[2]?.type).toBe(EventType.FullSnapshot);
  });

  it('drops the older window whole when the combined recording exceeds the SDK byte cap', async () => {
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: 'key-abc', replay: { enabled: true } });
    await startReplayCapture();

    emit(fullSnapshot(1_000), true);
    emit(customEvent(1_100, { body: 'x'.repeat(2 * 1024 * 1024) }));
    emit(fullSnapshot(31_000), true);
    emit(customEvent(31_100, { phase: 'survives' }));

    const events = snapshotRrwebEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.timestamp).toBe(31_000);
    expect(events[0]?.type).toBe(EventType.FullSnapshot);
    expect(events[1]?.timestamp).toBe(31_100);
  });

  it('uploads recording.json and completes with breadcrumb-derived C4 signals', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_717_000_045_000);
    window.history.replaceState({}, '', '/dashboard?token=secret#access_token=abc');
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: 'key-abc', replay: { enabled: true } });
    await startReplayCapture();
    emit(fullSnapshot(1_717_000_000_000), true);
    emit(customEvent(1_717_000_001_000, { click: 'submit' }));
    addBreadcrumb({
      type: 'console',
      timestamp: new Date().toISOString(),
      category: 'console',
      level: 'error',
      message: 'render failed',
    });
    addBreadcrumb({
      type: 'fetch',
      timestamp: new Date().toISOString(),
      category: 'http',
      level: 'error',
      message: 'POST /api/users failed',
      data: { method: 'POST', url: 'https://api.example.com/users?token=secret', status_code: 500 },
    });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        replay_id: 'replay-1',
        upload_url: 'https://s3.example.com/upload',
        upload_headers: { 'x-amz-meta-test': '1' },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await uploadReplayForTrigger({
      triggerType: 'uncaught_error',
      errorType: 'TypeError',
      errorMessage: 'Cannot read properties of null',
      eventId: 'event-1',
      errorGroupId: 'group-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const initCall = fetchMock.mock.calls[0];
    expect(String(initCall?.[0])).toBe('https://ingest.example.com/api/v1/replays/init');
    const initBody = JSON.parse(String(initCall?.[1]?.body || '{}'));
    expect(initBody).toEqual({
      session_id: expect.any(String),
      error_event_id: 'event-1',
      error_group_id: 'group-1',
      trigger_type: 'uncaught_error',
      page_url: 'http://localhost:3000/dashboard',
      started_at: '2024-05-29T16:26:40.000Z',
      ended_at: '2024-05-29T16:27:25.000Z',
    });
    expect(initBody).not.toHaveProperty('masking_profile');
    expect(initBody).not.toHaveProperty('content_type');

    const uploadCall = fetchMock.mock.calls[1];
    expect(String(uploadCall?.[0])).toBe('https://s3.example.com/upload');
    expect(uploadCall?.[1]?.method).toBe('PUT');
    expect(uploadCall?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-amz-meta-test': '1',
    });
    const recording = JSON.parse(String(uploadCall?.[1]?.body || '{}'));
    expect(recording.events).toHaveLength(2);
    expect(recording.events[0].type).toBe(EventType.FullSnapshot);
    expect(recording.meta).toEqual({
      sdk_version: expect.any(String),
      page_url: 'http://localhost:3000/dashboard',
      started_at: 1_717_000_000_000,
      ended_at: 1_717_000_045_000,
      crash_timestamp: 1_717_000_045_000,
    });

    const completeCall = fetchMock.mock.calls[2];
    expect(String(completeCall?.[0])).toBe('https://ingest.example.com/api/v1/replays/replay-1/complete');
    const completeBody = JSON.parse(String(completeCall?.[1]?.body || '{}'));
    expect(completeBody).not.toHaveProperty('artifacts');
    expect(completeBody).not.toHaveProperty('content_type');
    expect(completeBody).toMatchObject({
      size_bytes: expect.any(Number),
      signals: {
        console: {
          error_count: 1,
          warning_count: 0,
          error_messages: ['render failed'],
          warning_messages: [],
        },
        network: {
          anomaly_count: 1,
          anomalies: [{
            type: 'fetch',
            method: 'POST',
            url: 'https://api.example.com/users?token=secret',
            status_code: 500,
            message: 'POST /api/users failed',
          }],
        },
      },
    });
  });

  it('uploads replay for uncaught_error trigger after event ingestion', async () => {
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: 'key-abc', replay: { enabled: true } });
    await startReplayCapture();
    emit(fullSnapshot(1_717_000_000_000), true);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ event_id: 'event-1', error_group_id: 'group-1' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ replay_id: 'replay-1', upload_url: 'https://s3.example.com/upload', upload_headers: {} }), { status: 201 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    enqueueEvent(makeEvent(), 'uncaught_error');
    await flushEvents();
    await drainMicrotasks();
    await waitForFetchCallCount(4);

    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('https://ingest.example.com/api/v1/events');
    expect(calls).toContain('https://ingest.example.com/api/v1/replays/init');
    expect(calls).toContain('https://ingest.example.com/api/v1/replays/replay-1/complete');
  });

  it('does not upload replay for non-triggered events', async () => {
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: 'key-abc', replay: { enabled: true } });
    await startReplayCapture();
    emit(fullSnapshot(1_717_000_000_000), true);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 202 }));

    enqueueEvent(makeEvent());
    await flushEvents();

    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('https://ingest.example.com/api/v1/events');
    expect(calls).not.toContain('https://ingest.example.com/api/v1/replays/init');
  });
});
