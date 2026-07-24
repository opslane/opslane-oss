/**
 * Debuggable trail for onboard runs (design R7). Metadata-only by default —
 * hashes and byte counts, never content — so the file is safe to attach to a
 * bug report. Full capture is an explicit opt-in with field redaction.
 * Keyed by a LOCAL run id so runs that die before provisioning still log;
 * setSessionId records the server session id as the join key once known.
 */
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface RunLogOptions {
  dir: string;
  runId: string;
  mode: 'metadata' | 'full';
  redact?: string[];
  maxLogs?: number;
  maxRecordBytes?: number;
  nowFn?: () => number;
}

export interface RunLog {
  path: string;
  record(message: unknown): Promise<void>;
  /** Register a secret value discovered after creation (e.g. the provisioned key). */
  addSecret(secret: string): void;
  setSessionId(sessionId: string): Promise<void>;
  finish(summary: Record<string, unknown>): Promise<void>;
}

// Field-name redaction uses substring matching intentionally so it catches
// poll_token, refresh_token, accessToken, code_verifier, api_key, and similar.
const SENSITIVE_FIELD =
  /(authorization|api[_-]?key|token|secret|verifier|password|credential)/i;
const METADATA_SUMMARY_FIELDS = new Set([
  'outcome',
  'turns',
  'toolCalls',
  'durationMs',
  'totalCostUsd',
]);

function redactDeep(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let redacted = value;
    for (const secret of secrets) {
      if (secret) redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets));
  }

  if (typeof value === 'object' && value !== null) {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = SENSITIVE_FIELD.test(key)
        ? '[REDACTED]'
        : redactDeep(item, secrets);
    }
    return redacted;
  }

  return value;
}

function metadataSummary(summary: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(summary).filter(([key, value]) =>
      METADATA_SUMMARY_FIELDS.has(key)
      && (typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'),
    ),
  );
}

export async function createRunLog(options: RunLogOptions): Promise<RunLog> {
  const now = options.nowFn ?? Date.now;
  const maxLogs = options.maxLogs ?? 20;
  const maxRecordBytes = options.maxRecordBytes ?? 64 * 1024;
  const secrets = [...(options.redact ?? [])];

  await mkdir(options.dir, { recursive: true });

  // Keep the newest maxLogs - 1 existing logs, leaving room for this run.
  const existing = (await readdir(options.dir)).filter((name) =>
    /^onboard-.*\.jsonl$/.test(name),
  );
  const withTimes = await Promise.all(
    existing.map(async (name) => ({
      name,
      mtime: (await stat(join(options.dir, name))).mtimeMs,
    })),
  );
  withTimes.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of withTimes.slice(Math.max(0, maxLogs - 1))) {
    await unlink(join(options.dir, name)).catch(() => undefined);
  }

  // Create the file immediately so even a run that dies before provisioning
  // leaves a useful artifact and participates in retention.
  const path = join(options.dir, `onboard-${options.runId}.jsonl`);
  await appendFile(path, '', { mode: 0o600 });
  await chmod(path, 0o600);

  async function append(line: Record<string, unknown>): Promise<void> {
    await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  return {
    path,
    addSecret(secret: string): void {
      if (secret) secrets.push(secret);
    },
    async record(message: unknown): Promise<void> {
      const raw = JSON.stringify(message) ?? 'null';
      const record = message as Record<string, unknown> | null;

      if (options.mode === 'metadata') {
        await append({
          ts: now(),
          type: typeof record?.['type'] === 'string' ? record['type'] : 'unknown',
          name: typeof record?.['name'] === 'string' ? record['name'] : undefined,
          hash: createHash('sha256').update(raw).digest('hex'),
          bytes: Buffer.byteLength(raw),
        });
        return;
      }

      const redacted = redactDeep(message, secrets);
      let serialized = JSON.stringify(redacted) ?? 'null';
      if (Buffer.byteLength(serialized) > maxRecordBytes) {
        serialized = JSON.stringify({
          truncated: true,
          bytes: Buffer.byteLength(serialized),
        });
      }
      await append({ ts: now(), full: JSON.parse(serialized) });
    },
    async setSessionId(sessionId: string): Promise<void> {
      await append({ ts: now(), session_id: sessionId });
    },
    async finish(summary: Record<string, unknown>): Promise<void> {
      await append({
        ts: now(),
        summary: options.mode === 'metadata'
          ? metadataSummary(summary)
          : redactDeep(summary, secrets),
      });
    },
  };
}
