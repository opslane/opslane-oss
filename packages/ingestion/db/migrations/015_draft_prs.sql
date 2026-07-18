-- 015_draft_prs.sql
-- Draft PR delivery, crash-idempotent reservations, and durable CI polling.

ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'pr_draft';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS pr_posture TEXT NOT NULL DEFAULT 'verified_only';
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS draft_pr_cap INTEGER NOT NULL DEFAULT 10;

DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_pr_posture_check
    CHECK (pr_posture IN ('verified_only', 'draft_when_unverified'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_draft_pr_cap_check
    CHECK (draft_pr_cap >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS delivery_reservations (
  error_group_id UUID PRIMARY KEY REFERENCES error_groups(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  posture TEXT NOT NULL CHECK (posture IN ('ready', 'draft')),
  diff_hash TEXT NOT NULL,
  candidate_diff TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'pushed', 'open', 'closed')),
  head_sha TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, operation_key),
  UNIQUE (project_id, branch_name)
);

CREATE INDEX IF NOT EXISTS idx_delivery_reservations_draft_cap
  ON delivery_reservations(project_id, posture, state)
  WHERE posture = 'draft' AND state IN ('reserved', 'pushed', 'open');

ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_jobs_available
  ON error_group_jobs(status, available_at, created_at)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_live_ci_watch_per_group
  ON error_group_jobs(error_group_id)
  WHERE job_type = 'ci_watch' AND status IN ('pending', 'claimed');
