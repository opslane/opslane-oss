-- Fence worker claims after the session and friction schema additions.
-- Migrations are re-applied on every boot, so all statements are idempotent.

ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'error_group_jobs_lease_generation_nonnegative'
      AND conrelid = 'error_group_jobs'::regclass
  ) THEN
    ALTER TABLE error_group_jobs
      ADD CONSTRAINT error_group_jobs_lease_generation_nonnegative
      CHECK (lease_generation >= 0);
  END IF;
END
$$;
