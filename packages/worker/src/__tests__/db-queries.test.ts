import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg module
const mockQuery = vi.fn();
vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => ({ query: mockQuery, end: vi.fn() })) },
  Pool: vi.fn(() => ({ query: mockQuery, end: vi.fn() })),
}));

import {
  getErrorGroup,
  getErrorEvent,
  getProject,
  getReplayForGroup,
  getReplayArtifacts,
  getSourceMaps,
  requeueStaleJobs,
} from '../db.js';

describe('getErrorGroup', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns group data for valid ID with projectId scope', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'g1', title: 'TypeError: x', fingerprint: 'abc123',
        sample_event_id: 'e1', occurrence_count: 5, status: 'analyzing',
      }],
    });
    const group = await getErrorGroup('g1', 'p1');
    expect(group).toEqual(expect.objectContaining({ id: 'g1', title: 'TypeError: x' }));
    // Verify both groupId and projectId are passed as params
    expect(mockQuery.mock.calls[0][1]).toEqual(['g1', 'p1']);
  });

  it('returns null when group not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const group = await getErrorGroup('nonexistent', 'p1');
    expect(group).toBeNull();
  });
});

describe('getErrorEvent', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns event with all fields including release and session_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'e1', error_type: 'TypeError', error_message: 'x is not defined',
        stack_trace_raw: 'at foo.js:1', stack_trace_resolved: null,
        breadcrumbs: '[]', context: '{}', release: 'v1.0.0', session_id: 'sess-1',
      }],
    });
    const event = await getErrorEvent('e1', 'p1');
    expect(event).toEqual(expect.objectContaining({
      id: 'e1', breadcrumbs: '[]', context: '{}', release: 'v1.0.0', session_id: 'sess-1',
    }));
    expect(mockQuery.mock.calls[0][0]).toContain('breadcrumbs::text AS breadcrumbs');
    expect(mockQuery.mock.calls[0][0]).toContain('context::text AS context');
    expect(mockQuery.mock.calls[0][1]).toEqual(['e1', 'p1']);
  });
});

describe('getProject', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns project metadata', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'My App', github_repo: 'org/repo', default_branch: 'main' }],
    });
    const project = await getProject('p1');
    expect(project?.github_repo).toBe('org/repo');
  });
});

describe('getReplayForGroup', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns null when no replay exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const replay = await getReplayForGroup('g1', 'p1');
    expect(replay).toBeNull();
  });

  it('joins via session_id through error_events', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'r1', session_id: 'sess-1', status: 'complete',
        replay_signals: { console: {} }, object_key: 'replays/p1/r1.json',
      }],
    });
    const replay = await getReplayForGroup('g1', 'p1');
    expect(replay?.id).toBe('r1');
    // Verify query uses projectId scope
    expect(mockQuery.mock.calls[0][1]).toContain('p1');
  });
});

describe('getReplayArtifacts', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns artifact list with projectId scope', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'a1', kind: 'crash_viewport', object_key: 'replays/p1/a1.webp', content_type: 'image/webp', width: 1920, height: 1080 },
        { id: 'a2', kind: 'last_interaction_focus', object_key: 'replays/p1/a2.webp', content_type: 'image/webp', width: 800, height: 600 },
      ],
    });
    const artifacts = await getReplayArtifacts('r1', 'p1');
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].kind).toBe('crash_viewport');
  });
});

describe('getSourceMaps', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns source map entries for release', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 's1', filename: 'main.js', object_key: 'sourcemaps/p1/v1/main.js.map' }],
    });
    const maps = await getSourceMaps('p1', 'v1.0.0');
    expect(maps).toHaveLength(1);
    expect(maps[0].filename).toBe('main.js');
  });

  it('returns empty array when no maps exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const maps = await getSourceMaps('p1', 'v2.0.0');
    expect(maps).toEqual([]);
  });
});

describe('requeueStaleJobs — reconcile dead-lettered fix jobs', () => {
  beforeEach(() => mockQuery.mockReset());

  it('terminates a dead-lettered fix job group as needs_human (no stuck "fixing")', async () => {
    // 1st query: the stale-job UPDATE ... RETURNING → one fix job that dead-lettered.
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ error_group_id: 'g1', project_id: 'p1', job_type: 'fix', status: 'dead_letter' }],
    });
    // 2nd query: updateGroupStatus UPDATE error_groups ... needs_human
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const count = await requeueStaleJobs();
    expect(count).toBe(1);

    const statusCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE error_groups') && c[1]?.[2] === 'needs_human',
    );
    expect(statusCall, 'expected a needs_human reconciliation update').toBeTruthy();
    expect(statusCall![1][0]).toBe('g1');         // errorGroupId
    expect(statusCall![1][6]).toBe('lease_lost'); // reason_code
    expect(statusCall![1][7]).toBeTruthy();        // reason_message
    expect(statusCall![1][8]).toBeTruthy();        // remediation
  });

  it('leaves requeued (non-dead-letter) and non-fix dead-letter jobs alone', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        { error_group_id: 'g2', project_id: 'p1', job_type: 'fix', status: 'pending' },            // requeued, not dead
        { error_group_id: 'g3', project_id: 'p1', job_type: 'investigate', status: 'dead_letter' }, // not a fix job
      ],
    });

    const count = await requeueStaleJobs();
    expect(count).toBe(2);

    const statusCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE error_groups'),
    );
    expect(statusCall).toBeUndefined();
  });
});
