-- Record the authenticated user who provisioned an onboarding agent session.
-- ON DELETE SET NULL keeps the session row (and its status/expiry contract)
-- intact when the actor is deleted; without an explicit rule the default
-- NO ACTION makes any provisioning user undeletable.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS provisioned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- ProvisionOnboardSession expires prior sessions with
-- WHERE org_id = $1 AND project_id = $2 AND provisioned_by_user_id IS NOT NULL
-- AND status IN (...) while holding the project row lock. The only other
-- indexes on this table are partial on status = 'pending' and on created_at,
-- so without this the expiry sequentially scans agent_sessions inside the
-- provisioning transaction.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_provisioned_actor
  ON agent_sessions (org_id, project_id, status)
  WHERE provisioned_by_user_id IS NOT NULL;

-- An unindexed foreign key forces a full scan of the child table on every
-- users(id) delete.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_provisioned_by
  ON agent_sessions (provisioned_by_user_id)
  WHERE provisioned_by_user_id IS NOT NULL;
