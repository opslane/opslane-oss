import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  claimJob,
  heartbeat,
  completeJob,
  failJob,
  requeueStaleJobs,
  updateGroupStatus,
  updateGroupInvestigation,
  updateGroupAndCreateFixJob,
  updateJobTraceUrl,
  recordSetupPrResult,
  getPool,
  closePool,
} from '../db.js';

const DATABASE_URL = process.env['DATABASE_URL'];

// Skip all integration tests if no DATABASE_URL is provided
const describeDb = DATABASE_URL ? describe : describe.skip;

/** Seed helpers */
let testPool: pg.Pool;
let testOrgId: string;
let testProjectId: string;

async function seedTenant(): Promise<void> {
  const orgResult = await testPool.query<{ id: string }>(
    `INSERT INTO orgs (name) VALUES ('test-org') RETURNING id`
  );
  testOrgId = orgResult.rows[0]!.id;

  const projectResult = await testPool.query<{ id: string }>(
    `INSERT INTO projects (org_id, name, github_repo, default_branch)
     VALUES ($1, 'test-project', 'octocat/hello', 'main') RETURNING id`,
    [testOrgId]
  );
  testProjectId = projectResult.rows[0]!.id;
}

async function seedErrorGroupAndJob(overrides?: {
  status?: string;
  attempts?: number;
  max_attempts?: number;
  worker_id?: string | null;
  claimed_at?: Date | null;
  lease_expires_at?: Date | null;
}): Promise<{ errorGroupId: string; jobId: string }> {
  const groupResult = await testPool.query<{ id: string }>(
    `INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, status)
     VALUES ($1, $2, 'Test Error', now(), now(), 'queued') RETURNING id`,
    [testProjectId, `fp-${crypto.randomUUID()}`]
  );
  const errorGroupId = groupResult.rows[0]!.id;

  const status = overrides?.status ?? 'pending';
  const attempts = overrides?.attempts ?? 0;
  const maxAttempts = overrides?.max_attempts ?? 3;
  const workerId = overrides?.worker_id ?? null;
  const claimedAt = overrides?.claimed_at ?? null;
  const leaseExpiresAt = overrides?.lease_expires_at ?? null;

  const jobResult = await testPool.query<{ id: string }>(
    `INSERT INTO error_group_jobs
       (error_group_id, project_id, status, attempts, max_attempts, worker_id, claimed_at, lease_expires_at)
     VALUES ($1, $2, $3::job_status, $4, $5, $6, $7, $8)
     RETURNING id`,
    [errorGroupId, testProjectId, status, attempts, maxAttempts, workerId, claimedAt, leaseExpiresAt]
  );
  const jobId = jobResult.rows[0]!.id;

  return { errorGroupId, jobId };
}

