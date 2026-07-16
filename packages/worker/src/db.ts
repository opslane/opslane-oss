import pg from 'pg';
import type { ErrorGroupStatus, NeedsHumanReason, ConfidenceLevel, JobType, SetupPrStatus } from '@opslane/shared';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env['DATABASE_URL'],
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export interface ClaimedJob {
  id: string;
  workerId: string;
  errorGroupId: string | null;
  sourceId: string | null;
  projectId: string;
  jobType: JobType;
  attempts: number;
  guidance: string | null;
  /** Monotonically increasing fencing token for this claim. */
  leaseGeneration: string;
  triggeredBy: 'auto' | 'human' | null;
  sessionId: string | null;
}

export interface JobLease {
  id: string;
  workerId: string;
  leaseGeneration: string;
  projectId: string;
  errorGroupId: string | null;
  sessionId: string | null;
}

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Job lease lost for ${jobId}`);
    this.name = 'LeaseLostError';
  }
}

export async function assertJobLease(lease: JobLease): Promise<void> {
  const result = await getPool().query(
    `SELECT 1
     FROM error_group_jobs
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND project_id = $4
       AND error_group_id IS NOT DISTINCT FROM $5::uuid
       AND session_id IS NOT DISTINCT FROM $6
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [
      lease.id,
      lease.workerId,
      lease.leaseGeneration,
      lease.projectId,
      lease.errorGroupId,
      lease.sessionId,
    ],
  );
  if ((result.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);
}

/** Default fleet-wide ceiling on concurrently claimed session_analysis jobs. */
const DEFAULT_SESSION_ANALYSIS_CAP = 2;

function sessionAnalysisCapFromEnv(): number {
  const raw = process.env['SESSION_ANALYSIS_MAX_CONCURRENT'];
  if (raw === undefined || raw === '') return DEFAULT_SESSION_ANALYSIS_CAP;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SESSION_ANALYSIS_CAP;
}

/** Claims one pending job using FOR UPDATE SKIP LOCKED (issue #28 scheduling).
 *
 * Policy, in order:
 * 1. error_fix always wins — rare, human-facing work is never queued behind
 *    background analysis.
 * 2. session_analysis is capped: it is claimable only while fewer than
 *    `sessionAnalysisCap` analysis jobs hold a live lease.
 * 3. Within the remaining work, the analysis lane and the interactive lane
 *    (investigate/fix/setup_pr) alternate: analysis is preferred only when
 *    its most recent claim is older than the interactive lane's. A fix
 *    backlog therefore cannot starve analysis, and an analysis backlog
 *    cannot starve fixes, without any scheduler state outside the jobs table.
 *
 * Admission is serialized with a transaction-scoped advisory lock: without
 * it, simultaneous claimers all read the same running count and lane maxima
 * and can overshoot the cap by up to the fleet size. Claims are
 * millisecond-scale single-row updates against multi-second poll intervals,
 * so the serialization is not a throughput concern.
 *
 * Lease and terminal-status semantics are untouched: only the candidate
 * selection changed. */
