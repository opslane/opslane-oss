-- 006_job_scheduling.sql — claim-time scheduling support (issue #28).
-- The worker's claim query enforces a session_analysis concurrency cap and
-- alternates lanes using MAX(claimed_at) per lane. These partial indexes keep
-- both lookups index-only as completed jobs accumulate.
--
-- Migrations are append-only and re-applied on every boot, so every statement
-- must be idempotent.

-- Lane recency: MAX(claimed_at) per lane resolves via a backward index scan.
CREATE INDEX IF NOT EXISTS idx_jobs_analysis_last_claim
  ON error_group_jobs (claimed_at DESC)
  WHERE job_type = 'session_analysis' AND claimed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_interactive_last_claim
  ON error_group_jobs (claimed_at DESC)
  WHERE job_type <> 'session_analysis' AND claimed_at IS NOT NULL;

-- Running-count for the cap: live claimed analysis jobs only.
CREATE INDEX IF NOT EXISTS idx_jobs_analysis_running
  ON error_group_jobs (lease_expires_at)
  WHERE status = 'claimed' AND job_type = 'session_analysis';
