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
interface RrwebEvent { type: number; data?: Record<string, unknown>; timestamp: number }
interface Recording { events?: RrwebEvent[]; meta?: { crash_timestamp?: number; page_url?: string } }
interface ErrorInfo { errorType?: string; errorMessage?: string }

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

  const idIndex = new Map<number, SnapNode>();
  indexById(rootNode, idIndex);

  const visibleUIRaw: string[] = [];
  collectVisibleUI(rootNode, visibleUIRaw);
  const visibleUI = dedupe(visibleUIRaw).slice(0, 12);

  // User actions + crash-time DOM additions, up to the crash.
  const actions: string[] = [];
  const adds: string[] = [];
  for (const e of events) {
    if (e.timestamp > crashTs) continue;
    if (e.type !== EVT_INCREMENTAL || !e.data) continue;
    const source = e.data['source'] as number | undefined;
    if (source === SRC_MOUSE && e.data['type'] === MOUSE_CLICK) {
      actions.push(`clicked ${describe(idIndex.get(e.data['id'] as number))}`);
    } else if (source === SRC_INPUT) {
      actions.push(`typed into ${describe(idIndex.get(e.data['id'] as number))}`);
    } else if (source === SRC_MUTATION) {
      for (const a of (e.data['adds'] as Array<{ node?: SnapNode }> | undefined) ?? []) {
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
