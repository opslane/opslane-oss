-- 003_friction.sql — friction incident machinery (epic #31, Batch 3, issue #55).
-- Append-only after 001/002. IDEMPOTENCY IS MANDATORY: run-migrations.sh
-- re-applies every file on every start.
--
-- N-1 COMPATIBILITY (design v4-20): enum values are PERMANENT in Postgres.
-- An old worker meeting a 'candidate'/'awaiting_approval'/'insight' group
-- never claims it (no job points at it in Batch 3), and the list API hides
-- 'candidate'. All new columns are additive with defaults.

ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'candidate';
ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'awaiting_approval';
ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'insight';

-- Incident kind (design: one unified incident, kind error|friction).
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'error';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'error_groups'::regclass AND conname = 'error_groups_kind_check'
  ) THEN
    ALTER TABLE error_groups ADD CONSTRAINT error_groups_kind_check
      CHECK (kind IN ('error','friction'));
  END IF;
END $$;

-- Friction-only descriptors (NULL for kind='error').
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS signal_type TEXT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS element_selector TEXT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS page_url_normalized TEXT;

-- One deterministic-rule detection in one session (design §3).
-- element_selector is masked/allowlisted at derivation (packages/sdk/src/selector.ts
-- philosophy applied server-side); never store free text (design v4-13).
CREATE TABLE IF NOT EXISTS friction_signals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id          UUID NOT NULL REFERENCES projects(id),
  environment_id      UUID NOT NULL REFERENCES environments(id),
  end_user_id         UUID REFERENCES end_users(id),
  rule_version        INTEGER NOT NULL,
  signal_type         TEXT NOT NULL CHECK (signal_type IN ('rage_click','dead_click','form_abandon')),
  fingerprint         TEXT NOT NULL,
  element_selector    TEXT,
  page_url_normalized TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  -- Repeat occurrences within one session (design v4-5: idempotent, not exactly-once).
  occurrence_count    INTEGER NOT NULL DEFAULT 1,
  -- RETRACTION SEMANTICS (design v4-5, settled): each analysis pass is
  -- whole-session truth at its rule_version. A signal the current pass no
  -- longer produces gets retracted_at set; a later pass that produces the
  -- fingerprint again clears it — resurrection after new evidence is CORRECT
  -- (a late chunk can both disprove and re-prove). retracted_at is the
  -- disproven-no-replacement flag; superseded_by points at the REPLACEMENT row
  -- when a new rule_version re-analyzes (Batch 4+). Aggregation reads only
  -- rows where both are NULL.
  retracted_at        TIMESTAMPTZ,
  superseded_by       UUID REFERENCES friction_signals(id),
  incident_id         UUID REFERENCES error_groups(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, fingerprint, rule_version)
);

-- 7-day distinct-user aggregation (Batch 4 reader; index ships with schema, v4-18).
CREATE INDEX IF NOT EXISTS idx_friction_signals_aggregation
  ON friction_signals(project_id, environment_id, fingerprint, occurred_at)
  WHERE superseded_by IS NULL AND retracted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_friction_signals_incident
  ON friction_signals(incident_id) WHERE incident_id IS NOT NULL;

-- Immutable receipts log (design §5). Written by the webhook BEFORE any state
-- clearing; github_delivery_id UNIQUE makes redelivery a no-op (v4-17).
-- Schema only in Batch 3; webhook wiring is Batch 5.
CREATE TABLE IF NOT EXISTS pr_outcomes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_group_id     UUID NOT NULL REFERENCES error_groups(id),
  project_id         UUID NOT NULL REFERENCES projects(id),
  pr_number          INTEGER NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('merged','closed')),
  github_delivery_id TEXT NOT NULL UNIQUE,
  fix_job_id         UUID REFERENCES error_group_jobs(id),
  occurred_at        TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Receipts: who asked for this job (design §5). Backfill-free: NULL = unknown/legacy.
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS triggered_by TEXT
  CHECK (triggered_by IN ('auto','human'));
-- Typed session FK for session_analysis jobs (design v4-15). ON DELETE SET NULL:
-- retention may delete a session while a dead-lettered job row remains.
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS session_id TEXT
  REFERENCES sessions(id) ON DELETE SET NULL;

-- Per-project friction autonomy (design §4 ladder). Errors keep their existing
-- behavior; friction defaults to ask-first. Settings UI is Batch 5.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS friction_autonomy TEXT NOT NULL DEFAULT 'ask_first';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'projects'::regclass AND conname = 'projects_friction_autonomy_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_friction_autonomy_check
      CHECK (friction_autonomy IN ('ask_first','auto_fix','auto_fix_ux'));
  END IF;
END $$;

-- Accounts-entity decision (design v4-18, decided in Batch 3): NO accounts table.
-- Per-account flags, when Batch 6 needs them, key on the derived
-- (project_id, external_account_id) string via idx_end_users_account.
