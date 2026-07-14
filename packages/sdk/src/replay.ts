import type { Breadcrumb } from '@opslane/shared';
import type { eventWithTime } from '@rrweb/types';
import { getConfig } from './config';
import { getBreadcrumbs } from './breadcrumbs';
import { ensureSessionID, resetSessionId } from './session.js';
import { scrubUrl } from './scrub';
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

const CHECKOUT_MS = 30_000;
const MAX_RECORDING_BYTES = 2 * 1024 * 1024;

let currentWindow: eventWithTime[] = [];
let previousWindow: eventWithTime[] = [];
// Running byte totals tracked incrementally so the budget check is O(1) per event.
// Re-serializing the whole buffer on every rrweb event would be O(n^2) on the main
// thread (rrweb emits thousands of events per session) and cause page jank.
let currentWindowBytes = 0;
let previousWindowBytes = 0;
let replayInstalled = false;
let stopFn: (() => void) | null = null;
let startGeneration = 0;

function approxEventBytes(event: eventWithTime): number {
  try {
    return utf8ByteLength(JSON.stringify(event));
  } catch {
    return 0;
  }
}

function enforceReplayBudget(): void {
  if (previousWindow.length === 0) {
    return;
  }

  if (previousWindowBytes + currentWindowBytes > MAX_RECORDING_BYTES) {
    previousWindow = [];
    previousWindowBytes = 0;
  }
}

function recordReplayEvent(event: eventWithTime, isCheckout?: boolean): void {
  if (isCheckout) {
    previousWindow = currentWindow;
    previousWindowBytes = currentWindowBytes;
    currentWindow = [];
    currentWindowBytes = 0;
  }

  currentWindow.push(event);
  currentWindowBytes += approxEventBytes(event);
  enforceReplayBudget();
}

export async function startReplayCapture(): Promise<void> {
  if (replayInstalled) {
    return;
  }

  let replayEnabled = false;
  try {
    replayEnabled = getConfig().replayEnabled;
  } catch {
    return;
  }

  if (!replayEnabled || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  replayInstalled = true;
  ensureSessionID();

  const generation = ++startGeneration;
  try {
    const { record } = await import('rrweb');
    const stop = record({
      emit: recordReplayEvent,
      checkoutEveryNms: CHECKOUT_MS,
      maskAllInputs: true,
      maskTextSelector: '.opslane-mask',
      blockSelector: '.opslane-block',
      recordCanvas: false,
    });

    if (!replayInstalled || generation !== startGeneration) {
      if (typeof stop === 'function') {
        stop();
      }
      return;
    }

    stopFn = typeof stop === 'function' ? stop : null;
    if (!stopFn) {
      replayInstalled = false;
    }
  } catch {
    replayInstalled = false;
    stopFn = null;
  }
}

export function stopReplayCapture(): void {
  if (!replayInstalled && !stopFn) {
    return;
  }

  replayInstalled = false;
  startGeneration += 1;

  const stop = stopFn;
  stopFn = null;
  if (stop) {
    try {
      stop();
    } catch {
      // replay is best-effort
    }
  }
}

export async function uploadReplayForTrigger(input: ReplayUploadInput): Promise<void> {
  let replayID = '';

  try {
    const config = getConfig();
    if (!config.replayEnabled) {
      return;
    }

    const events = snapshotRrwebEvents();
    if (events.length === 0) {
      return;
    }

    const sessionID = ensureSessionID();
    const now = Date.now();
    const startedAt = Number.isFinite(events[0]?.timestamp) ? events[0].timestamp : now;
    const endedAt = now;
    const pageURL = currentPageUrl();

    const recording = {
      events,
      meta: {
        sdk_version: SDK_VERSION,
        page_url: pageURL,
        started_at: startedAt,
        ended_at: endedAt,
        crash_timestamp: now,
      },
    };
    const body = JSON.stringify(recording);
    const sizeBytes = utf8ByteLength(body);

    const initRes = await fetch(`${config.endpoint}/api/v1/replays/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify({
        session_id: sessionID,
        error_event_id: input.eventId ?? null,
        error_group_id: input.errorGroupId ?? null,
        trigger_type: input.triggerType,
        page_url: pageURL,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
      }),
    });

    if (!initRes.ok) {
      return;
    }

    const initPayload = (await initRes.json()) as ReplayInitResponse;
    replayID = initPayload.replay_id;
    const signals = buildReplaySignals(getBreadcrumbs());

    const uploadRes = await fetch(initPayload.upload_url, {
      method: 'PUT',
      headers: {
        ...(initPayload.upload_headers || {}),
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!uploadRes.ok) {
      throw new Error(`upload failed with status ${uploadRes.status}`);
    }

    const completed = await completeReplayUpload(config.endpoint, config.apiKey, replayID, sizeBytes, signals);
    if (!completed) {
      throw new Error('complete replay upload failed');
    }
  } catch (err) {
    try {
      const config = getConfig();
      if (!replayID) {
        return;
      }
      await fetch(`${config.endpoint}/api/v1/replays/${encodeURIComponent(replayID)}/fail`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
        },
        body: JSON.stringify({
          reason: err instanceof Error ? err.message : 'unknown replay upload error',
        }),
      });
    } catch {
      // replay is best-effort
    }
  }
}

async function completeReplayUpload(
  endpoint: string,
  apiKey: string,
  replayID: string,
  sizeBytes: number,
  signals: ReplaySignals
): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/v1/replays/${encodeURIComponent(replayID)}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        size_bytes: sizeBytes,
        signals,
      }),
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
  const networkAnomalies: Array<{
    type: string;
    method: string;
    url: string;
    status_code: number | null;
    message: string;
  }> = [];

  for (const crumb of breadcrumbs) {
    if (crumb.type === 'console') {
      if (crumb.level === 'error') {
        consoleErrorCount += 1;
        if (crumb.message) {
          consoleErrorMessages.push(crumb.message);
        }
      }
      if (crumb.level === 'warning') {
        consoleWarningCount += 1;
        if (crumb.message) {
          consoleWarningMessages.push(crumb.message);
        }
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
    network: {
      anomaly_count: networkAnomalyCount,
      anomalies: networkAnomalies.slice(-5),
    },
  };
}

function uniqueHead(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
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

export function _resetReplayState(): void {
  stopReplayCapture();
  currentWindow = [];
  previousWindow = [];
  currentWindowBytes = 0;
  previousWindowBytes = 0;
  replayInstalled = false;
  stopFn = null;
  startGeneration = 0;
  resetSessionId();
}

export function snapshotRrwebEvents(): eventWithTime[] {
  return [...previousWindow, ...currentWindow].sort((a, b) => a.timestamp - b.timestamp);
}
