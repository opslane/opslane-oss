import type { eventWithTime } from '@rrweb/types';
import { getConfig } from './config';
import { gzip } from './gzip';
import { sdkFetch } from './network';
import { SDK_VERSION } from './version';

const INLINE_BUDGET_BYTES = 64 * 1024;

export type UploadResult = boolean | 'stop';

let stopped = false;

export function _resetChunkUploadState(): void {
  stopped = false;
}

function buildBody(events: eventWithTime[], hasFullSnapshot: boolean): string {
  return JSON.stringify({
    events,
    meta: {
      sdk_version: SDK_VERSION,
      has_full_snapshot: hasFullSnapshot,
      chunked_at: Date.now(),
    },
  });
}

export async function uploadChunk(
  sessionID: string,
  seq: number,
  events: eventWithTime[],
  hasFullSnapshot: boolean,
): Promise<UploadResult> {
  if (stopped || events.length === 0) return false;
  try {
    const config = getConfig();
    const compressed = await gzip(buildBody(events, hasFullSnapshot));
    if (!compressed) return false;

    const policyResponse = await sdkFetch(
      `${config.endpoint}/api/v1/sessions/${encodeURIComponent(sessionID)}/chunks/upload-url`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
        body: JSON.stringify({
          seq,
          size_bytes: compressed.byteLength,
          has_full_snapshot: hasFullSnapshot,
        }),
      },
    );
    if (!policyResponse.ok) {
      if (policyResponse.status === 403 || policyResponse.status === 410) {
        stopped = true;
        return 'stop';
      }
      return false;
    }

    const payload = (await policyResponse.json()) as {
      upload_url: string;
      form_data: Record<string, string>;
    };
    if (!payload.upload_url || !payload.form_data) return false;

    const form = new FormData();
    for (const [key, value] of Object.entries(payload.form_data)) form.append(key, value);
    form.append('file', new Blob([compressed as Uint8Array<ArrayBuffer>], { type: 'application/gzip' }));

    const storageResponse = await sdkFetch(payload.upload_url, { method: 'POST', body: form });
    if (!storageResponse.ok) return false;

    const commitResponse = await sdkFetch(
      `${config.endpoint}/api/v1/sessions/${encodeURIComponent(sessionID)}/chunks/${seq}/commit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
        body: '{}',
      },
    );
    return commitResponse.ok;
  } catch {
    return false;
  }
}

export async function flushInline(
  sessionID: string,
  seq: number,
  events: eventWithTime[],
): Promise<boolean> {
  if (stopped || events.length === 0 || seq < 0) return false;
  try {
    const config = getConfig();
    const compressed = await gzip(buildBody(events, false));
    if (!compressed || compressed.byteLength > INLINE_BUDGET_BYTES) return false;
    const response = await sdkFetch(
      `${config.endpoint}/api/v1/sessions/${encodeURIComponent(sessionID)}/chunks/${seq}/inline`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip', 'X-API-Key': config.apiKey },
        body: compressed as Uint8Array<ArrayBuffer>,
        keepalive: true,
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}
