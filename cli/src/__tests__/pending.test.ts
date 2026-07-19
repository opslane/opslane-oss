import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deletePendingSession, loadPendingSession, savePendingSession } from '../pending.js';

const pollId = '123e4567-e89b-42d3-a456-426614174000';

describe('pending session store', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'opslane-pending-')); });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it('round-trips, canonicalizes the origin, and writes mode 0600 atomically', async () => {
    await savePendingSession({
      poll_id: pollId, poll_token: 'secret', api_url: 'HTTPS://API.OPSLANE.COM/path',
      repo: 'acme/app', created_at: '2026-07-18T00:00:00.000Z',
    }, directory);
    await expect(loadPendingSession(pollId, directory)).resolves.toMatchObject({
      poll_token: 'secret', api_url: 'https://api.opslane.com',
    });
    expect((await stat(join(directory, `${pollId}.json`))).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('deletes completed state and tolerates missing/garbage files', async () => {
    await expect(loadPendingSession(pollId, directory)).resolves.toBeNull();
    await writeFile(join(directory, `${pollId}.json`), '{bad');
    await expect(loadPendingSession(pollId, directory)).resolves.toBeNull();
    await deletePendingSession(pollId, directory);
    await expect(loadPendingSession(pollId, directory)).resolves.toBeNull();
  });

  it('rejects non-UUID poll IDs before path construction', async () => {
    await expect(loadPendingSession('../evil', directory)).rejects.toThrow('UUID');
    await expect(savePendingSession({
      poll_id: '../evil', poll_token: 'x', api_url: 'https://api.opslane.com',
      repo: 'a/b', created_at: new Date().toISOString(),
    }, directory)).rejects.toThrow('UUID');
  });
});
