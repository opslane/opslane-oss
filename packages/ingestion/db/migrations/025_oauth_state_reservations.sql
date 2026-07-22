-- 025_oauth_state_reservations.sql — retry-safe leases for external callback work.
ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;

ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS reservation_token UUID;

