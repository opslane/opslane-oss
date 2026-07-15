/**
 * Extract fix-relevant evidence from an rrweb session replay WITHOUT a browser.
 *
 * Phase A2 swapped replay capture to rrweb, which uploads a single recording.json
 * ({ events: eventWithTime[], meta }) instead of per-frame screenshots. The worker's
 * old visual path consumed screenshot artifacts, so rrweb replays produced no agent
 * evidence (`visual_replay: n/a`). This rebuilds evidence by traversing the rrweb
 * event stream directly: the route, the visible UI, the user's last actions, and the
 * DOM that rendered at the crash. The result is shaped as VisualAnalysisOutput so it
 * flows through the existing agent-prompt + PR-body plumbing unchanged.
 */
import type { VisualAnalysisOutput } from './harness/types.js';
import { getPlayableChunkMetas, type SessionChunkMeta } from './db.js';
import { logger } from './logger.js';

// rrweb-snapshot NodeType: 0=Document, 1=DocumentType, 2=Element, 3=Text, 5=Comment.
const NODE_TEXT = 3;
const NODE_ELEMENT = 2;
// IncrementalSource: 0=Mutation, 2=MouseInteraction, 5=Input.
const SRC_MUTATION = 0;
const SRC_MOUSE = 2;
const SRC_INPUT = 5;
// MouseInteraction.type: 2=Click.
const MOUSE_CLICK = 2;
// rrweb EventType: 2=FullSnapshot, 3=IncrementalSnapshot.
const EVT_FULL_SNAPSHOT = 2;
const EVT_INCREMENTAL = 3;

const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'label', 'h1', 'h2', 'h3']);

interface SnapNode {
  type?: number;
  tagName?: string;
  id?: number;
  textContent?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SnapNode[];
}
export interface RrwebEvent { type: number; data?: Record<string, unknown>; timestamp: number }
interface Recording { events?: RrwebEvent[]; meta?: { crash_timestamp?: number; page_url?: string } }
interface ErrorInfo { errorType?: string; errorMessage?: string }

export interface ChunkEnvelope {
  events?: RrwebEvent[];
  meta?: Record<string, unknown>;
}

function textOf(node: SnapNode | undefined): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === NODE_TEXT) return node.textContent ?? '';
  let t = '';
  for (const c of node.childNodes ?? []) t += textOf(c) + ' ';
  return t.replace(/\s+/g, ' ').trim();
}

function describe(node: SnapNode | undefined): string {
  if (!node) return 'an element';
  const tag = (node.tagName ?? 'element').toLowerCase();
  const txt = textOf(node).slice(0, 40);
  return txt ? `${tag} "${txt}"` : tag;
}

function indexById(node: SnapNode | undefined, map: Map<number, SnapNode>): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.id === 'number') map.set(node.id, node);
  for (const c of node.childNodes ?? []) indexById(c, map);
}

function removeIndexedSubtree(node: SnapNode | undefined, map: Map<number, SnapNode>): void {
  if (!node || typeof node !== 'object') return;
  for (const child of node.childNodes ?? []) removeIndexedSubtree(child, map);
  if (typeof node.id === 'number') map.delete(node.id);
}

function collectVisibleUI(node: SnapNode | undefined, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const tag = (node.tagName ?? '').toLowerCase();
  if (INTERACTIVE.has(tag)) {
    const txt = textOf(node).slice(0, 80);
    if (txt) out.push(`${tag}: "${txt}"`);
  }
  for (const c of node.childNodes ?? []) collectVisibleUI(c, out);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((i) => (i && !seen.has(i) ? (seen.add(i), true) : false));
}

