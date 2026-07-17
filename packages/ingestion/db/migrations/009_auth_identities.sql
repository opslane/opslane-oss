-- 009_auth_identities.sql — provider-agnostic identity map.
-- Append-only after 001-008. Idempotent: run-migrations.sh reapplies every file.
-- Generalizes users.github_id so new IdPs (workos) are rows, not columns.
CREATE TABLE IF NOT EXISTS auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  provider_email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);

-- Backfill existing GitHub identities. Idempotent via ON CONFLICT.
INSERT INTO auth_identities (user_id, provider, provider_subject)
SELECT id, 'github', github_id::text FROM users WHERE github_id IS NOT NULL
ON CONFLICT (provider, provider_subject) DO NOTHING;
