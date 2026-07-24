import { mkdtemp, open, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withFileLock, writeFileAtomic } from '../fsutil.js';

async function target(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'opslane-fsutil-')), 'credentials.json');
}

describe('withFileLock', () => {
  it('reclaims a lock stranded by a run that was interrupted mid-hold', async () => {
    const path = await target();
    const lockPath = `${path}.lock`;
    // A `finally` never runs when a signal kills the process, so the lock the
    // dead run took is still on disk. Age it past the stale threshold.
    await (await open(lockPath, 'wx', 0o600)).close();
    const longAgo = new Date(Date.now() - 5 * 60_000);
    await utimes(lockPath, longAgo, longAgo);

    const started = Date.now();
    await withFileLock(path, async () => writeFileAtomic(path, 'ok\n'));

    expect(await readFile(path, 'utf8')).toBe('ok\n');
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent holders rather than reclaiming a live lock', async () => {
    const path = await target();
    const order: string[] = [];

    async function hold(label: string): Promise<void> {
      await withFileLock(path, async () => {
        order.push(`${label}:enter`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`${label}:exit`);
      });
    }

    await Promise.all([hold('a'), hold('b')]);

    // Never interleaved: each holder exits before the other enters.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(`${order[0]!.split(':')[0]}:exit`);
    expect(order[3]).toBe(`${order[2]!.split(':')[0]}:exit`);
  });

  it('releases the lock even when the operation throws', async () => {
    const path = await target();
    await expect(withFileLock(path, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