export function buildReplayEvidenceFromRecording(
  recording: Recording,
  errorInfo: ErrorInfo | null,
): VisualAnalysisOutput | null {
  const events = recording?.events;
  if (!Array.isArray(events) || events.length === 0) return null;

  const crashTs = recording.meta?.crash_timestamp ?? events[events.length - 1]!.timestamp;
  const route = recording.meta?.page_url ?? '';

  // Last full snapshot at/before the crash (fallback: first snapshot of the recording).
  const snapshots = events.filter((e) => e.type === EVT_FULL_SNAPSHOT);
  const snap = [...snapshots].reverse().find((e) => e.timestamp <= crashTs) ?? snapshots[0];
  if (!snap) return null;
  const rootNode = (snap.data?.['node'] as SnapNode | undefined);

  const visibleUIRaw: string[] = [];
  collectVisibleUI(rootNode, visibleUIRaw);
  const visibleUI = dedupe(visibleUIRaw).slice(0, 12);

  // User actions + crash-time DOM additions, up to the crash.
  const actions: string[] = [];
  const adds: string[] = [];
  let idIndex = new Map<number, SnapNode>();
  for (const e of events) {
    if (e.timestamp > crashTs) break;
    if (e.type === EVT_FULL_SNAPSHOT) {
      idIndex = new Map<number, SnapNode>();
      indexById(e.data?.['node'] as SnapNode | undefined, idIndex);
      continue;
    }
    if (e.type !== EVT_INCREMENTAL || !e.data) continue;
    const source = e.data['source'] as number | undefined;
    if (source === SRC_MOUSE && e.data['type'] === MOUSE_CLICK) {
      actions.push(`clicked ${describe(idIndex.get(e.data['id'] as number))}`);
    } else if (source === SRC_INPUT) {
      actions.push(`typed into ${describe(idIndex.get(e.data['id'] as number))}`);
    } else if (source === SRC_MUTATION) {
      for (const removal of (e.data['removes'] as Array<{ id?: number }> | undefined) ?? []) {
        if (typeof removal.id !== 'number') continue;
        removeIndexedSubtree(idIndex.get(removal.id), idIndex);
        idIndex.delete(removal.id);
      }
      for (const a of (e.data['adds'] as Array<{ node?: SnapNode }> | undefined) ?? []) {
        indexById(a.node, idIndex);
        const txt = textOf(a.node).slice(0, 60);
        const tag = (a.node?.tagName ?? '').toLowerCase();
        if (txt) adds.push(tag ? `${tag}: "${txt}"` : `"${txt}"`);
      }
    }
  }
  const lastActions = dedupe(actions).slice(-6);
  const crashDom = dedupe(adds).slice(0, 8);

  const whatUserSaw =
    `Route: ${route || 'unknown'}. Visible UI from the session replay: ` +
    `${visibleUI.join('; ') || 'n/a'}.`;
  const failureMoment =
    `${lastActions.length} user action(s) before the crash: ${lastActions.join(' → ') || 'none recorded'}.` +
    (crashDom.length ? ` DOM rendered at the crash: ${crashDom.join('; ')}.` : '');
  const uxImpact = errorInfo?.errorType
    ? `${errorInfo.errorType}: ${errorInfo.errorMessage ?? ''} surfaced on ${route || 'the page'}.`
    : `Error surfaced on ${route || 'the page'}.`;
  const confidence = visibleUI.length > 0 ? 'high' : 'low';

  return { whatUserSaw, failureMoment, uxImpact, confidence };
}

const ERROR_WINDOW_BEFORE_MS = 60_000;
const ERROR_WINDOW_AFTER_MS = 10_000;
const DEFAULT_COVERAGE_ATTEMPTS = 5;
const DEFAULT_COVERAGE_INTERVAL_MS = 15_000;

interface EventBounds { first: number; last: number }

function validBounds(chunk: SessionChunkMeta): EventBounds | null {
  const first = chunk.first_event_ms;
  const last = chunk.last_event_ms;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first! > last!) return null;
  return { first: first!, last: last! };
}

function distanceToBounds(errorAtMs: number, bounds: EventBounds): number {
  if (errorAtMs < bounds.first) return bounds.first - errorAtMs;
  if (errorAtMs > bounds.last) return errorAtMs - bounds.last;
  return 0;
}

function neighborWindow(chunks: SessionChunkMeta[], center: number, max: number): SessionChunkMeta[] {
  const count = Math.min(max, chunks.length);
  let start = Math.max(0, center - Math.floor((count - 1) / 2));
  start = Math.min(start, chunks.length - count);
  return chunks.slice(start, start + count);
}

export function chunkOverlapsErrorWindow(chunk: SessionChunkMeta, errorAtMs: number): boolean {
  const bounds = validBounds(chunk);
  if (!Number.isFinite(errorAtMs) || bounds === null) return false;
  const windowStart = errorAtMs - ERROR_WINDOW_BEFORE_MS;
  const windowEnd = errorAtMs + ERROR_WINDOW_AFTER_MS;
  return bounds.last >= windowStart && bounds.first <= windowEnd;
}

