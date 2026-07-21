-- 020_oauth_verification_continuations.sql — single-use bridge that lets a
-- hosted OAuth login finish an emailed verification challenge. The WorkOS
-- pending token is a bearer credential: stored sealed (AAD-bound to flow_hash),
-- and the browser only ever holds a random flow id.
CREATE TABLE IF NOT EXISTS oauth_verification_continuations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_hash TEXT NOT NULL UNIQUE,
  pending_token_sealed BYTEA NOT NULL,
  flow_kind TEXT NOT NULL CHECK (flow_kind IN ('browser','cli')),
  target_org_id UUID,
  cli_client_id TEXT,
  cli_redirect_uri TEXT,
  cli_oauth_state TEXT,
  cli_code_challenge TEXT,
  cli_code_challenge_method TEXT,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_verification_continuations_expiry
  ON oauth_verification_continuations(expires_at);
