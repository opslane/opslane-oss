import { createHash } from 'node:crypto';
import type pg from 'pg';
import { getPool } from '../db.js';
import type { AdjudicationVerdict } from './adjudicator.js';

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

/** Row shape consumed by the fold path (matches friction_signals columns). */
export interface FoldSignal {
  id: string;
  project_id: string;
  environment_id: string;
  end_user_id: string | null;
  session_id: string;
  fingerprint: string;
  occurred_at: string;
}

export interface FoldMeta {
  modelId: string;
  promptVersion: number;
  jobId: string;
}

export type FoldOutcome = 'attached' | 'rejected' | 'no_target' | 'noop';

/** Stable 2×int32 advisory-lock key for a (project, environment, fingerprint)
 * tuple, shared by fold and bucket paths so they serialize with each other. */
export function tupleLockKey(
  projectId: string,
  environmentId: string,
  fingerprint: string,
): [number, number] {
  const digest = createHash('sha256')
    .update(`${projectId}:${environmentId}:${fingerprint}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * One transaction that persists an eager-fold verdict and applies its visible
 * outcome atomically (plan: atomic promotion and impact).
 *
 * - Serialized per tuple with an advisory transaction lock.
 * - Re-checks the row under lock: active, not superseded, not attached.
 * - Idempotent: `incident_id` is the attachment guard; a retry that finds an
 *   accepted-but-unattached row resumes attachment (crash recovery), while
 *   rejected/unchecked and accepted-and-attached rows are terminal no-ops.
 * - Terminal fold behavior (plan D6): impact updates on resolved/merged
 *   targets without a status change and without enqueueing anything.
 */
export async function applyFoldOutcome(opts: {
  signal: FoldSignal;
  verdict: AdjudicationVerdict;
  meta: FoldMeta;
}): Promise<FoldOutcome> {
  const { signal, verdict, meta } = opts;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const [k1, k2] = tupleLockKey(signal.project_id, signal.environment_id, signal.fingerprint);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

    const { rows } = await client.query<{
      adjudication_status: string;
      incident_id: string | null;
    }>(
      `SELECT adjudication_status, incident_id
       FROM friction_signals
       WHERE id = $1 AND project_id = $2
         AND retracted_at IS NULL AND superseded_by IS NULL
       FOR UPDATE`,
      [signal.id, signal.project_id],
    );
    const current = rows[0];
    if (
      !current ||
      current.incident_id !== null ||
      current.adjudication_status === 'rejected' ||
      current.adjudication_status === 'unchecked'
    ) {
      await client.query('COMMIT');
      return 'noop';
    }

    // Persist the verdict audit. Also runs on crash-resume (status already
    // 'accepted'): the audit fields are refreshed, the outcome is re-applied.
    await client.query(
      `UPDATE friction_signals
       SET adjudication_status = $2,
           adjudication_scope = 'fold',
           adjudicated_at = now(),
           adjudication_model = $3,
           adjudication_prompt_version = $4,
           adjudication_reason = $5
       WHERE id = $1`,
      [
        signal.id,
        verdict.accepted ? 'accepted' : 'rejected',
        meta.modelId,
        meta.promptVersion,
        verdict.reason,
      ],
    );
    if (!verdict.accepted) {
      await client.query('COMMIT');
      return 'rejected';
    }

    const target = await findFoldTarget(
      client,
      signal.project_id,
      signal.session_id,
      signal.occurred_at,
    );
    if (!target) {
      // Verdict stays persisted; the caller continues down the bucket path.
      await client.query('COMMIT');
      return 'no_target';
    }

    // Attach exactly once, update impact incrementally, preserve the target's
    // status, and never enqueue work on a fold.
    await client.query(
      `UPDATE friction_signals SET incident_id = $2 WHERE id = $1`,
      [signal.id, target.errorGroupId],
    );
    await client.query(
      `UPDATE error_groups
       SET occurrence_count = occurrence_count + 1,
           first_seen = LEAST(first_seen, $2::timestamptz),
           last_seen = GREATEST(last_seen, $2::timestamptz),
           updated_at = now()
       WHERE id = $1`,
      [target.errorGroupId, signal.occurred_at],
    );
    if (signal.end_user_id) {
      await client.query(
        `INSERT INTO error_group_affected_users
           (error_group_id, end_user_id, first_seen, last_seen, occurrence_count)
         VALUES ($1, $2, $3, $3, 1)
         ON CONFLICT (error_group_id, end_user_id) DO UPDATE
           SET first_seen = LEAST(error_group_affected_users.first_seen, EXCLUDED.first_seen),
               last_seen = GREATEST(error_group_affected_users.last_seen, EXCLUDED.last_seen),
               occurrence_count = error_group_affected_users.occurrence_count + 1`,
        [target.errorGroupId, signal.end_user_id, signal.occurred_at],
      );
      await client.query(
        `UPDATE error_groups
         SET affected_users_count =
           (SELECT COUNT(*) FROM error_group_affected_users WHERE error_group_id = $1)
         WHERE id = $1`,
        [target.errorGroupId],
      );
    }
    // Evidence pin (plan: exact 90-day horizon from session start).
    await client.query(
      `UPDATE sessions
       SET retain_until = GREATEST(
             COALESCE(retain_until, 'epoch'::timestamptz),
             started_at + interval '90 days')
       WHERE id = $1 AND project_id = $2`,
      [signal.session_id, signal.project_id],
    );

    await client.query('COMMIT');
    return 'attached';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Full impact rebuild from active source rows: the incident's own error
 * events plus attached, non-retracted, non-superseded friction signals.
 * Reserved for promotion materialization and supersession/retraction (plan:
 * normal folds stay incremental); reversibility requires recomputation here.
 */
export async function recomputeIncidentImpact(
  client: pg.PoolClient,
  incidentId: string,
  projectId: string,
): Promise<void> {
  await client.query(
    `UPDATE error_groups eg
     SET occurrence_count = src.n,
         first_seen = COALESCE(src.first_at, eg.first_seen),
         last_seen = COALESCE(src.last_at, eg.last_seen),
         updated_at = now()
     FROM (
       SELECT COUNT(*)::int AS n, MIN(at) AS first_at, MAX(at) AS last_at
       FROM (
         SELECT "timestamp" AS at FROM error_events
          WHERE error_group_id = $1 AND project_id = $2
         UNION ALL
         SELECT occurred_at FROM friction_signals
          WHERE incident_id = $1 AND project_id = $2
            AND retracted_at IS NULL AND superseded_by IS NULL
       ) source_rows
     ) src
     WHERE eg.id = $1 AND eg.project_id = $2`,
    [incidentId, projectId],
  );
  await client.query(
    `DELETE FROM error_group_affected_users WHERE error_group_id = $1`,
    [incidentId],
  );
  await client.query(
    `INSERT INTO error_group_affected_users
       (error_group_id, end_user_id, first_seen, last_seen, occurrence_count)
     SELECT $1, end_user_id, MIN(at), MAX(at), COUNT(*)::int
     FROM (
       SELECT end_user_id, "timestamp" AS at FROM error_events
        WHERE error_group_id = $1 AND project_id = $2 AND end_user_id IS NOT NULL
       UNION ALL
       SELECT end_user_id, occurred_at FROM friction_signals
        WHERE incident_id = $1 AND project_id = $2 AND end_user_id IS NOT NULL
          AND retracted_at IS NULL AND superseded_by IS NULL
     ) source_rows
     GROUP BY end_user_id`,
    [incidentId, projectId],
  );
  await client.query(
    `UPDATE error_groups
     SET affected_users_count =
       (SELECT COUNT(*) FROM error_group_affected_users WHERE error_group_id = $1)
     WHERE id = $1 AND project_id = $2`,
    [incidentId, projectId],
  );
}
