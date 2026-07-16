import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({ query: mockQuery, end: vi.fn() })),
  },
}));

import { resolveInactiveGroups, resolveSilentMergedGroups } from '../db.js';

describe('resolveInactiveGroups', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('only resolves inactive eligible statuses and stamps resolution provenance', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'needs-human' }, { id: 'investigated' }] });

    await expect(resolveInactiveGroups(14)).resolves.toEqual(['needs-human', 'investigated']);

    const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(sql).toContain("g.status IN ('needs_human', 'investigated')");
    expect(sql).not.toContain("'pr_created'");
    expect(sql).toContain("resolved_reason = 'auto_resolved'");
    expect(sql).toContain('resolved_at = now()');
    expect(sql).toContain('resolved_in_release = (');
    expect(sql).toContain('WHERE project_id = g.project_id');
    expect(sql).toContain("release IS NOT NULL AND release <> ''");
    expect(sql).toContain('GROUP BY release ORDER BY min(created_at) DESC LIMIT 1');
    expect(sql).toContain("g.last_seen < now() - ($1 || ' days')::interval");
    expect(params).toEqual(['14']);
  });

  it('stamps merged provenance using the same newest-release ranking', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'merged-group' }] });

    await expect(resolveSilentMergedGroups()).resolves.toEqual(['merged-group']);

    const sql = String(mockQuery.mock.calls[0]?.[0]);
    expect(sql).toContain("resolved_reason = 'merged'");
    expect(sql).toContain('resolved_in_release = (');
    expect(sql).toContain('WHERE project_id = g.project_id');
    expect(sql).toContain('GROUP BY release ORDER BY min(created_at) DESC LIMIT 1');
  });
});
