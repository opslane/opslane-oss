-- 007_friction_adjudication.sql — Batch 4 (issue #56): adjudication audit,
-- durable bucket generations, environment-scoped friction identity.
-- Append-only after 006. IDEMPOTENCY IS MANDATORY: run-migrations.sh
-- re-applies every file on every start.

-- === Signal-level adjudication audit (plan D1/D5) ===
-- 'pending' rows are pre-verdict; 'unchecked' means the owning
-- session_analysis job dead-lettered before a verdict — diagnostic only.
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS adjudication_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (adjudication_status IN ('pending','accepted','rejected','unchecked'));
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS adjudication_scope TEXT
  CHECK (adjudication_scope IN ('fold','bucket'));
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS adjudication_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS adjudication_job_id UUID REFERENCES error_group_jobs(id);
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS adjudicated_at TIMESTAMPTZ;
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS adjudication_model TEXT;
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS adjudication_prompt_version INTEGER;
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS adjudication_reason TEXT;

-- === Durable bucket generations (plan D1) ===
-- One adjudication per threshold crossing per tuple; the partial unique index
-- makes concurrent fifth-user claimers converge on a single model call.
CREATE TABLE IF NOT EXISTS friction_adjudication_generations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               UUID NOT NULL REFERENCES projects(id),
  environment_id           UUID NOT NULL REFERENCES environments(id),
  fingerprint              TEXT NOT NULL,
  rule_version             INTEGER NOT NULL,
  prompt_version           INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'adjudicating'
                             CHECK (status IN ('adjudicating','accepted','rejected','unchecked')),
  -- Exact rolling-window bounds captured at threshold crossing.
  window_start             TIMESTAMPTZ NOT NULL,
  window_end               TIMESTAMPTZ NOT NULL,
  -- Accepted verdicts are inherited by later matching signals until expiry.
  valid_until              TIMESTAMPTZ,
  claim_job_id             UUID REFERENCES error_group_jobs(id),
  attempts                 INTEGER NOT NULL DEFAULT 0,
  verdict_reason           TEXT,
  model_id                 TEXT,
  representative_signal_id UUID REFERENCES friction_signals(id),
  promoted_incident_id     UUID REFERENCES error_groups(id),
  diagnostic_incident_id   UUID REFERENCES error_groups(id),
  adjudicated_at           TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_friction_generation_inflight
  ON friction_adjudication_generations(project_id, environment_id, fingerprint, rule_version, prompt_version)
  WHERE status = 'adjudicating';
CREATE INDEX IF NOT EXISTS idx_friction_generation_accepted_valid
  ON friction_adjudication_generations(project_id, environment_id, fingerprint, valid_until)
  WHERE status = 'accepted';

-- friction_signals.generation_id must come after the table exists.
ALTER TABLE friction_signals ADD COLUMN IF NOT EXISTS generation_id UUID
  REFERENCES friction_adjudication_generations(id);

-- === Incident-side identity (plan: environment-isolated grouping) ===
-- UNIQUE(project_id, fingerprint) stays (001_baseline.sql; error ingestion
-- upserts through it). Friction incidents encode environment in the derived
-- fingerprint 'friction:<environment_id>:<signal_fingerprint>'; environment_id
-- here is a queryable/audit column, NULL for every error incident.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS environment_id UUID REFERENCES environments(id);
-- Only exhausted adjudications are marked; NULL everywhere else.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS adjudication_status TEXT
  CHECK (adjudication_status IN ('unchecked'));
-- Deterministic Batch 3 investigation evidence chosen at promotion.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS representative_signal_id UUID REFERENCES friction_signals(id);
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS representative_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;

-- === Query support ===
-- Threshold eligibility: pending, active signals per tuple in the rolling window.
CREATE INDEX IF NOT EXISTS idx_friction_signals_pending_eligible
  ON friction_signals(project_id, environment_id, fingerprint, occurred_at)
  WHERE adjudication_status = 'pending' AND superseded_by IS NULL AND retracted_at IS NULL;
-- Dead-letter reconciliation: claimed-but-pending signals by owning job.
CREATE INDEX IF NOT EXISTS idx_friction_signals_adjudication_job
  ON friction_signals(adjudication_job_id)
  WHERE adjudication_status = 'pending' AND adjudication_job_id IS NOT NULL;
-- Eager fold lookup: same-session errors by client event time.
CREATE INDEX IF NOT EXISTS idx_error_events_session_time
  ON error_events(session_id, "timestamp") WHERE session_id IS NOT NULL;