export async function claimJob(
  workerId: string,
  leaseDurationMs: number,
  sessionAnalysisCap: number = sessionAnalysisCapFromEnv()
): Promise<ClaimedJob | null> {
  const client = await getPool().connect();
  let result: pg.QueryResult<{
    id: string;
    error_group_id: string | null;
    source_id: string | null;
    project_id: string;
    job_type: JobType;
    attempts: number;
    guidance: string | null;
    worker_id: string;
    lease_generation: string;
    triggered_by: 'auto' | 'human' | null;
    session_id: string | null;
  }>;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('opslane-job-claim'))`
    );
    result = await client.query(
      `UPDATE error_group_jobs
     SET status = 'claimed',
         worker_id = $1,
         claimed_at = now(),
         lease_expires_at = now() + make_interval(secs => $2::double precision),
         lease_generation = lease_generation + 1,
         updated_at = now()
     WHERE id = (
       SELECT id FROM error_group_jobs
       WHERE status = 'pending'
         AND (job_type <> 'session_analysis'
              OR (SELECT COUNT(*) FROM error_group_jobs
                   WHERE status = 'claimed'
                     AND job_type = 'session_analysis'
                     AND lease_expires_at > now()) < $3)
       ORDER BY CASE
         WHEN job_type = 'error_fix' THEN 0
         WHEN job_type = 'session_analysis'
              AND COALESCE((SELECT MAX(claimed_at) FROM error_group_jobs
                             WHERE job_type = 'session_analysis'), 'epoch'::timestamptz)
                < COALESCE((SELECT MAX(claimed_at) FROM error_group_jobs
                             WHERE job_type <> 'session_analysis'), 'epoch'::timestamptz)
           THEN 1
         WHEN job_type <> 'session_analysis' THEN 2
         ELSE 3
       END, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, error_group_id, source_id, project_id, job_type, attempts, guidance,
               worker_id, lease_generation::text AS lease_generation,
               triggered_by, session_id`,
      [workerId, leaseDurationMs / 1000, sessionAnalysisCap]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    workerId: row.worker_id,
    errorGroupId: row.error_group_id,
    sourceId: row.source_id,
    projectId: row.project_id,
    jobType: row.job_type,
    attempts: row.attempts,
    guidance: row.guidance,
    leaseGeneration: row.lease_generation,
    triggeredBy: row.triggered_by,
    sessionId: row.session_id,
  };
}

/** Extends the lease on a claimed job. Returns false if the job is no longer owned by this worker. */
export async function heartbeat(
  jobId: string,
  workerId: string,
  leaseGeneration: string,
  leaseDurationMs: number
): Promise<boolean> {
  const db = getPool();
  const result = await db.query(
    `UPDATE error_group_jobs
     SET lease_expires_at = now() + make_interval(secs => $4::double precision),
         updated_at = now()
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [jobId, workerId, leaseGeneration, leaseDurationMs / 1000]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Marks a claimed job as completed. */
export async function completeJob(
  jobId: string,
  workerId: string,
  leaseGeneration: string
): Promise<boolean> {
  const db = getPool();
  const result = await db.query(
    `UPDATE error_group_jobs
     SET status = 'completed',
         updated_at = now()
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [jobId, workerId, leaseGeneration]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Fails a job: increments attempts and records the error.
 * Resets to 'pending' for retry, or 'dead_letter' at max_attempts.
 */
export async function failJob(
  jobId: string,
  workerId: string,
  leaseGeneration: string,
  error: string
): Promise<boolean> {
  const db = getPool();
  const result = await db.query(
    `UPDATE error_group_jobs
     SET attempts = attempts + 1,
         last_error = $4,
         status = CASE
           WHEN attempts + 1 >= max_attempts THEN 'dead_letter'::job_status
           ELSE 'pending'::job_status
         END,
         worker_id = CASE
           WHEN attempts + 1 >= max_attempts THEN worker_id
           ELSE NULL
         END,
         claimed_at = CASE
           WHEN attempts + 1 >= max_attempts THEN claimed_at
           ELSE NULL
         END,
         lease_expires_at = CASE
           WHEN attempts + 1 >= max_attempts THEN lease_expires_at
           ELSE NULL
         END,
         updated_at = now()
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [jobId, workerId, leaseGeneration, error]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Reaper: reclaims jobs with expired leases.
 * Resets to 'pending' for retry, or 'dead_letter' at max_attempts.
 */
export async function requeueStaleJobs(): Promise<number> {
  const db = getPool();
  const result = await db.query<{
    error_group_id: string | null;
    session_id: string | null;
    project_id: string;
    job_type: JobType;
    status: string;
  }>(
    `UPDATE error_group_jobs
     SET attempts = attempts + 1,
         status = CASE
           WHEN attempts + 1 >= max_attempts THEN 'dead_letter'::job_status
           ELSE 'pending'::job_status
         END,
         last_error = CASE
           WHEN attempts + 1 >= max_attempts THEN 'dead-lettered by reaper: lease expired ' || (attempts + 1) || ' times'
           ELSE 'reaper: lease expired (attempt ' || (attempts + 1) || ')'
         END,
         worker_id = CASE
           WHEN attempts + 1 >= max_attempts THEN worker_id
           ELSE NULL
         END,
         claimed_at = CASE
           WHEN attempts + 1 >= max_attempts THEN claimed_at
           ELSE NULL
         END,
         lease_expires_at = CASE
           WHEN attempts + 1 >= max_attempts THEN lease_expires_at
           ELSE NULL
         END,
         updated_at = now()
     WHERE status = 'claimed' AND lease_expires_at < now()
     RETURNING error_group_id, session_id, project_id, job_type, status`
  );

  // Reconcile any FIX job that just dead-lettered: its error group is stuck in
  // 'fixing' and will never resolve on its own. Terminate it as needs_human with a
  // complete reason so the incident doesn't hang (and the writeup is preserved).
  for (const row of result.rows) {
    if (
      row.status === 'dead_letter' &&
      (row.job_type === 'fix' || row.job_type === 'error_fix') &&
      row.error_group_id
    ) {
      await updateGroupStatus(row.error_group_id, row.project_id, 'needs_human', {
        reason: {
          reason_code: 'lease_lost',
          reason_message: 'The fix job exceeded its retry limit (repeated lease expiry) and was abandoned.',
          remediation:
            'Re-run the fix from the incident, or review manually — the worker could not hold a lease long enough to finish.',
        },
      }).catch(() => {});
    }
    if (
      row.status === 'dead_letter' &&
      row.job_type === 'session_analysis' &&
      row.session_id
    ) {
      await db.query(
        `UPDATE sessions
         SET status = 'analysis_failed'
         WHERE id = $1 AND project_id = $2`,
        [row.session_id, row.project_id],
      ).catch(() => {});
    }
  }

  return result.rowCount ?? 0;
}

/** Stores the Langfuse trace URL on a job row (fire-and-forget). */
export async function updateJobTraceUrl(
  jobId: string,
  workerId: string,
  leaseGeneration: string,
  traceUrl: string
): Promise<boolean> {
  const db = getPool();
  const result = await db.query(
    `UPDATE error_group_jobs
     SET trace_url = $4, updated_at = now()
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [jobId, workerId, leaseGeneration, traceUrl]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Updates the error_group status and optional resolution fields.
 * Enforces terminal reason contract: needs_human MUST include reason fields.
 */
export async function updateGroupStatus(
  errorGroupId: string,
  projectId: string,
  status: ErrorGroupStatus,
  fields?: {
    confidence?: ConfidenceLevel;
    pr_url?: string;
    pr_number?: number;
    reason?: NeedsHumanReason;
  },
  lease?: JobLease,
): Promise<void> {
  if (status === 'needs_human') {
    const reason = fields?.reason;
    if (!reason) {
      throw new Error(
        `needs_human requires reason fields (reason_code, reason_message, remediation) for group ${errorGroupId}`
      );
    }
    if (!reason.reason_code || !reason.reason_message || !reason.remediation) {
      throw new Error(
        `needs_human reason fields must all be non-empty for group ${errorGroupId}`
      );
    }
  }

  const reason = fields?.reason;
  const db = getPool();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $10
           AND worker_id = $11
           AND lease_generation = $12::bigint
           AND project_id = $2
           AND error_group_id = $1
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  const result = await db.query(
    `${ownedCte}
     UPDATE error_groups
     SET status = $3::error_group_status,
         confidence = $4,
         pr_url = $5,
         pr_number = $6,
         reason_code = $7,
         reason_message = $8,
         remediation = $9,
         updated_at = now()
     WHERE id = $1 AND project_id = $2
       ${lease ? 'AND EXISTS (SELECT 1 FROM owned)' : ''}
     RETURNING id`,
    [
      errorGroupId,
      projectId,
      status,
      fields?.confidence ?? null,
      fields?.pr_url ?? null,
      fields?.pr_number ?? null,
      reason?.reason_code ?? null,
      reason?.reason_message ?? null,
      reason?.remediation ?? null,
      ...(lease ? [lease.id, lease.workerId, lease.leaseGeneration] : []),
    ]
  );
  if (lease && (result.rowCount ?? 0) === 0) {
    throw new LeaseLostError(lease.id);
  }
}

/**
 * System-level background query: resolves all merged groups across all tenants
 * that have had no new error events since merged_at and where merged_at is
 * older than 24 hours. Intentionally not tenant-scoped.
 * Returns the IDs of resolved groups.
 */
export async function resolveSilentMergedGroups(): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE error_groups
     SET status = 'resolved', resolved_at = now(), updated_at = now()
     WHERE status = 'merged'
       AND merged_at < now() - interval '24 hours'
       AND NOT EXISTS (
         SELECT 1
         FROM error_events
         WHERE error_group_id = error_groups.id
           AND created_at > error_groups.merged_at
       )
       -- Ongoing linked friction blocks silence resolution (issue #56):
       -- an incident with active accepted friction after the merge is not
       -- silent even when no new error events arrive.
       AND NOT EXISTS (
         SELECT 1
         FROM friction_signals fs
         WHERE fs.incident_id = error_groups.id
           AND fs.adjudication_status = 'accepted'
           AND fs.retracted_at IS NULL
           AND fs.superseded_by IS NULL
           AND fs.occurred_at > error_groups.merged_at
       )
     RETURNING id`
  );
  return result.rows.map(r => r.id);
}

// === GitHub installation query ===

export async function getProjectGitHubInstallation(projectId: string): Promise<{
  installationId: number | null;
  githubRepo: string | null;
} | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    github_installation_id: number | null;
    github_repo: string | null;
  }>(
    `SELECT o.github_installation_id, p.github_repo
     FROM projects p
     JOIN orgs o ON o.id = p.org_id
     WHERE p.id = $1`,
    [projectId],
  );
  if (!rows[0]) return null;
  return {
    installationId: rows[0].github_installation_id,
    githubRepo: rows[0].github_repo,
  };
}

// === Data fetch queries (used by processJob) ===
// Every query includes projectId for tenant isolation per CLAUDE.md rules.

export interface ErrorGroupData {
  id: string;
  title: string;
  fingerprint: string;
  sample_event_id: string;
  occurrence_count: number;
  status: string;
  kind: 'error' | 'friction';
  signal_type: string | null;
  element_selector: string | null;
  page_url_normalized: string | null;
}

export async function getErrorGroup(groupId: string, projectId: string): Promise<ErrorGroupData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ErrorGroupData>(
    `SELECT id, title, fingerprint, sample_event_id, occurrence_count, status,
            kind, signal_type, element_selector, page_url_normalized
     FROM error_groups WHERE id = $1 AND project_id = $2`,
    [groupId, projectId],
  );
  return rows[0] ?? null;
}

