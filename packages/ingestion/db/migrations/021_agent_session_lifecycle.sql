-- Widening the CHECK is expand-safe: old binaries never write the new values.
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_status_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_status_check
  CHECK (status IN ('pending', 'completed', 'expired', 'failed',
                    'provisioned', 'key_ok', 'app_reporting'));
