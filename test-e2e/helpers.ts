/**
 * E2E test helpers: DB seeding, API client, and polling utilities.
 *
 * Environment variables:
 *   DATABASE_URL     — Postgres connection string (required)
 *   INGESTION_URL    — Base URL for ingestion API (default: http://localhost:8082)
 */

import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getConfig() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for E2E tests');
  }
  return {
    databaseUrl,
    ingestionUrl: process.env['INGESTION_URL'] ?? 'http://localhost:8082',
  };
}

// ---------------------------------------------------------------------------
// DB Pool (shared across test files)
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const { databaseUrl } = getConfig();
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// Tenant seeding
// ---------------------------------------------------------------------------

export interface TestTenant {
  orgId: string;
  projectId: string;
  environmentId: string;
  apiKey: string; // raw key for X-API-Key header
}

/**
 * Creates a full tenant hierarchy: org → project → environment → API key.
 * Uses a unique suffix to avoid collisions between test runs.
 */
export async function seedTenant(
  githubRepo = 'test-org/test-repo'
): Promise<TestTenant> {
  const db = getPool();
  const suffix = crypto.randomUUID().slice(0, 8);

  // Create org
  const orgResult = await db.query<{ id: string }>(
    `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
    [`e2e-org-${suffix}`]
  );
  const orgId = orgResult.rows[0]!.id;

  // Create project
  const projectResult = await db.query<{ id: string }>(
    `INSERT INTO projects (org_id, name, github_repo) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, `e2e-project-${suffix}`, githubRepo]
  );
  const projectId = projectResult.rows[0]!.id;

  // Create environment
  const envResult = await db.query<{ id: string }>(
    `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
    [projectId, 'production']
  );
  const environmentId = envResult.rows[0]!.id;

  // Create API key
  const rawKey = `def_${crypto.randomUUID()}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 12);

  await db.query(
    `INSERT INTO environment_api_keys (environment_id, key_hash, key_prefix) VALUES ($1, $2, $3)`,
    [environmentId, keyHash, keyPrefix]
  );

  return { orgId, projectId, environmentId, apiKey: rawKey };
}

// ---------------------------------------------------------------------------
// Direct DB seeding for error groups (bypasses ingestion for contract tests)
// ---------------------------------------------------------------------------

export interface SeedGroupOptions {
  projectId: string;
  environmentId: string;
  status: string;
  title?: string;
  fingerprint?: string;
  reasonCode?: string;
  reasonMessage?: string;
  remediation?: string;
  confidence?: string;
  prUrl?: string;
  prNumber?: number;
}

/**
 * Seeds an error event + error group + job directly in DB.
 * Returns the group ID.
 */