export function pickEvidenceChunks(
  chunks: SessionChunkMeta[],
  errorAtMs: number,
  max = 6,
): SessionChunkMeta[] {
  const ordered = [...chunks].sort((left, right) => left.seq - right.seq);
  const limit = Math.max(0, Math.floor(max));
  if (ordered.length === 0 || limit === 0) return [];
  const bounded = ordered.map((chunk) => validBounds(chunk));
  if (!Number.isFinite(errorAtMs)) return ordered.slice(-limit);

  const overlapping = ordered.filter((chunk) => chunkOverlapsErrorWindow(chunk, errorAtMs));
  if (overlapping.length > 0) {
    if (overlapping.length <= limit) return overlapping;
    return overlapping
      .map((chunk) => ({ chunk, bounds: validBounds(chunk)! }))
      .sort((left, right) => distanceToBounds(errorAtMs, left.bounds) - distanceToBounds(errorAtMs, right.bounds))
      .slice(0, limit)
      .map(({ chunk }) => chunk)
      .sort((left, right) => left.seq - right.seq);
  }

  // Match the dashboard's fail-safe behavior for pre-migration manifests: if
  // any bound is missing/invalid, the nearest chunk is unknowable, so use tail.
  if (bounded.some((bounds) => bounds === null)) return ordered.slice(-limit);

  // Pre-#27 client/server clock skew can put the pointer outside all recorded
  // bounds. Choose the nearest bounded chunk and expand by sequence proximity
  // so evidence degrades approximately instead of disappearing.
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  bounded.forEach((bounds, index) => {
    const distance = distanceToBounds(errorAtMs, bounds!);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return neighborWindow(ordered, nearestIndex, limit);
}

interface CoverageOptions {
  attempts?: number;
  intervalMs?: number;
  load?: (sessionID: string, projectID: string) => Promise<SessionChunkMeta[]>;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForErrorWindowCoverage(
  sessionID: string,
  projectID: string,
  errorAtMs: number,
  options: CoverageOptions = {},
): Promise<SessionChunkMeta[]> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_COVERAGE_ATTEMPTS);
  const intervalMs = options.intervalMs ?? DEFAULT_COVERAGE_INTERVAL_MS;
  const load = options.load ?? getPlayableChunkMetas;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let latest: SessionChunkMeta[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await load(sessionID, projectID);
    if (!Number.isFinite(errorAtMs) && latest.length > 0) return latest;
    if (latest.some((chunk) => chunkOverlapsErrorWindow(chunk, errorAtMs))) return latest;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }

  if (latest.length > 0) {
    logger.warn('Session replay error window was not covered; using approximate evidence', {
      session_id: sessionID,
      project_id: projectID,
      playable_chunks: latest.length,
    });
  } else {
    logger.warn('Session replay chunks were not ready; continuing without visual evidence', {
      session_id: sessionID,
      project_id: projectID,
    });
  }
  return latest;
}

function isRrwebEvent(value: unknown): value is RrwebEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event['type'] === 'number' && typeof event['timestamp'] === 'number';
}

export async function fetchChunkViaIngestion(
  projectID: string,
  sessionID: string,
  seq: number,
): Promise<ChunkEnvelope | null> {
  const baseURL = process.env['INGESTION_BASE_URL']?.replace(/\/$/, '');
  const token = process.env['INTERNAL_READ_TOKEN'];
  if (!baseURL || !token) {
    logger.warn('Session replay internal read is not configured', { session_id: sessionID, seq });
    return null;
  }

  try {
    const response = await fetch(
      `${baseURL}/internal/v1/projects/${encodeURIComponent(projectID)}/sessions/${encodeURIComponent(sessionID)}/chunks/${seq}`,
      { headers: { 'X-Internal-Token': token } },
    );
    if (!response.ok) {
      logger.warn('Session replay chunk read failed', { session_id: sessionID, seq, status: response.status });
      return null;
    }
    const decoded: unknown = await response.json();
    if (!decoded || typeof decoded !== 'object') return null;
    const envelope = decoded as Record<string, unknown>;
    if (!Array.isArray(envelope['events'])) return null;
    return {
      events: envelope['events'].filter(isRrwebEvent),
      meta: envelope['meta'] && typeof envelope['meta'] === 'object'
        ? envelope['meta'] as Record<string, unknown>
        : undefined,
    };
  } catch (error: unknown) {
    logger.warn('Session replay chunk read failed', { session_id: sessionID, seq, error: String(error) });
    return null;
  }
}