export interface ErrorEventData {
  id: string;
  error_type: string;
  error_message: string;
  stack_trace_raw: string;
  stack_trace_resolved: unknown;
  breadcrumbs: string;
  context: string;
  release: string | null;
  session_id: string | null;
}

export async function getErrorEvent(eventId: string, projectId: string): Promise<ErrorEventData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ErrorEventData>(
    `SELECT id, error_type, error_message, stack_trace_raw, stack_trace_resolved,
            breadcrumbs::text AS breadcrumbs, context::text AS context, release, session_id
     FROM error_events WHERE id = $1 AND project_id = $2`,
    [eventId, projectId],
  );
  return rows[0] ?? null;
}

export interface ProjectData {
  id: string;
  name: string;
  github_repo: string;
  default_branch: string;
}

export async function getProject(projectId: string): Promise<ProjectData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ProjectData>(
    `SELECT id, name, github_repo, default_branch
     FROM projects WHERE id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

export async function recordSetupPrResult(
  projectId: string,
  status: SetupPrStatus,
  fields: { pr_url?: string; pr_number?: number; error?: string } = {},
  lease?: JobLease,
): Promise<void> {
  const pool = getPool();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $6
           AND worker_id = $7
           AND lease_generation = $8::bigint
           AND project_id = $1
           AND error_group_id IS NOT DISTINCT FROM $9::uuid
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  const result = await pool.query(
    `${ownedCte}
     UPDATE projects
        SET setup_pr_status = $2,
            setup_pr_url = COALESCE($3, setup_pr_url),
            setup_pr_number = COALESCE($4, setup_pr_number),
            setup_pr_error = $5
      WHERE id = $1
        ${lease ? 'AND EXISTS (SELECT 1 FROM owned)' : ''}
      RETURNING id`,
    [
      projectId,
      status,
      fields.pr_url ?? null,
      fields.pr_number ?? null,
      fields.error ?? null,
      ...(lease
        ? [lease.id, lease.workerId, lease.leaseGeneration, lease.errorGroupId]
        : []),
    ],
  );
  if (lease && (result.rowCount ?? 0) === 0) {
    throw new LeaseLostError(lease.id);
  }
}

export interface ReplayData {
  id: string;
  session_id: string;
  status: string;
  replay_signals: unknown;
  object_key: string | null;
  trigger_type: string | null;
  page_url: string | null;
  started_at: string | null;
  ended_at: string | null;
  size_bytes: number | null;
}

/** Finds replay for error group -- joins via session_id on error_events when error_group_id is null. */
export async function getReplayForGroup(errorGroupId: string, projectId: string): Promise<ReplayData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ReplayData>(
    `SELECT sr.id, sr.session_id, sr.status, sr.replay_signals, sr.object_key,
            sr.trigger_type, sr.page_url, sr.started_at, sr.ended_at, sr.size_bytes
     FROM session_replays sr
     WHERE sr.project_id = $2
       AND sr.status = 'complete'
       AND (
         sr.error_group_id = $1
         OR sr.session_id IN (
           SELECT ee.session_id FROM error_events ee
           JOIN error_groups eg ON eg.sample_event_id = ee.id
           WHERE eg.id = $1 AND ee.session_id IS NOT NULL
         )
       )
     ORDER BY sr.created_at DESC LIMIT 1`,
    [errorGroupId, projectId],
  );
  return rows[0] ?? null;
}

export interface SessionPointer {
  session_id: string;
  error_at: string;
}

/** Resolves pointer identity independently from chunk readiness. */
export async function getSessionPointerForGroup(
  errorGroupId: string,
  projectId: string,
): Promise<SessionPointer | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ session_id: string; error_at: Date | string }>(
    `SELECT ee.session_id, ee.timestamp AS error_at
       FROM error_events ee
       JOIN sessions s ON s.id = ee.session_id AND s.project_id = $2
      WHERE ee.error_group_id = $1
        AND ee.project_id = $2
        AND ee.session_id IS NOT NULL
        AND s.status <> 'deleting'
      ORDER BY ee.created_at DESC, ee.id DESC
      LIMIT 1`,
    [errorGroupId, projectId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    session_id: row.session_id,
    error_at: row.error_at instanceof Date ? row.error_at.toISOString() : row.error_at,
  };
}

export interface SessionChunkMeta {
  seq: number;
  size_bytes: number | null;
  decoded_size_bytes: number | null;
  has_full_snapshot: boolean;
  first_event_ms: number | null;
  last_event_ms: number | null;
}

function nullableNumber(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Returns only scrubbed chunks belonging to the requested project/session. */
export async function getPlayableChunkMetas(
  sessionId: string,
  projectId: string,
): Promise<SessionChunkMeta[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    seq: number;
    size_bytes: string | number | null;
    decoded_size_bytes: string | number | null;
    has_full_snapshot: boolean;
    first_event_ms: string | number | null;
    last_event_ms: string | number | null;
  }>(
    `SELECT c.seq, c.size_bytes, c.decoded_size_bytes, c.has_full_snapshot,
            c.first_event_ms, c.last_event_ms
       FROM session_chunks c
       JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id = $1
        AND s.project_id = $2
        AND s.status <> 'deleting'
        AND c.scrubbed_at IS NOT NULL
      ORDER BY c.seq ASC`,
    [sessionId, projectId],
  );
  return rows.map((row) => ({
    seq: row.seq,
    size_bytes: nullableNumber(row.size_bytes),
    decoded_size_bytes: nullableNumber(row.decoded_size_bytes),
    has_full_snapshot: row.has_full_snapshot,
    first_event_ms: nullableNumber(row.first_event_ms),
    last_event_ms: nullableNumber(row.last_event_ms),
  }));
}

export interface ReplayArtifactData {
  id: string;
  kind: string;
  object_key: string;
  content_type: string;
  width: number | null;
  height: number | null;
}

export async function getReplayArtifacts(replayId: string, projectId: string): Promise<ReplayArtifactData[]> {
  const pool = getPool();
  const { rows } = await pool.query<ReplayArtifactData>(
    `SELECT sra.id, sra.kind, sra.object_key, sra.content_type, sra.width, sra.height
     FROM session_replay_artifacts sra
     JOIN session_replays sr ON sr.id = sra.replay_id
     WHERE sra.replay_id = $1 AND sr.project_id = $2`,
    [replayId, projectId],
  );
  return rows;
}

export interface SourceMapEntry {
  id: string;
  filename: string;
  object_key: string;
}

export async function getSourceMaps(projectId: string, release: string): Promise<SourceMapEntry[]> {
  const pool = getPool();
  const { rows } = await pool.query<SourceMapEntry>(
    `SELECT id, filename, object_key
     FROM source_maps WHERE project_id = $1 AND release = $2`,
    [projectId, release],
  );
  return rows;
}

// === Investigation lifecycle queries ===

/**
 * Stores investigation results (root_cause, suggested_mitigation) and sets
 * the error group to the given status. Used after investigation completes.
 */
export async function updateGroupInvestigation(
  errorGroupId: string,
  projectId: string,
  status: 'investigated' | 'fixing' | 'needs_human' | 'insight' | 'awaiting_approval',
  fields: {
    rootCause?: string;
    suggestedMitigation?: string;
    confidence?: ConfidenceLevel;
    reason?: NeedsHumanReason;
  },
  lease?: JobLease,
): Promise<void> {
  if (status === 'needs_human') {
    const r = fields.reason;
    if (!r?.reason_code || !r?.reason_message || !r?.remediation) {
      throw new Error(
        `needs_human requires reason fields (reason_code, reason_message, remediation) for group ${errorGroupId}`
      );
    }
  }
  const reason = fields.reason;
  const db = getPool();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $10
           AND worker_id = $11
           AND lease_generation = $12::bigint
           AND project_id = $2
           AND error_group_id = $1
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  const result = await db.query(
    `${ownedCte}
     UPDATE error_groups
     SET status = $3::error_group_status,
         root_cause = $4,
         suggested_mitigation = $5,
         confidence = $6,
         reason_code = $7,
         reason_message = $8,
         remediation = $9,
         updated_at = now()
     WHERE id = $1 AND project_id = $2
       ${lease ? 'AND EXISTS (SELECT 1 FROM owned)' : ''}
     RETURNING id`,
    [
      errorGroupId,
      projectId,
      status,
      fields.rootCause ?? null,
      fields.suggestedMitigation ?? null,
      fields.confidence ?? null,
      reason?.reason_code ?? null,
      reason?.reason_message ?? null,
      reason?.remediation ?? null,
      ...(lease ? [lease.id, lease.workerId, lease.leaseGeneration] : []),
    ]
  );
  if (lease && (result.rowCount ?? 0) === 0) {
    throw new LeaseLostError(lease.id);
  }
}

/**
 * Creates a fix job for an error group. Used when investigation has high
 * confidence and auto-triggers a fix.
 */
export async function updateGroupAndCreateFixJob(
  errorGroupId: string,
  projectId: string,
  fields: {
    rootCause?: string;
    suggestedMitigation?: string;
    confidence?: ConfidenceLevel;
  },
  lease: JobLease,
): Promise<string> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      `SELECT id
       FROM error_group_jobs
       WHERE id = $1
         AND worker_id = $2
         AND lease_generation = $3::bigint
         AND error_group_id = $4
         AND project_id = $5
         AND status = 'claimed'
         AND lease_expires_at > now()
       FOR UPDATE`,
      [
        lease.id,
        lease.workerId,
        lease.leaseGeneration,
        errorGroupId,
        projectId,
      ],
    );
    if ((owned.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);

    const group = await client.query<{ status: string }>(
      `SELECT status
       FROM error_groups
       WHERE id = $1 AND project_id = $2
       FOR UPDATE`,
      [errorGroupId, projectId],
    );
    if ((group.rowCount ?? 0) !== 1) {
      throw new Error(`Cannot create fix job: group ${errorGroupId} was not found`);
    }

    const existingFix = await client.query<{ id: string }>(
      `SELECT id
       FROM error_group_jobs
       WHERE error_group_id = $1
         AND project_id = $2
         AND job_type IN ('fix', 'error_fix')
         AND status IN ('pending', 'claimed')
       ORDER BY created_at, id
       LIMIT 1`,
      [errorGroupId, projectId],
    );
    if (
      existingFix.rows[0]
      && ['analyzing', 'fixing'].includes(group.rows[0]!.status)
    ) {
      await client.query(
        `UPDATE error_groups
         SET status = 'fixing', updated_at = now()
         WHERE id = $1 AND project_id = $2`,
        [errorGroupId, projectId],
      );
      await client.query('COMMIT');
      return existingFix.rows[0].id;
    }

    const groupUpdate = await client.query(
      `UPDATE error_groups
       SET status = 'fixing',
           root_cause = $3,
           suggested_mitigation = $4,
           confidence = $5,
           updated_at = now()
       WHERE id = $1 AND project_id = $2 AND status = 'analyzing'`,
      [
        errorGroupId,
        projectId,
        fields.rootCause ?? null,
        fields.suggestedMitigation ?? null,
        fields.confidence ?? null,
      ]
    );
    if ((groupUpdate.rowCount ?? 0) !== 1) {
      throw new Error(
        `Cannot create fix job: group ${errorGroupId} is not in analyzing state`,
      );
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
       VALUES ($1, $2, 'fix', 'auto')
       RETURNING id`,
      [errorGroupId, projectId]
    );
    await client.query('COMMIT');
    return result.rows[0]!.id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface FrictionSignalRow {
  id: string;
  session_id: string;
  signal_type: 'rage_click' | 'dead_click' | 'form_abandon';
  fingerprint: string;
  element_selector: string | null;
  page_url_normalized: string;
  occurred_at: string;
  occurrence_count: number;
  rule_version: number;
}

