-- 001_baseline.sql — consolidated schema baseline (2026-07-13).
-- Replaces migrations 001–015 (see git history). Idempotent; applied on every start.
-- New migrations are append-only starting at 002.

-- ===== from 001_foundation.sql =====
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- === Tenant hierarchy: org -> project -> environment ===

CREATE TABLE IF NOT EXISTS orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  github_token_encrypted BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS environment_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id UUID NOT NULL REFERENCES environments(id),
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- === Error group status enum ===

DO $$ BEGIN
  CREATE TYPE error_group_status AS ENUM (
    'new',
    'queued',
    'analyzing',
    'pr_created',
    'needs_human',
    'resolved'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- === Core tables ===

CREATE TABLE IF NOT EXISTS error_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  environment_id UUID NOT NULL REFERENCES environments(id),
  error_group_id UUID,
  timestamp TIMESTAMPTZ NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_trace_raw TEXT NOT NULL,
  stack_trace_resolved JSONB,
  breadcrumbs JSONB NOT NULL DEFAULT '[]',
  context JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS error_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  affected_users_count INTEGER NOT NULL DEFAULT 0,
  status error_group_status NOT NULL DEFAULT 'new',
  sample_event_id UUID,
  -- needs_human reason contract (required when status = 'needs_human')
  reason_code TEXT,
  reason_message TEXT,
  remediation TEXT,
  -- resolution fields
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  pr_url TEXT,
  pr_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, fingerprint)
);

-- === Job queue (Postgres-based, no Redis/BullMQ) ===

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM (
    'pending',
    'claimed',
    'completed',
    'failed',
    'dead_letter'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS error_group_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_group_id UUID NOT NULL REFERENCES error_groups(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  status job_status NOT NULL DEFAULT 'pending',
  worker_id TEXT,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- === Indexes ===

CREATE INDEX IF NOT EXISTS idx_error_events_project ON error_events(project_id);
CREATE INDEX IF NOT EXISTS idx_error_events_environment ON error_events(environment_id);
CREATE INDEX IF NOT EXISTS idx_error_events_group ON error_events(error_group_id);
CREATE INDEX IF NOT EXISTS idx_error_groups_project_status ON error_groups(project_id, status);
CREATE INDEX IF NOT EXISTS idx_error_groups_fingerprint ON error_groups(project_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_error_group_jobs_claimable ON error_group_jobs(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_error_group_jobs_stale ON error_group_jobs(lease_expires_at) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_environments_project ON environments(project_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON environment_api_keys(key_hash);

-- ===== from 003_replays_and_sourcemaps.sql =====
-- 003_replays_and_sourcemaps.sql

-- Session replays
CREATE TABLE IF NOT EXISTS session_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  error_group_id UUID REFERENCES error_groups(id),
  session_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  page_url TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  replay_signals JSONB,
  size_bytes BIGINT,
  object_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_replays_group ON session_replays(error_group_id);
CREATE INDEX IF NOT EXISTS idx_replays_session ON session_replays(session_id);

-- Replay screenshot artifacts
CREATE TABLE IF NOT EXISTS session_replay_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_id UUID NOT NULL REFERENCES session_replays(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT DEFAULT 'image/webp',
  width INT,
  height INT,
  captured_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- Source maps
CREATE TABLE IF NOT EXISTS source_maps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  release TEXT NOT NULL,
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, release, filename)
);
CREATE INDEX IF NOT EXISTS idx_sourcemaps_lookup ON source_maps(project_id, release, filename);

-- Add session_id and release to error_events
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS release TEXT;
CREATE INDEX IF NOT EXISTS idx_error_events_session ON error_events(session_id);

-- ===== from 004_users_and_sessions.sql =====
-- 004_users_and_sessions.sql
-- Adds user accounts, refresh tokens, and OAuth authorization codes for
-- the roll-your-own auth system (bcrypt + JWT).

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL UNIQUE,
  code_challenge TEXT,
  code_challenge_method TEXT,
  redirect_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE constraints on email, token_hash, code_hash already create implicit indexes.
-- Only add indexes that are not covered by UNIQUE.
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ===== from 004a_refresh_token_families.sql =====
-- 004a_refresh_token_families.sql
-- Add family_id for refresh token rotation reuse detection.
-- Also fix cascade deletes for user cleanup (A5).

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS family_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);

-- Add ON DELETE CASCADE so deleting a user cleans up tokens
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_user_id_fkey;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE oauth_authorization_codes DROP CONSTRAINT IF EXISTS oauth_authorization_codes_user_id_fkey;
ALTER TABLE oauth_authorization_codes ADD CONSTRAINT oauth_authorization_codes_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ===== from 005_end_users.sql =====
-- 005_end_users.sql
-- B2B customer-scoped error tracking: end-user identity + affected users.

CREATE TABLE IF NOT EXISTS end_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  external_user_id TEXT NOT NULL,
  external_account_id TEXT,
  account_name TEXT,
  email TEXT,
  display_name TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, external_user_id)
);

-- Add affected_users_count to error_groups (used by B2B tracking).
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS affected_users_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE error_events ADD COLUMN IF NOT EXISTS end_user_id UUID REFERENCES end_users(id);

CREATE TABLE IF NOT EXISTS error_group_affected_users (
  error_group_id UUID NOT NULL REFERENCES error_groups(id),
  end_user_id UUID NOT NULL REFERENCES end_users(id),
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (error_group_id, end_user_id)
);

CREATE INDEX IF NOT EXISTS idx_end_users_project ON end_users(project_id);
CREATE INDEX IF NOT EXISTS idx_end_users_account ON end_users(project_id, external_account_id)
  WHERE external_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_end_users_email ON end_users(project_id, email)
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_affected_users_user ON error_group_affected_users(end_user_id);
CREATE INDEX IF NOT EXISTS idx_error_events_end_user ON error_events(end_user_id)
  WHERE end_user_id IS NOT NULL;

-- ===== from 006_nullable_github_repo.sql =====
-- Make github_repo nullable so projects can be created without a repo.
ALTER TABLE projects ALTER COLUMN github_repo DROP NOT NULL;
-- Do NOT set DEFAULT '' — NULL means "no repo configured" (semantically correct).

-- ===== from 007_github_token_encryption.sql =====
-- 007_github_token_encryption.sql
-- Per-project encrypted GitHub token storage
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_token_encrypted BYTEA;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_token_prefix TEXT;

-- ===== from 008_github_app_auth.sql =====
-- 008_github_app_auth.sql
-- GitHub App OAuth: GitHub identity on users, installation_id on orgs.

ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id BIGINT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT NULL;

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS github_installation_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id
  ON users(github_id) WHERE github_id IS NOT NULL;

-- ===== from 009_agent_sessions.sql =====
-- 009_agent_sessions.sql
-- Agent-first onboarding: tracks CLI-initiated auth sessions.

CREATE TABLE IF NOT EXISTS agent_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_url            TEXT NOT NULL,
    agent_name          TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'completed', 'expired')),
    org_id              UUID REFERENCES orgs(id),
    project_id          UUID REFERENCES projects(id),
    api_key_plaintext   TEXT,
    installation_id     BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes'
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_status
  ON agent_sessions(status) WHERE status = 'pending';

