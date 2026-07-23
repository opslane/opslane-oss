-- Record the authenticated user who provisioned an onboarding agent session.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS provisioned_by_user_id UUID REFERENCES users(id);