export async function getFrictionSignalsForGroup(
  errorGroupId: string,
  projectId: string,
): Promise<FrictionSignalRow[]> {
  const db = getPool();
  const { rows } = await db.query<FrictionSignalRow>(
    `SELECT id, session_id, signal_type, fingerprint, element_selector,
            page_url_normalized, occurred_at, occurrence_count, rule_version
     FROM friction_signals
     WHERE incident_id = $1 AND project_id = $2
       AND superseded_by IS NULL AND retracted_at IS NULL
     ORDER BY occurred_at ASC`,
    [errorGroupId, projectId],
  );
  return rows;
}

export interface SessionChunkRow {
  session_id: string;
  seq: number;
  object_key: string;
  size_bytes: number | null;
  has_full_snapshot: boolean;
}

/** Only server-scrubbed, committed chunks are eligible for worker reads. */
export async function getScrubbedChunksForSession(
  sessionId: string,
  projectId: string,
): Promise<SessionChunkRow[]> {
  const db = getPool();
  const { rows } = await db.query<SessionChunkRow>(
    `SELECT session_id, seq, object_key, size_bytes, has_full_snapshot
     FROM session_chunks
     WHERE session_id = $1 AND project_id = $2 AND scrubbed_at IS NOT NULL
     ORDER BY seq ASC`,
    [sessionId, projectId],
  );
  return rows;
}