-- Tracks GitHub App installations with richer metadata than orgs.github_installation_id.
CREATE TABLE IF NOT EXISTS github_app_installations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id     BIGINT NOT NULL UNIQUE,
    github_org_name     TEXT NOT NULL,
    github_org_id       BIGINT NOT NULL,
    org_id              UUID NOT NULL REFERENCES orgs(id),
    repos               JSONB NOT NULL DEFAULT '[]',
    suspended           BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_installations_org
  ON github_app_installations(org_id);

-- ===== from 009_guide_the_agent.sql =====
-- 009_guide_the_agent.sql
-- New status values for the interactive investigation flow.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block,
-- so this file must be run outside a BEGIN/COMMIT wrapper.

ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'investigated';
ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'fixing';

-- New columns on error_groups for investigation results
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS root_cause TEXT;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS suggested_mitigation TEXT;

-- New columns on error_group_jobs for job type dispatch + user guidance
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'investigate';
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS guidance TEXT;

-- ===== from 010_friction_detection.sql =====
-- 010_friction_detection.sql
-- UX Friction Detection: 3 new tables + job table extension

-- Friction groups (analogous to error_groups)
CREATE TABLE IF NOT EXISTS friction_groups (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id           UUID NOT NULL REFERENCES projects(id),
    environment_id       UUID NOT NULL REFERENCES environments(id),
    fingerprint          TEXT NOT NULL,
    signal_type          TEXT NOT NULL,       -- rage_click, error_adjacent, form_abandon
    page_url             TEXT NOT NULL,       -- normalized
    element_selector     TEXT,
    element_text         TEXT,
    title                TEXT NOT NULL,

    occurrence_count     INT NOT NULL DEFAULT 1,
    affected_users_count INT NOT NULL DEFAULT 0,
    first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- LLM summary (cross-occurrence clustering)
    summary              TEXT,
    recommendation       TEXT,
    summarized_at        TIMESTAMPTZ,
    summarized_at_count  INT,                -- snapshot of occurrence_count at last summarization

    status               TEXT NOT NULL DEFAULT 'new',  -- new, reviewed, resolved, ignored
    resolved_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (project_id, fingerprint)
);

