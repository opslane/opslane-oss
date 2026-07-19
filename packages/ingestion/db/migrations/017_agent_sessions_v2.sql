-- Agent-first onboarding hardening (docs/plans/2026-07-18-agent-first-onboarding-design.md, PR 1).
-- EXPAND-ONLY: old binaries keep working; api_key_plaintext is retired by the
-- new binary (which never writes it) and dropped in a later contract migration.
--
-- poll_token_hash / agent_key_pub: the key-retrieval secret is split from the
-- session ID (which travels through browser-visible URLs). The poll token is
-- returned once at setup; only its SHA-256 hash is stored. The token also
-- seeds an X25519 keypair whose PUBLIC key is stored here so the callback can
-- seal the API key to it (decision 15) — the server at rest cannot decrypt.
-- failure_reason: machine-readable failure states (decision/F17).
-- auth_clicked_at / key_claimed_at: onboarding funnel timestamps (PR 5 reads).

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS poll_token_hash TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS agent_key_pub   TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS api_key_sealed  TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS failure_reason  TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS auth_clicked_at TIMESTAMPTZ;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS key_claimed_at  TIMESTAMPTZ;

-- SetupWizard installs also use the shared OAuth callback. Preserve the
-- authenticated active organization across that unauthenticated callback so
-- a multi-org user does not accidentally install into their home org.
ALTER TABLE oauth_login_states ADD COLUMN IF NOT EXISTS target_org_id UUID;

-- 'failed' is a new terminal status; old binaries never write it, so widening
-- the CHECK is expand-safe.
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_status_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_status_check
  CHECK (status IN ('pending', 'completed', 'expired', 'failed'));
