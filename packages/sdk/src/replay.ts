import type { Breadcrumb } from '@opslane/shared';
import { EventType, type eventWithTime } from '@rrweb/types';
import { getBreadcrumbs } from './breadcrumbs';
import { _resetChunkUploadState, flushInline, uploadChunk } from './chunk-upload';
import { getConfig } from './config';
import { getCurrentUser, onIdentityChange } from './core';
import { gzipSupported } from './gzip';
import { sdkFetch } from './network';
import { ensureSessionID, nextChunkSeq, resetSessionId, rotateSessionIfIdle, touchSession, type SessionProgress } from './session.js';
import { scrubUrl } from './scrub';
import { setTelemetrySink } from './telemetry';
import { SDK_VERSION } from './version';

export type ReplayTriggerType = 'uncaught_error' | 'capture_exception';

interface ReplayInitResponse {
  replay_id: string;
  upload_url: string;
  upload_headers?: Record<string, string>;
}

interface ReplayUploadInput {
  triggerType: ReplayTriggerType;
  errorType: string;
  errorMessage: string;
  eventId?: string;
  errorGroupId?: string;
}

interface ReplaySignals {
  console: {
    error_count: number;
    warning_count: number;
    error_messages: string[];
    warning_messages: string[];
  };
  network: {
    anomaly_count: number;
    anomalies: Array<{
      type: string;
      method: string;
      url: string;
      status_code: number | null;
      message: string;
    }>;
  };
}

const CHUNK_MS = 30_000;
const MAX_CHUNK_RAW_BYTES = 20 * 1024 * 1024;

let buffer: eventWithTime[] = [];
let bufferBytes = 0;
let currentSessionID = '';
let currentSeq = -1;
let replayInstalled = false;
let stopFn: (() => void) | null = null;
let takeFullSnapshotFn: ((isCheckout?: boolean) => void) | null = null;
let startGeneration = 0;
let rotationGeneration = 0;
let streamReady = false;
let awaitingRotationSnapshot = false;

function approxEventBytes(event: eventWithTime): number {
  try {
    return utf8ByteLength(JSON.stringify(event));
  } catch {
    return 0;
  }
}

/** A checkout begins a self-contained chunk with a fresh full snapshot. */
function onEmit(event: eventWithTime, isCheckout?: boolean): void {
  try {
    const idleRotation = rotateSessionIfIdle();
    if (idleRotation) {
      beginSessionRotation(idleRotation.newSessionID, idleRotation.previous);
      return;
    }

    if (!streamReady) {
      if (event.type === EventType.FullSnapshot && awaitingRotationSnapshot) {
        buffer = [event];
        bufferBytes = approxEventBytes(event);
        awaitingRotationSnapshot = false;
        streamReady = true;
      }
      return;
    }
    // rrweb emits checkout metadata immediately before the checkout's full
    // snapshot, and marks both events isCheckout=true. Metadata cannot open an
    // independently playable chunk, so wait for the FullSnapshot boundary.
    if (isCheckout && event.type !== EventType.FullSnapshot) return;
    if (isCheckout && buffer.length > 0) {
      const chunk = buffer;
      const seq = currentSeq >= 0 ? currentSeq : nextChunkSeq();
      const sessionID = currentSessionID;
      buffer = [event];
      bufferBytes = approxEventBytes(event);
      currentSeq = -1;
      if (seq >= 0 && sessionID) void shipChunk(sessionID, seq, chunk);
      return;
    }

    if (isCheckout) {
      buffer = [event];
      bufferBytes = approxEventBytes(event);
      return;
    }

    buffer.push(event);
    bufferBytes += approxEventBytes(event);
    touchSession();
    if (bufferBytes > MAX_CHUNK_RAW_BYTES) {
      try {
        takeFullSnapshotFn?.(true);
      } catch {
        // rrweb is best-effort.
      }
    }
  } catch {
    // SDK must never throw.
  }
}

async function shipChunk(sessionID: string, seq: number, events: eventWithTime[]): Promise<void> {
  const result = await uploadChunk(sessionID, seq, events, true);
  if (result === 'stop') stopReplayCapture();
}

