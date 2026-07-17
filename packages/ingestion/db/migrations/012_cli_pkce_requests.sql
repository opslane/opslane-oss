-- 012_cli_pkce_requests.sql — durable, single-use bridge for cloud CLI login.
CREATE TABLE IF NOT EXISTS cli_pkce_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  oauth_state TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cli_pkce_requests_expiry ON cli_pkce_requests(expires_at);
