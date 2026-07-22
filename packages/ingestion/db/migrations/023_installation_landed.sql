-- 023_installation_landed.sql — durable audit of completed GitHub App installs.
CREATE TABLE IF NOT EXISTS installation_landed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id BIGINT NOT NULL,
  org_id UUID REFERENCES orgs(id),
  repos TEXT[] NOT NULL DEFAULT '{}',
  landed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_installation_landed_at
  ON installation_landed(landed_at DESC);

