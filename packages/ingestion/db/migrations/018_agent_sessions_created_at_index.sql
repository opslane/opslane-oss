-- The admin onboarding funnel scans agent_sessions by created_at every ~60s
-- (admin dashboard auto-refresh). The table has only a partial pending index
-- and is never purged, so give the funnel a usable time index.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_created_at
  ON agent_sessions (created_at);
