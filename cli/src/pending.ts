import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { canonicalOrigin } from './origin.js';
import { writeFileAtomic } from './fsutil.js';

export interface PendingSession {
  kind?: 'onboard' | 'setup';
  poll_id: string;
  poll_token: string;
  api_url: string;
  repo: string;
  created_at: string;
}

const DEFAULT_PENDING_DIR = join(homedir(), '.opslane', 'pending');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export function validatePollId(pollId: string): void {
  if (!UUID_PATTERN.test(pollId)) {
    throw new Error('poll ID must be a UUID');
  }
}

function pendingPath(pollId: string, baseDir: string): string {
  validatePollId(pollId);
  return join(baseDir, `${pollId}.json`);
}

function isPendingSession(value: unknown): value is PendingSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (kind !== undefined && kind !== 'onboard' && kind !== 'setup') return false;
  return ['poll_id', 'poll_token', 'api_url', 'repo', 'created_at']
    .every((key) => typeof record[key] === 'string') && UUID_PATTERN.test(record['poll_id'] as string);
}

export async function findPendingByRepo(
  apiUrl: string,
  repo: string,
  baseDir: string = DEFAULT_PENDING_DIR,
  ttlMs: number = PENDING_TTL_MS,
): Promise<PendingSession | null> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return null;
  }

  const origin = canonicalOrigin(apiUrl);
  const target = repo.toLowerCase();
  const matches: PendingSession[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(baseDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!isPendingSession(parsed) || (parsed.kind ?? 'setup') !== 'onboard') continue;

    let sameTarget = false;
    try {
      sameTarget = canonicalOrigin(parsed.api_url) === origin
        && parsed.repo.toLowerCase() === target;
    } catch {
      continue;
    }
    if (!sameTarget) continue;

    const age = Date.now() - Date.parse(parsed.created_at);
    if (!Number.isFinite(age) || age > ttlMs) {
      await deletePendingSession(parsed.poll_id, baseDir).catch(() => undefined);
      continue;
    }
    matches.push(parsed);
  }

  matches.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const [newest, ...stale] = matches;
  for (const session of stale) {
    await deletePendingSession(session.poll_id, baseDir).catch(() => undefined);
  }
  return newest ?? null;
}

export async function savePendingSession(
  session: PendingSession,
  baseDir: string = DEFAULT_PENDING_DIR,
): Promise<void> {
  const filePath = pendingPath(session.poll_id, baseDir);
  await writeFileAtomic(filePath, `${JSON.stringify({
    ...session,
    api_url: canonicalOrigin(session.api_url),
  }, null, 2)}\n`);
}

export async function loadPendingSession(
  pollId: string,
  baseDir: string = DEFAULT_PENDING_DIR,
): Promise<PendingSession | null> {
  const filePath = pendingPath(pollId, baseDir);
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return isPendingSession(parsed) && parsed.poll_id === pollId ? parsed : null;
  } catch {
    return null;
  }
}

export async function deletePendingSession(
  pollId: string,
  baseDir: string = DEFAULT_PENDING_DIR,
): Promise<void> {
  await unlink(pendingPath(pollId, baseDir)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export function defaultPendingDir(): string {
  return DEFAULT_PENDING_DIR;
}
