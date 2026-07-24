import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRunLog } from '../runlog.js';

async function dir() {
  return mkdtemp(join(tmpdir(), 'opslane-runlog-'));
}

const MSG = {
  type: 'tool_use',
  name: 'Read',
  input: { file_path: 'src/main.ts' },
  content: 'const SECRET = "opk_raw_key_123";',
};

describe('createRunLog', () => {
  it('metadata mode records ts/type/name/hash/bytes — never content or args', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r1', mode: 'metadata' });
    await log.record(MSG);
    await log.finish({
      outcome: 'ok',
      turns: 1,
      toolCalls: 1,
      durationMs: 5,
      totalCostUsd: 0.01,
    });

    const text = await readFile(log.path, 'utf8');
    expect(text).not.toContain('opk_raw_key_123');
    expect(text).not.toContain('src/main.ts');
    const first = JSON.parse(text.split('\n')[0]!);
    expect(first).toMatchObject({ type: 'tool_use', name: 'Read' });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.bytes).toBeGreaterThan(0);
  });

  it('full mode redacts registered secrets even inside content', async () => {
    const d = await dir();
    const log = await createRunLog({
      dir: d,
      runId: 'r2',
      mode: 'full',
      redact: ['opk_raw_key_123'],
    });
    await log.record(MSG);

    const text = await readFile(log.path, 'utf8');
    expect(text).not.toContain('opk_raw_key_123');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('src/main.ts');
  });

  it('full mode redacts sensitive fields regardless of value', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r2b', mode: 'full' });
    await log.record({
      poll_token: 'pval1',
      refresh_token: 'rval1',
      accessToken: 'aval1',
      code_verifier: 'vval1',
    });

    const text = await readFile(log.path, 'utf8');
    for (const secret of ['pval1', 'rval1', 'aval1', 'vval1']) {
      expect(text).not.toContain(secret);
    }
  });

  it('addSecret registers values discovered after creation', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r2c', mode: 'full' });
    log.addSecret('opk_minted_later');
    await log.record({ content: 'x opk_minted_later y' });

    expect(await readFile(log.path, 'utf8')).not.toContain('opk_minted_later');
  });

  it('logs before provisioning and records a later session join key', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r3', mode: 'metadata' });
    expect(log.path).toContain('onboard-r3');
    await log.setSessionId('sess-42');

    expect(await readFile(log.path, 'utf8')).toContain('sess-42');
  });

  it('creates the log with mode 0600', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r4', mode: 'metadata' });
    await log.record(MSG);

    expect((await stat(log.path)).mode & 0o777).toBe(0o600);
  });

  it('keeps the newest N logs and prunes older logs on create', async () => {
    const d = await dir();
    for (const id of ['a', 'b', 'c']) {
      await writeFile(join(d, `onboard-${id}.jsonl`), '{}\n');
    }
    await createRunLog({ dir: d, runId: 'new', mode: 'metadata', maxLogs: 3 });

    const names = (await readdir(d)).sort();
    expect(names).toHaveLength(3);
    expect(names).toContain('onboard-new.jsonl');
  });

  it('finish never leaks arbitrary content or registered secrets', async () => {
    const metadataDir = await dir();
    const metadata = await createRunLog({
      dir: metadataDir,
      runId: 'summary-metadata',
      mode: 'metadata',
    });
    await metadata.finish({
      outcome: 'ok',
      content: 'private source text',
      api_key: 'opk_summary',
    });
    const metadataText = await readFile(metadata.path, 'utf8');
    expect(metadataText).not.toContain('private source text');
    expect(metadataText).not.toContain('opk_summary');

    const fullDir = await dir();
    const full = await createRunLog({
      dir: fullDir,
      runId: 'summary-full',
      mode: 'full',
      redact: ['opk_registered'],
    });
    await full.finish({
      api_key: 'opk_field',
      message: 'contains opk_registered',
    });
    const fullText = await readFile(full.path, 'utf8');
    expect(fullText).not.toContain('opk_field');
    expect(fullText).not.toContain('opk_registered');
    expect(fullText).toContain('[REDACTED]');
  });
});
