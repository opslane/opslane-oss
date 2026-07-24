import { describe, expect, it, vi } from 'vitest';
import { cacheProjectDefaultBranch } from '../db.js';

describe('cacheProjectDefaultBranch', () => {
  it('never throws when the update fails', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('connection reset')),
    };
    await expect(
      cacheProjectDefaultBranch('p1', 'master', pool as never),
    ).resolves.toBeUndefined();
  });

  it('never throws when the project no longer exists', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    await expect(
      cacheProjectDefaultBranch('gone', 'master', pool as never),
    ).resolves.toBeUndefined();
  });

  it('updates only when the cached value differs', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    await cacheProjectDefaultBranch('p1', 'master', pool as never);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('IS DISTINCT FROM'),
      ['p1', 'master'],
    );
  });
});
