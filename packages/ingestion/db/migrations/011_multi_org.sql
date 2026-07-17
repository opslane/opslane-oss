-- 011_multi_org.sql — cloud-gated multi-org (memberships, invitations),
-- WorkOS org mapping, and active-org session state on refresh tokens.
-- Append-only, idempotent. OSS ships these tables but does not write them.

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id),
  CHECK (role IN ('owner', 'admin', 'member'))
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS workos_org_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_workos_org_id
  ON orgs(workos_org_id) WHERE workos_org_id IS NOT NULL;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES orgs(id);

CREATE TABLE IF NOT EXISTS org_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  invited_by UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invitations_outstanding
  ON org_invitations(org_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lower_email ON users(lower(email));