export interface SessionRow {
  id: string;
  project_id: string;
  environment_id: string;
  end_user_id: string | null;
  status: string;
}

export async function getSessionForAnalysis(
  sessionId: string,
  projectId: string,
): Promise<SessionRow | null> {
  const db = getPool();
  const { rows } = await db.query<SessionRow>(
    `SELECT id, project_id, environment_id, end_user_id, status
     FROM sessions
     WHERE id = $1 AND project_id = $2`,
    [sessionId, projectId],
  );
  return rows[0] ?? null;
}

export async function setSessionAnalysisStatus(
  sessionId: string,
  projectId: string,
  status: 'analyzing' | 'analyzed' | 'analysis_failed',
  ruleVersion?: number,
  lease?: JobLease,
): Promise<void> {
  const db = getPool();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $5
           AND worker_id = $6
           AND lease_generation = $7::bigint
           AND project_id = $2
           AND error_group_id IS NOT DISTINCT FROM $8::uuid
           AND session_id IS NOT DISTINCT FROM $1
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  const result = await db.query(
    `${ownedCte}
     UPDATE sessions
     SET status = $3,
         analyzer_rule_version = COALESCE($4, analyzer_rule_version)
     WHERE id = $1 AND project_id = $2
       ${lease ? 'AND EXISTS (SELECT 1 FROM owned)' : ''}
     RETURNING id`,
    [
      sessionId,
      projectId,
      status,
      ruleVersion ?? null,
      ...(lease
        ? [lease.id, lease.workerId, lease.leaseGeneration, lease.errorGroupId]
        : []),
    ],
  );
  if (lease && (result.rowCount ?? 0) === 0) {
    throw new LeaseLostError(lease.id);
  }
}

/**
 * Loads investigation results for a fix job.
 */
export async function getGroupInvestigation(
  errorGroupId: string,
  projectId: string,
): Promise<{ rootCause: string | null; suggestedMitigation: string | null }> {
  const db = getPool();
  const result = await db.query<{ root_cause: string | null; suggested_mitigation: string | null }>(
    `SELECT root_cause, suggested_mitigation
     FROM error_groups
     WHERE id = $1 AND project_id = $2`,
    [errorGroupId, projectId]
  );
  const row = result.rows[0];
  return {
    rootCause: row?.root_cause ?? null,
    suggestedMitigation: row?.suggested_mitigation ?? null,
  };
}