async function registerSession(sessionID = ensureSessionID()): Promise<boolean> {
  try {
    const config = getConfig();
    const user = getCurrentUser();
    const response = await sdkFetch(`${config.endpoint}/api/v1/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
      body: JSON.stringify({
        session_id: sessionID,
        started_at: new Date().toISOString(),
        page_url: currentPageUrl(),
        user: user ? {
          id: user.id,
          email: user.email,
          account_id: user.account?.id,
          account_name: user.account?.name,
        } : null,
      }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { recording?: boolean };
    if (body.recording !== true) return false;
    return true;
  } catch {
    return false;
  }
}

// Identity can change while the init request is in flight. Register the latest
// durable id before rrweb starts so capture never opens under a retired id.
async function registerStableSession(generation: number): Promise<string | null> {
  let sessionID = ensureSessionID();
  while (generation === startGeneration && replayInstalled) {
    if (!(await registerSession(sessionID))) return null;
    const latestSessionID = ensureSessionID();
    if (latestSessionID === sessionID) return sessionID;
    sessionID = latestSessionID;
  }
  return null;
}

export async function startReplayCapture(): Promise<void> {
  if (replayInstalled) return;
  try {
    if (!getConfig().replayEnabled) return;
  } catch {
    return;
  }
  if (typeof window === 'undefined' || typeof document === 'undefined' || !gzipSupported()) return;

  replayInstalled = true;
  const generation = ++startGeneration;
  const initialSessionID = await registerStableSession(generation);
  if (!initialSessionID || generation !== startGeneration || !replayInstalled) {
    if (generation === startGeneration) replayInstalled = false;
    return;
  }
  currentSessionID = initialSessionID;
  streamReady = false;
  awaitingRotationSnapshot = true;
  _resetChunkUploadState();
  onIdentityChange(handleIdentityChange);

  try {
    const { record, addCustomEvent, takeFullSnapshot } = await import('rrweb');
    setTelemetrySink((event) => {
      try {
        addCustomEvent('opslane.telemetry', event);
      } catch {
        // rrweb may not have started yet.
      }
    });
    takeFullSnapshotFn = takeFullSnapshot;
    const stop = record({
      emit: onEmit,
      checkoutEveryNms: CHUNK_MS,
      maskAllInputs: true,
      maskTextSelector: '.opslane-mask',
      blockSelector: '.opslane-block',
      recordCanvas: false,
    });

    if (!replayInstalled || generation !== startGeneration) {
      if (typeof stop === 'function') stop();
      return;
    }
    stopFn = typeof stop === 'function' ? stop : null;
    if (!stopFn) {
      stopReplayCapture();
      return;
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
  } catch {
    stopReplayCapture();
  }
}

function handleIdentityChange(newSessionID: string, previous: SessionProgress): void {
  beginSessionRotation(newSessionID, previous);
}

function beginSessionRotation(newSessionID: string, previous: SessionProgress): void {
  const generation = ++rotationGeneration;
  const pending = buffer;
  const pendingSeq = pending.length > 0
    ? (currentSeq >= 0 ? currentSeq : previous.nextSeq)
    : -1;
  const oldSessionID = previous.id || currentSessionID;

  buffer = [];
  bufferBytes = 0;
  currentSeq = -1;
  currentSessionID = newSessionID;
  streamReady = false;
  awaitingRotationSnapshot = false;

  if (pending.length > 0 && pendingSeq >= 0 && oldSessionID) {
    void uploadChunk(oldSessionID, pendingSeq, pending, true);
  }

  void (async () => {
    if (!(await registerSession(newSessionID))) {
      if (generation !== rotationGeneration) return;
      stopReplayCapture();
      return;
    }
    if (generation !== rotationGeneration || !replayInstalled) return;
    currentSessionID = newSessionID;
    awaitingRotationSnapshot = true;
    try {
      takeFullSnapshotFn?.(true);
    } catch {
      // best-effort
    }
  })();
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'hidden' || buffer.length === 0) return;
  if (currentSeq < 0) currentSeq = nextChunkSeq();
  const tail = buffer;
  const tailSeq = currentSeq;
  const tailSessionID = currentSessionID;
  buffer = [];
  bufferBytes = 0;
  currentSeq = -1;
  void flushInline(tailSessionID, tailSeq, tail).then((landed) => {
    // A backgrounded page may survive. If keepalive could not carry the tail
    // (most commonly because gzip exceeded 64KB), fall back to the normal
    // storage-policy flow. A closing page will simply run out of time.
    if (!landed) void shipChunk(tailSessionID, tailSeq, tail);
  });
  // If the page survives backgrounding, resume from a new full snapshot. This
  // also prevents the regular uploader from reusing the inline tail's seq.
  try {
    takeFullSnapshotFn?.(true);
  } catch {
    // The page may already be tearing down.
  }
}

export function stopReplayCapture(): void {
  startGeneration += 1;
  rotationGeneration += 1;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  onIdentityChange(null);
  setTelemetrySink(null);
  takeFullSnapshotFn = null;
  buffer = [];
  bufferBytes = 0;
  currentSeq = -1;
  currentSessionID = '';
  streamReady = false;
  awaitingRotationSnapshot = false;
  replayInstalled = false;

  const stop = stopFn;
  stopFn = null;
  if (stop) {
    try {
      stop();
    } catch {
      // replay is best-effort.
    }
  }
}

/**
 * Legacy error-triggered replay upload retained until Batch 2 migrates the
 * dashboard and worker readers from session_replays to chunk pointers.
 */
export async function uploadReplayForTrigger(input: ReplayUploadInput): Promise<void> {
  let replayID = '';
  try {
    const config = getConfig();
    if (!config.replayEnabled) return;
    const events = snapshotRrwebEvents();
    if (events.length === 0) return;

    const sessionID = ensureSessionID();
    const now = Date.now();
    const startedAt = Number.isFinite(events[0]?.timestamp) ? events[0].timestamp : now;
    const pageURL = currentPageUrl();
    const body = JSON.stringify({
      events,
      meta: {
        sdk_version: SDK_VERSION,
        page_url: pageURL,
        started_at: startedAt,
        ended_at: now,
        crash_timestamp: now,
      },
    });

    const initResponse = await sdkFetch(`${config.endpoint}/api/v1/replays/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
      body: JSON.stringify({
        session_id: sessionID,
        error_event_id: input.eventId ?? null,
        error_group_id: input.errorGroupId ?? null,
        trigger_type: input.triggerType,
        page_url: pageURL,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(now).toISOString(),
      }),
    });
    if (!initResponse.ok) return;

    const initPayload = (await initResponse.json()) as ReplayInitResponse;
    replayID = initPayload.replay_id;
    const uploadResponse = await sdkFetch(initPayload.upload_url, {
      method: 'PUT',
      headers: { ...(initPayload.upload_headers || {}), 'Content-Type': 'application/json' },
      body,
    });
    if (!uploadResponse.ok) throw new Error(`upload failed with status ${uploadResponse.status}`);

    const completed = await completeReplayUpload(
      config.endpoint,
      config.apiKey,
      replayID,
      utf8ByteLength(body),
      buildReplaySignals(getBreadcrumbs()),
    );
    if (!completed) throw new Error('complete replay upload failed');
  } catch (error) {
    try {
      if (!replayID) return;
      const config = getConfig();
      await sdkFetch(`${config.endpoint}/api/v1/replays/${encodeURIComponent(replayID)}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
        body: JSON.stringify({
          reason: error instanceof Error ? error.message : 'unknown replay upload error',
        }),
      });
    } catch {
      // replay is best-effort.
    }
  }
}

async function completeReplayUpload(
  endpoint: string,
  apiKey: string,
  replayID: string,
  sizeBytes: number,
  signals: ReplaySignals,
): Promise<boolean> {
  try {
    const response = await sdkFetch(`${endpoint}/api/v1/replays/${encodeURIComponent(replayID)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ size_bytes: sizeBytes, signals }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function buildReplaySignals(breadcrumbs: Breadcrumb[]): ReplaySignals {
  let consoleErrorCount = 0;
  let consoleWarningCount = 0;
  const consoleErrorMessages: string[] = [];
  const consoleWarningMessages: string[] = [];
  let networkAnomalyCount = 0;
  const networkAnomalies: ReplaySignals['network']['anomalies'] = [];

  for (const crumb of breadcrumbs) {
    if (crumb.type === 'console') {
      if (crumb.level === 'error') {
        consoleErrorCount += 1;
        if (crumb.message) consoleErrorMessages.push(crumb.message);
      }
      if (crumb.level === 'warning') {
        consoleWarningCount += 1;
        if (crumb.message) consoleWarningMessages.push(crumb.message);
      }
    }
    if (crumb.type === 'fetch' || crumb.type === 'xhr') {
      const method = typeof crumb.data?.method === 'string' ? crumb.data.method : 'GET';
      const url = typeof crumb.data?.url === 'string' ? crumb.data.url : '';
      const statusCode = typeof crumb.data?.status_code === 'number' ? crumb.data.status_code : undefined;
      if (crumb.level === 'error' || crumb.level === 'warning' || (statusCode != null && statusCode >= 400)) {
        networkAnomalyCount += 1;
        networkAnomalies.push({
          type: crumb.type,
          method,
          url,
          status_code: statusCode ?? null,
          message: crumb.message,
        });
      }
    }
  }

  return {
    console: {
      error_count: consoleErrorCount,
      warning_count: consoleWarningCount,
      error_messages: uniqueHead(consoleErrorMessages, 5),
      warning_messages: uniqueHead(consoleWarningMessages, 5),
    },
    network: { anomaly_count: networkAnomalyCount, anomalies: networkAnomalies.slice(-5) },
  };
}

function uniqueHead(values: string[], limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
    if (output.length >= limit) break;
  }
  return output;
}

function currentPageUrl(): string {
  try {
    return typeof window !== 'undefined' ? scrubUrl(window.location.href) : '';
  } catch {
    return '';
  }
}

function utf8ByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return value.length;
  }
}

export function snapshotRrwebEvents(): eventWithTime[] {
  return [...buffer].sort((left, right) => left.timestamp - right.timestamp);
}

export function _resetReplayState(): void {
  stopReplayCapture();
  startGeneration = 0;
  resetSessionId();
}