-- Individual friction events
CREATE TABLE IF NOT EXISTS friction_events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    friction_group_id UUID NOT NULL REFERENCES friction_groups(id),
    project_id        UUID NOT NULL REFERENCES projects(id),
    environment_id    UUID NOT NULL REFERENCES environments(id),
    page_url          TEXT NOT NULL,
    signal_type       TEXT NOT NULL,
    element_selector  TEXT,
    element_text      TEXT,
    breadcrumbs       JSONB NOT NULL DEFAULT '[]',
    context           JSONB NOT NULL DEFAULT '{}',
    session_id        TEXT,
    replay_events     JSONB,
    screenshot_key    TEXT,                    -- S3 key, NULL if screenshots disabled
    client_timestamp  TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Affected users per friction group
CREATE TABLE IF NOT EXISTS friction_group_affected_users (
    friction_group_id UUID NOT NULL REFERENCES friction_groups(id),
    end_user_id       UUID NOT NULL REFERENCES end_users(id),
    occurrence_count  INT NOT NULL DEFAULT 1,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (friction_group_id, end_user_id)
);

-- Extend job table for friction summarization jobs
-- Note: job_type was already added by migration 009. Only add source_id here.
ALTER TABLE error_group_jobs
    ADD COLUMN IF NOT EXISTS source_id UUID;

-- Backfill source_id from error_group_id for existing rows
UPDATE error_group_jobs SET source_id = error_group_id WHERE source_id IS NULL;
-- source_id stays nullable: existing error job INSERTs don't supply it.
-- New friction code explicitly sets source_id; existing error code uses error_group_id only.

-- Make error_group_id nullable (friction jobs don't reference error_groups)
ALTER TABLE error_group_jobs ALTER COLUMN error_group_id DROP NOT NULL;

-- Priority index: error jobs always claimed before friction jobs
CREATE INDEX IF NOT EXISTS idx_jobs_priority ON error_group_jobs(job_type, status, created_at)
    WHERE status = 'pending';

-- Friction group indexes
CREATE INDEX IF NOT EXISTS idx_friction_groups_project ON friction_groups(project_id, last_seen_at DESC);
-- Note: UNIQUE (project_id, fingerprint) on friction_groups already provides the fingerprint index
CREATE INDEX IF NOT EXISTS idx_friction_events_group ON friction_events(friction_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friction_events_project ON friction_events(project_id);
CREATE INDEX IF NOT EXISTS idx_friction_affected_users ON friction_group_affected_users(friction_group_id);

-- ===== from 011_resolution_lifecycle.sql =====
-- 011_resolution_lifecycle.sql
-- Adds merged + archived statuses, lifecycle timestamp columns, and silence window index.

-- Ensure investigated/fixing exist (added in 009, repeated here for branch safety).
ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'investigated';
ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'fixing';
ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'merged';
ALTER TYPE error_group_status ADD VALUE IF NOT EXISTS 'archived';

ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Partial index for the silence window checker: find merged groups past the 24h window.
CREATE INDEX IF NOT EXISTS idx_error_groups_merged_silence
  ON error_groups (merged_at)
  WHERE status = 'merged';

-- ===== from 012_job_trace_url.sql =====
-- 012: Add trace_url to error_group_jobs for Langfuse trace linking.
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS trace_url TEXT;

-- ===== from 013_setup_pr.sql =====
-- 013_setup_pr.sql
-- Records the one-time "install Opslane SDK" setup PR per project. Idempotent.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_pr_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_pr_number INTEGER;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_pr_status TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_pr_error TEXT;

-- ===== from 014_replay_error_event_link.sql =====
-- 014_replay_error_event_link.sql
-- Project D (contract C1): link a replay directly to the error event that triggered it,
-- so correlation no longer depends solely on the session_id fallback join.
ALTER TABLE session_replays
  ADD COLUMN IF NOT EXISTS error_event_id UUID REFERENCES error_events(id);

CREATE INDEX IF NOT EXISTS idx_replays_error_event ON session_replays(error_event_id);

-- ===== from 015_project_allowed_origins.sql =====
-- Per-project browser Origin allowlist for SDK ingest.
-- Empty array = allow all origins (opt-in enforcement; backward compatible with
-- existing pilot projects that have no configured origins).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS allowed_origins TEXT[] NOT NULL DEFAULT '{}';
