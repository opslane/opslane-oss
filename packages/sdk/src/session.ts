/**
 * Durable session identity for always-on recording.
 *
 * sessionStorage is deliberate: it is per-tab, survives navigation, and dies
 * with the tab rather than trailing an identity across days.
 */

const STORAGE_KEY = 'opslane_session';
const IDLE_MS = 30 * 60 * 1000;

interface SessionState {
  id: string;
  /** Next chunk sequence number to hand out. */
  seq: number;
  lastActivityAt: number;
  userId: string | null;
}

export interface SessionProgress {
  id: string;
  nextSeq: number;
}

export interface SessionRotation {
  previous: SessionProgress;
  newSessionID: string;
}

let state: SessionState | null = null;

// A session id is a bearer of evidence: anyone who can guess a live id can
// reserve a chunk seq against it with the project's public SDK key. It must not
// be predictable, so Math.random (xorshift128+, recoverable from a few outputs)
// is not an acceptable source.
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // randomUUID is restricted to secure contexts. getRandomValues is not, so
    // an http:// origin still gets a CSPRNG rather than a guessable id.
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `sess_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function readStorage(): SessionState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as SessionState).id !== 'string' ||
      typeof (parsed as SessionState).seq !== 'number' ||
      !Number.isInteger((parsed as SessionState).seq) ||
      (parsed as SessionState).seq < 0 ||
      typeof (parsed as SessionState).lastActivityAt !== 'number' ||
      !(
        (parsed as SessionState).userId === null ||
        typeof (parsed as SessionState).userId === 'string'
      )
    ) {
      return null;
    }
    return parsed as SessionState;
  } catch {
    return null;
  }
}

function writeStorage(next: SessionState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Memory-only fallback; state remains correct for this page load.
  }
}

function freshState(userId: string | null): SessionState {
  return { id: newId(), seq: 0, lastActivityAt: Date.now(), userId };
}

function isExpired(value: SessionState): boolean {
  return Date.now() - value.lastActivityAt > IDLE_MS;
}

function load(): SessionState {
  if (!state) {
    state = readStorage();
    if (!state || isExpired(state)) {
      state = freshState(state?.userId ?? null);
      writeStorage(state);
    }
  }
  return state;
}

export function ensureSessionID(): string {
  return load().id;
}

export function getSessionId(): string {
  return state?.id ?? '';
}

export function touchSession(): void {
  const current = load();
  current.lastActivityAt = Date.now();
  writeStorage(current);
}

export function nextChunkSeq(): number {
  const current = load();
  const seq = current.seq;
  current.seq = seq + 1;
  current.lastActivityAt = Date.now();
  writeStorage(current);
  return seq;
}

export function peekChunkSeq(): number {
  return load().seq;
}

/** Snapshot progress before an identity rotation replaces persisted state. */
export function getSessionProgress(): SessionProgress {
  const current = load();
  return { id: current.id, nextSeq: current.seq };
}

/** Rotates an already-loaded session after an idle gap. */
export function rotateSessionIfIdle(): SessionRotation | null {
  const current = load();
  if (!isExpired(current)) return null;
  const previous = { id: current.id, nextSeq: current.seq };
  state = freshState(current.userId);
  writeStorage(state);
  return { previous, newSessionID: state.id };
}

/** Rotates the session when its end-user identity changes. */
export function setSessionUser(userId: string | null): boolean {
  const current = load();
  if (current.userId === userId) return false;
  state = freshState(userId);
  writeStorage(state);
  return true;
}

/** Test hook: drops only in-memory state, like a page reload. */
export function resetSessionId(): void {
  state = null;
}

/** Test hook: explicitly reloads persisted state. */
export function _rehydrateFromStorage(): void {
  state = readStorage();
}
