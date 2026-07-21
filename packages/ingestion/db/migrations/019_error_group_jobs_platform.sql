-- Persist the effective routing platform across the durable investigate/fix boundary.
-- NULL means no routing decision was persisted (a job created before this
-- migration). The worker then re-derives the platform at fix time from
-- error_groups.platform and the live feature flag; it does NOT assume
-- JavaScript. See processFixJob in packages/worker/src/index.ts.
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS platform TEXT;
