-- 009_regression_lifecycle.sql
-- Release-aware regression + resolution provenance. Append-only; safe to reapply.

ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS resolved_in_release TEXT;
-- Why an issue is in resolved: 'auto_resolved' (inactivity), 'merged' (fix), 'manual'.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS resolved_reason TEXT;

-- Serves the canonical release-ranking min(created_at) grouped by release.
-- created_at (server arrival), not the client-supplied timestamp, so a back-dated
-- event cannot poison release ordering.
CREATE INDEX IF NOT EXISTS idx_error_events_project_release_created
  ON error_events(project_id, release, created_at);

-- Serves the inactivity sweep without a full-table scan.
CREATE INDEX IF NOT EXISTS idx_error_groups_inactivity
  ON error_groups(last_seen)
  WHERE status IN ('needs_human', 'investigated');
