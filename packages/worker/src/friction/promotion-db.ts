import type pg from 'pg';

/**
 * DB primitives for Batch 4 fold/promotion (issue #56). Every function takes
 * a checked-out client so callers control transaction boundaries; the
 * orchestration in promotion.ts owns BEGIN/COMMIT and advisory locking.
 */

/** Atomically claims signals for one adjudication attempt: records the owning
 * session_analysis job and increments the per-signal attempt counter. Only
 * 'pending' rows are claimable — accepted/rejected/unchecked are terminal for
 * claiming purposes. Returns how many rows were claimed. */
export async function claimSignalsForAdjudication(
  client: pg.PoolClient,
  signalIds: string[],
  jobId: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE friction_signals
     SET adjudication_job_id = $2,
         adjudication_attempts = adjudication_attempts + 1
     WHERE id = ANY($1::uuid[]) AND adjudication_status = 'pending'`,
    [signalIds, jobId],
  );
  return res.rowCount ?? 0;
}

export interface FoldTarget {
  errorGroupId: string;
  status: string;
}

/** Finds the fold target for a signal: the nearest same-session error event
 * (client time, inclusive ±30s) whose group is a non-archived error incident.
 * Ties break on event recency distance first, then group id, so retries pick
 * the same target. Archived groups are permanent dismissals and friction
 * incidents are never fold targets. */
export async function findFoldTarget(
  client: pg.PoolClient,
  projectId: string,
  sessionId: string,
  occurredAt: string,
): Promise<FoldTarget | null> {
  const { rows } = await client.query<{ error_group_id: string; status: string }>(
    `SELECT eg.id AS error_group_id, eg.status
       FROM error_events ee
       JOIN error_groups eg ON eg.id = ee.error_group_id
      WHERE ee.session_id = $2
        AND ee.project_id = $1
        AND eg.kind = 'error'
        AND eg.status <> 'archived'
        AND ee."timestamp" BETWEEN $3::timestamptz - interval '30 seconds'
                                AND $3::timestamptz + interval '30 seconds'
      ORDER BY abs(extract(epoch FROM (ee."timestamp" - $3::timestamptz))), eg.id
      LIMIT 1`,
    [projectId, sessionId, occurredAt],
  );
  const row = rows[0];
  return row ? { errorGroupId: row.error_group_id, status: row.status } : null;
}