async function cleanupTestData(): Promise<void> {
  // Delete in reverse FK order
  await testPool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM error_events WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM error_groups WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM sessions WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM environments WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM orgs WHERE id = $1`, [testOrgId]);
}

async function expireAndReclaimWithSameWorker(): Promise<{
  jobId: string;
  errorGroupId: string;
  staleGeneration: string;
  currentGeneration: string;
}> {
  const { jobId, errorGroupId } = await seedErrorGroupAndJob();
  const staleClaim = await claimJob('worker-reused', 60_000);
  expect(staleClaim?.id).toBe(jobId);

  await testPool.query(
    `UPDATE error_group_jobs
     SET lease_expires_at = now() - interval '1 second'
     WHERE id = $1`,
    [jobId],
  );
  expect(await requeueStaleJobs()).toBe(1);

  const currentClaim = await claimJob('worker-reused', 60_000);
  expect(currentClaim?.id).toBe(jobId);
  expect(BigInt(currentClaim!.leaseGeneration)).toBe(
    BigInt(staleClaim!.leaseGeneration) + 1n,
  );

  return {
    jobId,
    errorGroupId,
    staleGeneration: staleClaim!.leaseGeneration,
    currentGeneration: currentClaim!.leaseGeneration,
  };
}

describeDb('db.ts integration tests', () => {
  beforeAll(async () => {
    testPool = new pg.Pool({ connectionString: DATABASE_URL });
    // Ensure the worker's getPool uses the same DATABASE_URL (it reads from env)
    await seedTenant();
  });

  afterAll(async () => {
    await cleanupTestData();
    await testPool.end();
    await closePool();
  });

  beforeEach(async () => {
    // Clean only jobs and error groups between tests, keep tenant
    await testPool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [testProjectId]);
    await testPool.query(`DELETE FROM error_events WHERE project_id = $1`, [testProjectId]);
    await testPool.query(`DELETE FROM error_groups WHERE project_id = $1`, [testProjectId]);
  });

  describe('claimJob', () => {
    it('should claim a pending job and set claimed status', async () => {
      const { jobId } = await seedErrorGroupAndJob();

      const job = await claimJob('worker-1', 60_000);

      expect(job).not.toBeNull();
      expect(job!.id).toBe(jobId);
      expect(job!.workerId).toBe('worker-1');
      expect(job!.leaseGeneration).toBe('1');

      // Verify the job is now claimed in the database
      const dbResult = await testPool.query<{
        status: string;
        worker_id: string;
        claimed_at: Date;
        lease_expires_at: Date;
      }>(
        `SELECT status, worker_id, claimed_at, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = dbResult.rows[0]!;
      expect(row.status).toBe('claimed');
      expect(row.worker_id).toBe('worker-1');
      expect(row.claimed_at).toBeTruthy();
      expect(row.lease_expires_at).toBeTruthy();
    });

    it('should return null when no pending jobs exist', async () => {
      const job = await claimJob('worker-1', 60_000);
      expect(job).toBeNull();
    });

    it('should claim the oldest pending job first (FIFO)', async () => {
      // Seed two jobs — the first one inserted should be claimed
      const { jobId: firstJobId } = await seedErrorGroupAndJob();
      // Small delay to ensure different created_at
      await new Promise((r) => setTimeout(r, 10));
      await seedErrorGroupAndJob();

      const job = await claimJob('worker-1', 60_000);
      expect(job).not.toBeNull();
      expect(job!.id).toBe(firstJobId);
    });

    it('should skip already-claimed jobs', async () => {
      // Seed one already-claimed job and one pending
      await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'other-worker',
        claimed_at: new Date(),
        lease_expires_at: new Date(Date.now() + 60_000),
      });
      const { jobId: pendingJobId } = await seedErrorGroupAndJob();

      const job = await claimJob('worker-1', 60_000);
      expect(job).not.toBeNull();
      expect(job!.id).toBe(pendingJobId);
    });
  });

  describe('fair scheduling and per-type caps (issue #28)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function seedSession(): Promise<string> {
      const envResult = await testPool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
        [testProjectId, `env-${crypto.randomUUID()}`]
      );
      const sessionId = `sess-${crypto.randomUUID()}`;
      await testPool.query(
        `INSERT INTO sessions (id, project_id, environment_id, started_at)
         VALUES ($1, $2, $3, now())`,
        [sessionId, testProjectId, envResult.rows[0]!.id]
      );
      return sessionId;
    }

    async function seedAnalysisJob(): Promise<string> {
      const sessionId = await seedSession();
      const res = await testPool.query<{ id: string }>(
        `INSERT INTO error_group_jobs (project_id, status, job_type, session_id)
         VALUES ($1, 'pending', 'session_analysis', $2) RETURNING id`,
        [testProjectId, sessionId]
      );
      return res.rows[0]!.id;
    }

    async function seedTypedJob(jobType: 'fix' | 'error_fix' | 'investigate'): Promise<string> {
      const { jobId } = await seedErrorGroupAndJob();
      await testPool.query(
        `UPDATE error_group_jobs SET job_type = $2 WHERE id = $1`,
        [jobId, jobType]
      );
      return jobId;
    }

    it('caps concurrently claimed session_analysis jobs', async () => {
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();

      const first = await claimJob('w1', 60_000, 2);
      const second = await claimJob('w2', 60_000, 2);
      expect(first?.jobType).toBe('session_analysis');
      expect(second?.jobType).toBe('session_analysis');

      // Third pending analysis job exists, but the cap is reached.
      const third = await claimJob('w3', 60_000, 2);
      expect(third).toBeNull();
    });

    it('a cap of zero blocks session_analysis claims entirely', async () => {
      await seedAnalysisJob();
      const claim = await claimJob('w1', 60_000, 0);
      expect(claim).toBeNull();
    });

    it('a fresh error_fix is claimed immediately during an analysis flood', async () => {
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();

      // Analysis flood in progress: two claimed (at cap), one still pending.
      await claimJob('w1', 60_000, 2);
      await claimJob('w2', 60_000, 2);

      const fixJobId = await seedTypedJob('error_fix');
      const next = await claimJob('w3', 60_000, 2);
      expect(next?.id).toBe(fixJobId);
    });

    it('error_fix outranks a pending analysis backlog from a cold start too', async () => {
      await seedAnalysisJob();
      await sleep(5);
      const fixJobId = await seedTypedJob('error_fix');
      const first = await claimJob('w1', 60_000, 2);
      expect(first?.id).toBe(fixJobId);
    });

    it('session_analysis makes progress under a fix backlog, up to its cap', async () => {
      for (let i = 0; i < 5; i++) {
        await seedTypedJob('fix');
        await sleep(5);
      }
      for (let i = 0; i < 3; i++) {
        await seedAnalysisJob();
        await sleep(5);
      }

      // Long leases: claimed jobs stay running for the whole test, so the
      // sequence shows lane alternation and then the cap binding.
      const types: string[] = [];
      for (let i = 0; i < 6; i++) {
        const job = await claimJob(`w${i}`, 600_000, 2);
        expect(job).not.toBeNull();
        types.push(job!.jobType);
      }
      expect(types).toEqual([
        'fix', 'session_analysis', 'fix', 'session_analysis', 'fix', 'fix',
      ]);
    });

    it('enforces the cap under truly concurrent claimers (no overshoot)', async () => {
      for (let i = 0; i < 3; i++) {
        await seedAnalysisJob();
        await sleep(5);
      }
      for (let i = 0; i < 3; i++) {
        await seedTypedJob('fix');
        await sleep(5);
      }

      // Six workers poll at the same instant with cap 1. Without serialized
      // admission they would all see zero running analysis jobs and overshoot.
      const claims = await Promise.all(
        Array.from({ length: 6 }, (_, i) => claimJob(`cw${i}`, 600_000, 1))
      );

      const byType = claims
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => c.jobType);
      expect(byType.filter((t) => t === 'session_analysis')).toHaveLength(1);
      expect(byType.filter((t) => t === 'fix')).toHaveLength(3);
      expect(claims.filter((c) => c === null)).toHaveLength(2);
    });

    it('completing an analysis job releases its cap slot', async () => {
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();
      await sleep(5);
      await seedTypedJob('fix');

      // Cold start: both lanes tie, so the interactive lane goes first.
      const f1 = await claimJob('w1', 600_000, 2);
      expect(f1?.jobType).toBe('fix');

      const a1 = await claimJob('w2', 600_000, 2);
      const a2 = await claimJob('w3', 600_000, 2);
      expect(a1?.jobType).toBe('session_analysis');
      expect(a2?.jobType).toBe('session_analysis');

      // At cap with only analysis pending: nothing is claimable.
      const blocked = await claimJob('w4', 600_000, 2);
      expect(blocked).toBeNull();

      // Completion releases a slot; the pending analysis job is claimable again.
      const completed = await completeJob(a1!.id, 'w2', a1!.leaseGeneration);
      expect(completed).toBe(true);
      const a3 = await claimJob('w5', 600_000, 2);
      expect(a3?.jobType).toBe('session_analysis');
    });
  });

  describe('heartbeat', () => {
    it('should extend the lease on a claimed job', async () => {
      const { jobId } = await seedErrorGroupAndJob();

      // First claim the job
      const claimed = await claimJob('worker-1', 30_000);

      // Get the initial lease_expires_at
      const before = await testPool.query<{ lease_expires_at: Date }>(
        `SELECT lease_expires_at FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const initialLease = before.rows[0]!.lease_expires_at;

      // Small delay to ensure the new lease is different
      await new Promise((r) => setTimeout(r, 20));

      // Heartbeat with a longer lease
      const extended = await heartbeat(
        jobId,
        'worker-1',
        claimed!.leaseGeneration,
        120_000,
      );
      expect(extended).toBe(true);

      // Verify lease was extended
      const after = await testPool.query<{ lease_expires_at: Date }>(
        `SELECT lease_expires_at FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const newLease = after.rows[0]!.lease_expires_at;
      expect(newLease.getTime()).toBeGreaterThan(initialLease.getTime());
    });

    it('should return false for wrong worker_id', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claimed = await claimJob('worker-1', 60_000);

      const extended = await heartbeat(
        jobId,
        'wrong-worker',
        claimed!.leaseGeneration,
        60_000,
      );
      expect(extended).toBe(false);
    });

    it('should return false for a completed job', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claimed = await claimJob('worker-1', 60_000);
      await completeJob(jobId, 'worker-1', claimed!.leaseGeneration);

      const extended = await heartbeat(
        jobId,
        'worker-1',
        claimed!.leaseGeneration,
        60_000,
      );
      expect(extended).toBe(false);
    });
  });

  describe('completeJob', () => {
    it('should mark a claimed job as completed', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claimed = await claimJob('worker-1', 60_000);

      expect(
        await completeJob(jobId, 'worker-1', claimed!.leaseGeneration),
      ).toBe(true);

      const result = await testPool.query<{ status: string }>(
        `SELECT status FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      expect(result.rows[0]!.status).toBe('completed');
    });
  });

  describe('lease generation fencing', () => {
    it('does not let an expired owner revive or terminate a claim before reaping', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claim = await claimJob('worker-expired', 60_000);
      await testPool.query(
        `UPDATE error_group_jobs
         SET lease_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [jobId],
      );

      expect(
        await heartbeat(jobId, 'worker-expired', claim!.leaseGeneration, 60_000),
      ).toBe(false);
      expect(
        await completeJob(jobId, 'worker-expired', claim!.leaseGeneration),
      ).toBe(false);
      expect(
        await failJob(
          jobId,
          'worker-expired',
          claim!.leaseGeneration,
          'late failure',
        ),
      ).toBe(false);
      const row = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
      }>(
        `SELECT status, attempts, last_error
         FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(row.rows[0]).toEqual({
        status: 'claimed',
        attempts: 0,
        last_error: null,
      });
    });

    it('rejects a stale heartbeat after the same worker ID reclaims the job', async () => {
      const { jobId, staleGeneration, currentGeneration } =
        await expireAndReclaimWithSameWorker();
      const before = await testPool.query<{
        status: string;
        lease_generation: string;
        lease_expires_at: Date;
      }>(
        `SELECT status, lease_generation::text, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );

      expect(
        await heartbeat(jobId, 'worker-reused', staleGeneration, 120_000),
      ).toBe(false);

      const after = await testPool.query<{
        status: string;
        lease_generation: string;
        lease_expires_at: Date;
      }>(
        `SELECT status, lease_generation::text, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(
        await heartbeat(jobId, 'worker-reused', currentGeneration, 120_000),
      ).toBe(true);
    });

    it('rejects stale completion after the same worker ID reclaims the job', async () => {
      const { jobId, staleGeneration, currentGeneration } =
        await expireAndReclaimWithSameWorker();

      expect(
        await completeJob(jobId, 'worker-reused', staleGeneration),
      ).toBe(false);
      expect(
        await testPool.query<{ status: string }>(
          `SELECT status FROM error_group_jobs WHERE id = $1`,
          [jobId],
        ),
      ).toMatchObject({ rows: [{ status: 'claimed' }] });
      expect(
        await completeJob(jobId, 'worker-reused', currentGeneration),
      ).toBe(true);
    });

    it('rejects stale failure after the same worker ID reclaims the job', async () => {
      const { jobId, staleGeneration, currentGeneration } =
        await expireAndReclaimWithSameWorker();

      expect(
        await failJob(
          jobId,
          'worker-reused',
          staleGeneration,
          'stale execution failed',
        ),
      ).toBe(false);
      const afterStale = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string;
        lease_generation: string;
      }>(
        `SELECT status, attempts, last_error, lease_generation::text
         FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(afterStale.rows[0]).toMatchObject({
        status: 'claimed',
        attempts: 1,
        last_error: 'reaper: lease expired (attempt 1)',
        lease_generation: currentGeneration,
      });
      expect(
        await failJob(
          jobId,
          'worker-reused',
          currentGeneration,
          'current execution failed',
        ),
      ).toBe(true);
    });

    it('fences trace, group, and fix-job writes with the current generation', async () => {
      const {
        jobId,
        errorGroupId,
        staleGeneration,
        currentGeneration,
      } = await expireAndReclaimWithSameWorker();
      const staleLease = {
        id: jobId,
        workerId: 'worker-reused',
        leaseGeneration: staleGeneration,
        projectId: testProjectId,
        errorGroupId,
        sessionId: null,
      };
      const currentLease = {
        ...staleLease,
        leaseGeneration: currentGeneration,
      };

      expect(
        await updateJobTraceUrl(
          jobId,
          'worker-reused',
          staleGeneration,
          'https://trace.invalid/stale',
        ),
      ).toBe(false);
      await expect(
        updateGroupStatus(
          errorGroupId,
          testProjectId,
          'analyzing',
          undefined,
          staleLease,
        ),
      ).rejects.toThrow('lease lost');
      await expect(
        updateGroupInvestigation(
          errorGroupId,
          testProjectId,
          'investigated',
          { rootCause: 'stale result' },
          staleLease,
        ),
      ).rejects.toThrow('lease lost');

      const beforeCurrent = await testPool.query<{
        status: string;
        root_cause: string | null;
        trace_url: string | null;
      }>(
        `SELECT eg.status, eg.root_cause, j.trace_url
         FROM error_groups eg
         JOIN error_group_jobs j ON j.error_group_id = eg.id
         WHERE eg.id = $1 AND j.id = $2`,
        [errorGroupId, jobId],
      );
      expect(beforeCurrent.rows[0]).toEqual({
        status: 'queued',
        root_cause: null,
        trace_url: null,
      });

      await updateGroupStatus(
        errorGroupId,
        testProjectId,
        'analyzing',
        undefined,
        currentLease,
      );
      await expect(
        updateGroupAndCreateFixJob(
          errorGroupId,
          testProjectId,
          { rootCause: 'stale result' },
          staleLease,
        ),
      ).rejects.toThrow('lease lost');
      const staleFixCount = await testPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM error_group_jobs
         WHERE error_group_id = $1 AND job_type = 'fix'`,
        [errorGroupId],
      );
      expect(staleFixCount.rows[0]?.count).toBe('0');

      const fixJobId = await updateGroupAndCreateFixJob(
        errorGroupId,
        testProjectId,
        { rootCause: 'current result', confidence: 'high' },
        currentLease,
      );
      expect(fixJobId).toEqual(expect.any(String));
      const final = await testPool.query<{
        status: string;
        root_cause: string | null;
      }>(
        `SELECT status, root_cause FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(final.rows[0]).toEqual({
        status: 'fixing',
        root_cause: 'current result',
      });
    });

    it('does not authorize another tenant with a valid current lease', async () => {
      const { errorGroupId } = await seedErrorGroupAndJob();
      const claim = await claimJob('tenant-bound-worker', 60_000);
      expect(claim?.errorGroupId).toBe(errorGroupId);

      const otherOrg = await testPool.query<{ id: string }>(
        `INSERT INTO orgs (name) VALUES ('lease-other-org') RETURNING id`,
      );
      const otherProject = await testPool.query<{ id: string }>(
        `INSERT INTO projects (org_id, name, github_repo, default_branch)
         VALUES ($1, 'lease-other-project', 'other/repo', 'main') RETURNING id`,
        [otherOrg.rows[0]!.id],
      );
      const otherGroup = await testPool.query<{ id: string }>(
        `INSERT INTO error_groups
           (project_id, fingerprint, title, first_seen, last_seen, status)
         VALUES ($1, $2, 'Other tenant error', now(), now(), 'queued')
         RETURNING id`,
        [otherProject.rows[0]!.id, `fp-${crypto.randomUUID()}`],
      );

      try {
        await expect(
          updateGroupStatus(
            otherGroup.rows[0]!.id,
            otherProject.rows[0]!.id,
            'analyzing',
            undefined,
            claim!,
          ),
        ).rejects.toThrow('lease lost');
        await expect(
          updateGroupAndCreateFixJob(
            otherGroup.rows[0]!.id,
            otherProject.rows[0]!.id,
            { rootCause: 'cross-tenant mutation' },
            claim!,
          ),
        ).rejects.toThrow('lease lost');
        await expect(
          recordSetupPrResult(
            otherProject.rows[0]!.id,
            'opening',
            {},
            claim!,
          ),
        ).rejects.toThrow('lease lost');

        const untouched = await testPool.query<{ status: string }>(
          `SELECT status FROM error_groups WHERE id = $1`,
          [otherGroup.rows[0]!.id],
        );
        expect(untouched.rows[0]?.status).toBe('queued');
      } finally {
        await testPool.query(`DELETE FROM error_groups WHERE project_id = $1`, [otherProject.rows[0]!.id]);
        await testPool.query(`DELETE FROM projects WHERE id = $1`, [otherProject.rows[0]!.id]);
        await testPool.query(`DELETE FROM orgs WHERE id = $1`, [otherOrg.rows[0]!.id]);
      }
    });
  });

  describe('failJob', () => {
    it('should retry (reset to pending) when under max_attempts', async () => {
      const { jobId } = await seedErrorGroupAndJob({
        attempts: 0,
        max_attempts: 3,
      });
      const claimed = await claimJob('worker-1', 60_000);

      expect(
        await failJob(
          jobId,
          'worker-1',
          claimed!.leaseGeneration,
          'Something broke',
        ),
      ).toBe(true);

      const result = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string;
        worker_id: string | null;
        claimed_at: Date | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT status, attempts, last_error, worker_id, claimed_at, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('Something broke');
      // Should be cleared for reclaim
      expect(row.worker_id).toBeNull();
      expect(row.claimed_at).toBeNull();
      expect(row.lease_expires_at).toBeNull();
    });

    it('should dead-letter when at max_attempts', async () => {
      const { jobId } = await seedErrorGroupAndJob({
        attempts: 2,
        max_attempts: 3,
      });
      const claimed = await claimJob('worker-1', 60_000);

      expect(
        await failJob(
          jobId,
          'worker-1',
          claimed!.leaseGeneration,
          'Final failure',
        ),
      ).toBe(true);

      const result = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string;
      }>(
        `SELECT status, attempts, last_error FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0]!;
      expect(row.status).toBe('dead_letter');
      expect(row.attempts).toBe(3);
      expect(row.last_error).toBe('Final failure');
    });
  });

  describe('requeueStaleJobs', () => {
    it('should reset expired claimed jobs to pending and increment attempts', async () => {
      // Seed a job that is claimed but has an expired lease
      const { jobId } = await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'dead-worker',
        claimed_at: new Date(Date.now() - 120_000),
        lease_expires_at: new Date(Date.now() - 60_000), // expired 60s ago
        attempts: 0,
        max_attempts: 3,
      });

      const count = await requeueStaleJobs();
      expect(count).toBe(1);

      const result = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        worker_id: string | null;
        claimed_at: Date | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT status, attempts, last_error, worker_id, claimed_at, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('reaper');
      expect(row.worker_id).toBeNull();
      expect(row.claimed_at).toBeNull();
      expect(row.lease_expires_at).toBeNull();
    });

    it('should dead-letter expired jobs at max_attempts and preserve ownership for forensics', async () => {
      const { jobId } = await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'dead-worker',
        claimed_at: new Date(Date.now() - 120_000),
        lease_expires_at: new Date(Date.now() - 60_000),
        attempts: 2,
        max_attempts: 3,
      });

      const count = await requeueStaleJobs();
      expect(count).toBe(1);

      const result = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        worker_id: string | null;
        claimed_at: Date | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT status, attempts, last_error, worker_id, claimed_at, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0]!;
      expect(row.status).toBe('dead_letter');
      expect(row.attempts).toBe(3);
      expect(row.last_error).toContain('dead-lettered by reaper');
      // Ownership preserved for forensic investigation
      expect(row.worker_id).toBe('dead-worker');
      expect(row.claimed_at).not.toBeNull();
      expect(row.lease_expires_at).not.toBeNull();
    });

    it('should not requeue jobs with valid leases', async () => {
      await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'active-worker',
        claimed_at: new Date(),
        lease_expires_at: new Date(Date.now() + 300_000), // expires in 5 min
      });

      const count = await requeueStaleJobs();
      expect(count).toBe(0);
    });

    it('should return 0 when no stale jobs exist', async () => {
      const count = await requeueStaleJobs();
      expect(count).toBe(0);
    });
  });
});
