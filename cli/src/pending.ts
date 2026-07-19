import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { canonicalOrigin } from './origin.js';
import { writeFileAtomic } from './fsutil.js';

export interface PendingSession {
  poll_id: string;
  poll_token: string;
  api_url: string;
  repo: string;
  created_at: string;
}

const DEFAULT_PENDING_DIR = join(homedir(), '.opslane', 'pending');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  return ['poll_id', 'poll_token', 'api_url', 'repo', 'created_at']
    .every((key) => typeof record[key] === 'string') && UUID_PATTERN.test(record['poll_id'] as string);
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
