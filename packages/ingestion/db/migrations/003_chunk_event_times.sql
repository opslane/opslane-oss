-- Batch 2 (issue #54): per-chunk rrweb event-time bounds, recorded by the
-- scrubber when it makes a chunk readable. Client-clock epoch ms; used for
-- playback seek and pointer resolution only, never for security decisions.
--
-- Migrations are append-only and re-applied on every boot (no tracking
-- table), so every statement must be idempotent.

ALTER TABLE session_chunks ADD COLUMN IF NOT EXISTS first_event_ms BIGINT;
ALTER TABLE session_chunks ADD COLUMN IF NOT EXISTS last_event_ms BIGINT;

-- Real decoded size, recorded while the scrubber holds the inflated bytes.
-- Playback memory budgeting must use this instead of a compression estimate.
ALTER TABLE session_chunks ADD COLUMN IF NOT EXISTS decoded_size_bytes BIGINT;
