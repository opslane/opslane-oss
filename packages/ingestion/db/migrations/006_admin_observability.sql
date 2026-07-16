-- 006_admin_observability.sql — operator dashboard indexes and lifecycle timestamps.
-- Lifecycle timestamps are exact from this migration forward; legacy rows remain NULL.

ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS pr_created_at TIMESTAMPTZ;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS needs_human_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_error_events_created_at
  ON error_events(created_at);

CREATE INDEX IF NOT EXISTS idx_error_group_jobs_created_at
  ON error_group_jobs(created_at DESC);
