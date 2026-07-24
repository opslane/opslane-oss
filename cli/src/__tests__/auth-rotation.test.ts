import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../fsutil.js', async () => {
  const actual = await vi.importActual<typeof import('../fsutil.js')>('../fsutil.js');
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

import { writeFileAtomic } from '../fsutil.js';
import { persistTokensTo, updateTokensAt } from '../auth.js';

const API = 'http://localhost:8082';
const ORIGIN = 'http://localhost:8082';
const BURNED = { accessToken: 'old', refreshToken: 'r-burned', expiresAt: Date.now() - 1_000 };
const ROTATED = { accessToken: 'new', refreshToken: 'r-rotated', expiresAt: Date.now() + 900_000 };

async function tokenPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'opslane-rotation-')), 'credentials.json');
}

describe('updateTokensAt rotation durability', () => {
  it('drops the pair it could not persist so the burned token is never replayed', async () => {
    const path = await tokenPath();
    await persistTokensTo(path, API, BURNED);

    // The server has already consumed r-burned by the time the write is
    // attempted, so failing to store r-rotated must not leave r-burned behind.
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(updateTokensAt(path, API, async () => ROTATED)).rejects.toThrow('ENOSPC');

    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.tokens[ORIGIN]).toBeUndefined();
    expect(JSON.stringify(onDisk)).not.toContain('r-burned');
    expect(JSON.stringify(onDisk)).not.toContain('r-rotated');
  });

  it('leaves the stored pair intact when the write succeeds', async () => {
    const path = await tokenPath();
    await persistTokensTo(path, API, BURNED);

    await expect(updateTokensAt(path, API, async () => ROTATED))
      .resolves.toMatchObject({ refreshToken: 'r-rotated' });

    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.tokens[ORIGIN]).toMatchObject({ refreshToken: 'r-rotated' });
  });
});
