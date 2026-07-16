-- 008_receipts_wiring.sql — Batch 5 (epic #31, issue #57): attributable receipts.
-- Append-only after 001-007. IDEMPOTENCY IS MANDATORY: run-migrations.sh
-- re-applies every file on every start.
--
-- The fix job that produced a PR, recorded at PR creation (design v4-17) so the
-- merge/close webhook can copy it into pr_outcomes.fix_job_id. NULL for PRs
-- created before Batch 5 and for setup PRs. Cleared when a PR closes unmerged.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS pr_fix_job_id UUID
  REFERENCES error_group_jobs(id) ON DELETE SET NULL;

-- GetFixStats aggregates both tables by project_id; neither had an index
-- serving that filter (error_group_jobs is the highest-churn table).
CREATE INDEX IF NOT EXISTS idx_error_group_jobs_project_type
  ON error_group_jobs(project_id, job_type);
CREATE INDEX IF NOT EXISTS idx_pr_outcomes_project
  ON pr_outcomes(project_id);
