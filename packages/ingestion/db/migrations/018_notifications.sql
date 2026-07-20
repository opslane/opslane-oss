-- Notification event bus: destinations (encrypted config), outbox events,
-- and leased deliveries. See docs/plans/2026-07-19-notifications-event-bus-slack-design.md.

CREATE TABLE IF NOT EXISTS notification_destinations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL DEFAULT 'slack' CHECK (type IN ('slack')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  config_encrypted BYTEA NOT NULL,
  config_fingerprint TEXT NOT NULL,
  event_types TEXT[] NOT NULL DEFAULT '{issue.created}'
    CHECK (cardinality(event_types) >= 1 AND event_types <@ ARRAY['issue.created']),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_destinations_project
  ON notification_destinations(project_id);

CREATE TABLE IF NOT EXISTS outbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('issue.created')),
  dedup_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, dedup_key)
);

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES outbound_events(id) ON DELETE CASCADE,
  destination_id UUID NOT NULL REFERENCES notification_destinations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, destination_id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_claimable
  ON outbound_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_stale
  ON outbound_deliveries(lease_expires_at) WHERE status = 'delivering';
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_event
  ON outbound_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_destination_updated
  ON outbound_deliveries(destination_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_prune
  ON outbound_deliveries(updated_at) WHERE status <> 'pending';
