import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  scanReliabilityInvariants,
  type PgQueryable,
} from '../invariant-scanner.js';

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function mockQueryable(...results: QueryResult<QueryResultRow>[]): {
  db: PgQueryable;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { db: { query } as PgQueryable, query };
}

describe('scanReliabilityInvariants', () => {
  it('returns structured violations for every invariant class', async () => {
    const leaseExpiry = new Date('2026-07-15T10:00:00.000Z');
    const { db, query } = mockQueryable(
      queryResult([
        {
          id: 'group-needs-human',
          project_id: 'project-1',
          status: 'needs_human',
          reason_code: 'worker_runtime_error',
          reason_message: '  ',
          remediation: null,
          pr_url: null,
          pr_number: null,
          confidence: null,
        },
        {
          id: 'group-pr',
          project_id: 'project-1',
          status: 'pr_created',
          reason_code: null,
          reason_message: null,
          remediation: null,
          pr_url: '',
          pr_number: 0,
          confidence: null,
        },
      ]),
      queryResult([
        {
          id: 'group-needs-human-with-pr',
          project_id: 'project-1',
          status: 'needs_human',
          pr_url: 'https://example.test/pull/9',
          pr_number: 9,
        },
        {
          id: 'group-pr-with-http-url',
          project_id: 'project-1',
          status: 'pr_created',
          pr_url: 'http://example.test/pull/10',
          pr_number: 10,
        },
      ]),
      queryResult([
        { id: 'group-active', project_id: 'project-1', status: 'analyzing' },
      ]),
      queryResult([
        {
          id: 'group-terminal',
          project_id: 'project-1',
          status: 'resolved',
          live_job_ids: ['job-1', 'job-2'],
        },
      ]),
      queryResult([
        {
          id: 'job-expired',
          error_group_id: 'group-active',
          project_id: 'project-1',
          worker_id: 'worker-1',
          lease_expires_at: leaseExpiry,
        },
        {
          id: 'job-no-expiry',
          error_group_id: null,
          project_id: 'project-1',
          worker_id: 'worker-2',
          lease_expires_at: null,
        },
      ]),
    );

    const violations = await scanReliabilityInvariants(db);

    expect(violations).toEqual([
      expect.objectContaining({
        code: 'terminal_fields_incomplete',
        errorGroupId: 'group-needs-human',
        missingFields: ['reason_message', 'remediation'],
      }),
      expect.objectContaining({
        code: 'terminal_fields_incomplete',
        errorGroupId: 'group-pr',
        missingFields: ['pr_url', 'pr_number', 'confidence'],
      }),
      expect.objectContaining({
        code: 'terminal_fields_incompatible',
        errorGroupId: 'group-needs-human-with-pr',
        incompatibleFields: ['pr_url', 'pr_number'],
      }),
      expect.objectContaining({
        code: 'terminal_fields_incompatible',
        errorGroupId: 'group-pr-with-http-url',
        invalidFields: ['pr_url'],
      }),
      expect.objectContaining({
        code: 'active_group_without_live_job',
        errorGroupId: 'group-active',
        status: 'analyzing',
      }),
      expect.objectContaining({
        code: 'terminal_group_with_live_job',
        errorGroupId: 'group-terminal',
        liveJobIds: ['job-1', 'job-2'],
      }),
      expect.objectContaining({
        code: 'expired_claimed_job',
        jobId: 'job-expired',
        leaseExpiresAt: '2026-07-15T10:00:00.000Z',
      }),
      expect.objectContaining({
        code: 'expired_claimed_job',
        jobId: 'job-no-expiry',
        leaseExpiresAt: null,
      }),
    ]);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('returns no violations when every query is empty', async () => {
    const { db } = mockQueryable(
      queryResult([]),
      queryResult([]),
      queryResult([]),
      queryResult([]),
      queryResult([]),
    );

    await expect(scanReliabilityInvariants(db)).resolves.toEqual([]);
  });

  it('uses only read-only SELECT statements', async () => {
    const { db, query } = mockQueryable(
      queryResult([]),
      queryResult([]),
      queryResult([]),
      queryResult([]),
      queryResult([]),
    );

    await scanReliabilityInvariants(db);

    for (const [sql] of query.mock.calls) {
      expect(sql.trimStart()).toMatch(/^SELECT\b/);
    }
  });

  it('propagates query failures to avoid a false clean report', async () => {
    const failure = new Error('database unavailable');
    const query = vi.fn().mockRejectedValueOnce(failure);
    const db = { query } as PgQueryable;

    await expect(scanReliabilityInvariants(db)).rejects.toBe(failure);
  });
});
