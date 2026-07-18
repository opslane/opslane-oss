-- 016_platform.sql — Python SDK Batch 1 (opslane-oss#87).
-- error_events.platform: every event row is an error event; absent-platform
-- payloads are JavaScript by wire contract, so NOT NULL DEFAULT is correct.
-- error_groups.platform: nullable because this table also holds friction
-- incidents, which have no platform. Set it only for error incidents.
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'javascript';
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS platform TEXT;
UPDATE error_groups SET platform = 'javascript' WHERE platform IS NULL AND kind = 'error';
