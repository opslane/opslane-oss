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
--
-- REPLAY-SAFE: the migration runner replays every file on every boot (no
-- ledger), so this must not re-narrow a constraint a LATER migration widened.
-- Migration 021 adds 'provisioned'/'key_ok'/'app_reporting'; once those rows
-- exist, an unconditional re-add of the 4-value set aborts the whole boot.
-- Only (re)define when the constraint is missing or still the pre-017 shape
-- (i.e. does not yet include 'failed'). See migration 021.
DO $$
DECLARE def text; has_wider boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'agent_sessions_status_check';
  -- Does any row already use a status wider than this migration's 4-value set?
  -- (Migration 021 introduces such statuses; a half-applied prior boot can also
  -- leave the constraint dropped with wider rows present.)
  SELECT EXISTS (
    SELECT 1 FROM agent_sessions
    WHERE status NOT IN ('pending', 'completed', 'expired', 'failed')
  ) INTO has_wider;
  -- Re-narrow only when the constraint still needs it AND no data has moved on.
  -- Otherwise leave it for migration 021 to (re)add the widened constraint.
  IF (def IS NULL OR def NOT LIKE '%failed%') AND NOT has_wider THEN
    ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_status_check;
    ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_status_check
      CHECK (status IN ('pending', 'completed', 'expired', 'failed'));
  END IF;
END $$;