export async function seedErrorGroup(opts: SeedGroupOptions): Promise<string> {
  const db = getPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const fingerprint = opts.fingerprint ?? `fp-${suffix}`;
  const title = opts.title ?? `Test Error ${suffix}`;
  const now = new Date().toISOString();

  // Insert error event
  const eventResult = await db.query<{ id: string }>(
    `INSERT INTO error_events (project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.projectId, opts.environmentId, now, 'TypeError', title, 'Error\n  at test.js:1:1']
  );
  const eventId = eventResult.rows[0]!.id;

  // Insert error group
  const groupResult = await db.query<{ id: string }>(
    `INSERT INTO error_groups (
       project_id, fingerprint, title, first_seen, last_seen,
       occurrence_count, affected_users_count, status, sample_event_id,
       reason_code, reason_message, remediation,
       confidence, pr_url, pr_number
     ) VALUES ($1, $2, $3, $4, $4, 1, 1, $5::error_group_status, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      opts.projectId, fingerprint, title, now, opts.status, eventId,
      opts.reasonCode ?? null,
      opts.reasonMessage ?? null,
      opts.remediation ?? null,
      opts.confidence ?? null,
      opts.prUrl ?? null,
      opts.prNumber ?? null,
    ]
  );
  const groupId = groupResult.rows[0]!.id;

  // Link event to group
  await db.query(
    `UPDATE error_events SET error_group_id = $1 WHERE id = $2`,
    [groupId, eventId]
  );

  return groupId;
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

export interface Incident {
  id: string;
  project_id: string;
  fingerprint: string;
  title: string;
  status: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  affected_users_count: number;
  confidence?: string;
  pr_url?: string;
  reason?: {
    reason_code: string;
    reason_message: string;
    remediation: string;
  };
}

/**
 * POST an error event to the ingestion API.
 */
export async function postEvent(
  apiKey: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const { ingestionUrl } = getConfig();
  return fetch(`${ingestionUrl}/api/v1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(payload),
  });
}

/**
 * GET all incidents for a project.
 */
export async function listIncidents(
  apiKey: string,
  projectId: string
): Promise<Incident[]> {
  const { ingestionUrl } = getConfig();
  const res = await fetch(
    `${ingestionUrl}/api/v1/projects/${projectId}/incidents`,
    { headers: { 'X-API-Key': apiKey } }
  );
  if (!res.ok) {
    throw new Error(`listIncidents failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Incident[]>;
}

/**
 * GET a single incident by ID.
 */
export async function getIncident(
  apiKey: string,
  projectId: string,
  incidentId: string
): Promise<Incident> {
  const { ingestionUrl } = getConfig();
  const res = await fetch(
    `${ingestionUrl}/api/v1/projects/${projectId}/incidents/${incidentId}`,
    { headers: { 'X-API-Key': apiKey } }
  );
  if (!res.ok) {
    throw new Error(`getIncident failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Incident>;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Polls an incident until its status matches one of the given terminal statuses,
 * or the timeout expires.
 */
export async function pollUntilTerminal(
  apiKey: string,
  projectId: string,
  incidentId: string,
  terminalStatuses: string[],
  timeoutMs = 45_000,
  intervalMs = 2_000
): Promise<Incident> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const incident = await getIncident(apiKey, projectId, incidentId);
    if (terminalStatuses.includes(incident.status)) {
      return incident;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // One last try
  const incident = await getIncident(apiKey, projectId, incidentId);
  if (terminalStatuses.includes(incident.status)) {
    return incident;
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for incident ${incidentId} to reach terminal status. Last status: ${incident.status}`
  );
}

// ---------------------------------------------------------------------------
// Session auth (JWT)
// ---------------------------------------------------------------------------

const DEFAULT_JWT_SECRET = 'opslane-dev-jwt-secret-key-minimum-32-bytes-long';

/**
 * Generate a session JWT for test API calls.
 * Uses the same HMAC-SHA256 algorithm as the Go auth package.
 */
export function generateTestJWT(userId: string, orgId: string, email = 'test@opslane.dev'): string {
  const secret = process.env['JWT_SECRET'] ?? DEFAULT_JWT_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    org_id: orgId,
    email,
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest().toString('base64url');

  return `${signingInput}.${sig}`;
}

/**
 * Creates a user in the DB and returns a JWT for session-authenticated endpoints.
 */
export async function seedUserWithJWT(orgId: string): Promise<{ userId: string; jwt: string }> {
  const db = getPool();
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `e2e-user-${suffix}@opslane.dev`;

  const userResult = await db.query<{ id: string }>(
    `INSERT INTO users (org_id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, email, `E2E User ${suffix}`, 'not-a-real-hash']
  );
  const userId = userResult.rows[0]!.id;
  const jwt = generateTestJWT(userId, orgId, email);

  return { userId, jwt };
}

// ---------------------------------------------------------------------------
// Session / friction helpers (browser smoke)
// ---------------------------------------------------------------------------

/** Polls until the project has a session (created by SDK /sessions/init). */
export async function pollSessionForProject(
  projectId: string,
  timeoutMs = 30_000
): Promise<string> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM sessions WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [projectId]
    );
    if (rows[0]) return rows[0].id;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`No session appeared for project ${projectId} within ${timeoutMs}ms`);
}

/** Polls until at least one chunk for the session is scrubbed (analyzable).
 * Scrubber cadence: eligible 30s after upload, swept every 15s — expect ~45-60s. */
export async function pollScrubbedChunk(
  sessionId: string,
  timeoutMs = 120_000
): Promise<void> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT 1 FROM session_chunks WHERE session_id = $1 AND scrubbed_at IS NOT NULL LIMIT 1`,
      [sessionId]
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`No scrubbed chunk for session ${sessionId} within ${timeoutMs}ms`);
}

/** Batch 3 gap: the product does not yet auto-create session_analysis jobs.
 * Delete this helper when automatic scheduling lands. */
export async function insertSessionAnalysisJob(
  projectId: string,
  sessionId: string
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO error_group_jobs (project_id, session_id, job_type, status, triggered_by)
     VALUES ($1, $2, 'session_analysis', 'pending', 'auto')`,
    [projectId, sessionId]
  );
}

/** Polls sessions.status until it reaches one of the given values. */
export async function pollSessionStatus(
  sessionId: string,
  statuses: string[],
  timeoutMs = 60_000
): Promise<string> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM sessions WHERE id = $1`,
      [sessionId]
    );
    last = rows[0]?.status ?? '(missing)';
    if (statuses.includes(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Session ${sessionId} stuck at '${last}' after ${timeoutMs}ms`);
}

export interface FrictionSignalRow {
  signal_type: string;
  element_selector: string | null;
  occurrence_count: number;
}

/** Active (non-retracted, non-superseded) friction signals for a session. */
export async function getActiveFrictionSignals(
  sessionId: string
): Promise<FrictionSignalRow[]> {
  const db = getPool();
  const { rows } = await db.query<FrictionSignalRow>(
    `SELECT signal_type, element_selector, occurrence_count
       FROM friction_signals
      WHERE session_id = $1 AND retracted_at IS NULL AND superseded_by IS NULL`,
    [sessionId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Removes all test data created by seedTenant (cascading through FKs).
 * Call in afterAll to clean up.
 */
export async function cleanupTenant(orgId: string): Promise<void> {
  const db = getPool();

  // Delete in dependency order (or rely on CASCADE if configured)
  // Since we don't have CASCADE, delete manually in reverse order

  // Users
  await db.query(
    `DELETE FROM users WHERE org_id = $1`,
    [orgId]
  );

  await db.query(
    `DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  // Sessions cascade to session_chunks and friction_signals.
  await db.query(
    `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(
    `DELETE FROM session_replay_artifacts WHERE replay_id IN (
       SELECT sr.id FROM session_replays sr JOIN projects p ON sr.project_id = p.id WHERE p.org_id = $1
     )`,
    [orgId]
  );
  await db.query(
    `DELETE FROM session_replays WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(
    `DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(
    `DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(
    `DELETE FROM environment_api_keys WHERE environment_id IN (
       SELECT e.id FROM environments e JOIN projects p ON e.project_id = p.id WHERE p.org_id = $1
     )`,
    [orgId]
  );
  await db.query(
    `DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId]
  );
  await db.query(`DELETE FROM projects WHERE org_id = $1`, [orgId]);
  await db.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
}
