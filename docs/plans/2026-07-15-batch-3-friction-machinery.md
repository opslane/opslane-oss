# Batch 3 — Teach the System Friction Exists: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the friction machinery — schema, worker friction path, TriggerFix gate, and a benchmarked analyzer — with **zero producers**: no code enqueues friction work in production.

**Architecture:** A `kind` column unifies friction into the existing `error_groups` incident pipeline. New enum statuses (`candidate`, `awaiting_approval`, `insight`) model the friction lifecycle. A pure-TypeScript rule analyzer in the worker reads scrubbed session chunks (Batch 1 output) and emits idempotent `friction_signals` rows. The worker's investigate path branches on `kind='friction'` to skip error-only guards and route to `insight`/`awaiting_approval` — never auto-fix.

**Tech Stack:** Postgres (append-only idempotent migrations), Go 1.24 ingestion (chi/pgx), Node 22 TypeScript worker (Vitest), shared runtime-free contracts.

**Tracking:** GitHub issue #55 (epic #31). Design: `docs/plans/2026-07-13-unified-incidents-replay-friction-design.md` (v4).

---

## Context you need before starting

**The sequencing rule (from issue #55):** the worker must understand friction *before* anything enqueues it — today's no-app-frames guard (`packages/worker/src/index.ts:168`) would auto-terminate any friction job as `needs_human`. This batch builds machinery; **no incidents are created, no `session_analysis` jobs are enqueued**. Detection turns on in Batch 4.

**What already exists (Batch 1 shipped):**
- `sessions` / `session_chunks` / `session_tombstones` tables — `packages/ingestion/db/migrations/002_sessions.sql`. Chunks are gzipped JSON `{events, meta}` envelopes in MinIO; `scrubbed_at IS NULL` means fail-closed unreadable.
- SDK telemetry inside rrweb streams: top-level events with `type === 5 && data.tag === 'opslane.telemetry'`, payload is the `TelemetryEvent` union in `packages/sdk/src/telemetry.ts:3-7` (click w/ selector+cursor+clickId, request_start/end w/ clickId causality, form_submit).
- Each chunk begins with a full rrweb snapshot (`checkoutEveryNms: 30_000`, `packages/sdk/src/replay.ts:204`).
- Migrations: `scripts/run-migrations.sh` re-runs every `*.sql` on every start — **every statement must be infinitely re-runnable**. No tracking table.

**What does NOT exist:** any friction code (the `friction_groups`/`friction_events`/`friction_group_affected_users` tables in `001_baseline.sql:374-460` are dead — zero readers/writers repo-wide), `kind` column, the three new statuses, `session_analysis` job type, `triggered_by`, `pr_outcomes`.

**Dependency status (from issue #55):**
- #53 Batch 1 — schema shipped; analyzer benchmarks run against *fixture* sessions, so open dogfood items don't block this batch.
- #28 fair scheduling — NOT done. Mitigation in this batch: `claimJob` demotes `session_analysis` below all other job types (Task 9). Full per-type caps stay in #28.
- #25 dead-letter — Task 9 extends the reaper so a dead-lettered `session_analysis` job marks its session `analysis_failed`.
- #30 fingerprint normalization — `packages/sdk/src/selector.ts` already strips hash-like ids/classes; the analyzer reuses the same philosophy server-side.
- #27 client timestamps — only needed for Batch 4 folding. Not a blocker here.

## Decisions made in this plan (were open in the design)

1. **Accounts entity (design v4-18, parked for Batch 3): NO new table.** Any future per-account flag keys on the derived `(project_id, external_account_id)` string, matching `idx_end_users_account` and the existing `Account` aggregation (`queries.go:617`). Rationale: the only consumer is Batch 6 (demand-gated); a real table means a backfill and dual write path with zero readers today. We do not even create a flags table yet (YAGNI) — Task 12 records the decision in the design doc.
2. **TriggerFix gates on kind AND status:** `error` requires `investigated` (the existing public contract), `friction` requires `awaiting_approval`. The cross combinations (`friction`+`investigated`, `error`+`awaiting_approval`) are rejected — they are reachable states (unarchive hard-sets `investigated` for every kind, `queries.go:1143`), not hypotheticals. `insight` — and every other status — still 409s. Unarchive becomes kind-aware (Task 4): `error → investigated`, `friction → insight` (the conservative choice: unarchiving must never mint fix-eligibility; a human can re-investigate if a code cause was already recorded).
3. **Analyzer lives in the worker** (`packages/worker/src/friction/`, AGPL): pure rule engine + golden-file tests + bench script. It has MinIO + pg clients and is where `session_analysis` jobs will run in Batch 4.
4. **Wire contracts go in `shared/`** (`SessionTelemetryEvent`, `SessionChunkEnvelope`). The SDK keeps its local `TelemetryEvent` (no new SDK dependency, no behavior change); a comment ties the two together.
5. **Defensive honesty stamp (slightly ahead of Batch 5):** friction fix jobs run only when `triggered_by='human'`, and a friction PR is stamped **Suggestion**, never "Opslane fixed". Cheap now; prevents any mislabeled PR in the Batch 4–5 gap (design v4-4).
6. **Old friction tables:** drop in migration 003 *and* delete from `001_baseline.sql`, gated on verifying they are empty in prod (Task 11). They have never had a writer.

## Verification commands (used throughout)

```bash
# Go (from packages/ingestion): focused → full
go test ./db ./handler && go build ./... && go test ./...
# Worker
pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test
# Shared
pnpm --filter @opslane/shared build
# Migration idempotency (disposable DB — never a retained one).
# NOTE: this only creates + double-applies. Run task-specific psql checks against
# opslane_mig_test BEFORE the final dropdb — cleanup is the last step, not part
# of the apply loop.
createdb opslane_mig_test && for i in 1 2; do for f in packages/ingestion/db/migrations/*.sql; do psql -d opslane_mig_test -v ON_ERROR_STOP=1 -f "$f"; done; done
# ... task-specific checks here ...
dropdb opslane_mig_test
```

---

### Task 1: Migration `003_friction.sql`

**Files:**
- Create: `packages/ingestion/db/migrations/003_friction.sql`

**Step 1: Write the migration**

Follow the 002 idempotency style exactly. `ALTER TYPE ... ADD VALUE IF NOT EXISTS` cannot run in a transaction block — fine, because `run-migrations.sh` uses plain `psql -f` (autocommit per statement), same as `001_baseline.sql:363`.

```sql
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
```

Note: inline `CHECK` on `ADD COLUMN IF NOT EXISTS` (triggered_by, signal_type) is safe — the constraint is only created with the column, and reruns skip both.

**Step 2: Verify idempotency + N−1 (fresh + double-apply on a disposable DB)**

Run the create + double-apply from the header (applies 001→003 twice). Expected: zero errors on both passes.
Then sanity-check the enum and constraints — with a REAL project row, so a CHECK failure is provably the kind constraint and not an FK error:

```bash
psql -d opslane_mig_test -c "SELECT unnest(enum_range(NULL::error_group_status));" \
  | grep -E "candidate|awaiting_approval|insight"   # 3 rows
psql -d opslane_mig_test <<'SQL'
INSERT INTO orgs (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'mig-test')
  ON CONFLICT DO NOTHING;  -- match 001_baseline's actual org/project column requirements
INSERT INTO projects (id, org_id, name) VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'mig-test');
INSERT INTO error_groups (project_id, fingerprint, title, kind)
  VALUES ('00000000-0000-0000-0000-000000000002', 'x', 'x', 'bogus');
SQL
# Expected: the LAST insert fails with ERROR ... violates check constraint "error_groups_kind_check"
dropdb opslane_mig_test   # cleanup only after all checks pass
```

**Step 3: Run existing Go tests against the migrated schema**

Run: `cd packages/ingestion && go test ./db ./handler`
Expected: PASS (schema is additive; nothing existing breaks).

**Step 4: Commit**

```bash
git add packages/ingestion/db/migrations/003_friction.sql
git commit -m "feat(schema): friction machinery migration — kind, statuses, friction_signals, pr_outcomes, receipts (#55)"
```

---

### Task 2: Shared contracts

**Files:**
- Modify: `shared/src/types.ts`
- Modify: `packages/dashboard/src/types/api.ts` (the dashboard does NOT consume the shared union — it keeps its own copies at :1; they must be updated by hand)
- Modify: the dashboard's status presentation map (grep `packages/dashboard/src` for `needs_human` to find the label/badge map)

**Step 1: Extend the types** (no test file — `shared` is types-only; the compile IS the test, and both Go mirrors and worker unions are checked in later tasks)

In `shared/src/types.ts`:

```ts
// ErrorGroupStatus (types.ts:79) — add the three friction-lifecycle values:
export type ErrorGroupStatus =
  | 'new'
  | 'queued'
  | 'analyzing'
  | 'investigated'
  | 'fixing'
  | 'pr_created'
  | 'needs_human'
  | 'resolved'
  | 'merged'
  | 'archived'
  // Friction lifecycle (epic #31 Batch 3, design v4-4/v4-10):
  | 'candidate'          // adjudication pending — hidden from every list/read API
  | 'awaiting_approval'  // code cause found; parked for a human; fix-eligible
  | 'insight';           // no code cause; terminal; NEVER becomes a PR

// JobType (types.ts:193):
export type JobType = 'error_fix' | 'investigate' | 'fix' | 'setup_pr' | 'session_analysis';

// New, near Incident:
export type IncidentKind = 'error' | 'friction';
export type FrictionSignalType = 'rage_click' | 'dead_click' | 'form_abandon';

// Add to Incident (types.ts:129):
//   kind: IncidentKind;

// === Session chunk wire format (MUST stay wire-compatible with
// packages/sdk/src/telemetry.ts and packages/sdk/src/chunk-upload.ts;
// the SDK keeps its own local definitions to avoid a dependency) ===
export type SessionTelemetryEvent =
  | { kind: 'click'; clickId: string; selector: string; cursor: string; at: number }
  | { kind: 'request_start'; requestId: string; clickId: string | null; method: string; url: string; at: number }
  | { kind: 'request_end'; requestId: string; status: number; at: number }
  | { kind: 'form_submit'; selector: string; at: number };

/** Decompressed session_chunks object body: { events, meta }. `events` are raw
 *  rrweb eventWithTime entries; telemetry rides as rrweb custom events
 *  (top-level type === 5, data.tag === 'opslane.telemetry', data.payload above). */
export interface SessionChunkEnvelope {
  events: unknown[];
  meta: { sdk_version: string; has_full_snapshot: boolean; chunked_at: number };
}
```

**Step 2: Mirror in the dashboard's own types** (the compiler will NOT catch this — `packages/dashboard/src/types/api.ts:1` is a hand-maintained copy):

- Add `'candidate' | 'awaiting_approval' | 'insight'` to its `ErrorGroupStatus`, and `kind: 'error' | 'friction'` to its `Incident`.
- Minimal presentation only (badges/buttons stay deferred to Batch 4/5): add the two visible new statuses to the status label/color map — `insight` → "Insight" (terminal styling, like `resolved`), `awaiting_approval` → "Awaiting approval" (like `investigated`). `candidate` needs no rendering — the server never returns it (Task 3) — but if the map is exhaustively typed, map it to something inert.

**Step 3: Build everything**

Run: `pnpm --filter @opslane/shared build && pnpm -r build`
Expected: PASS. If the dashboard's status map is an exhaustively-typed `Record<ErrorGroupStatus, …>`, the compile now flags every site to fill in.

**Step 4: Commit**

```bash
git add shared/src/types.ts packages/dashboard/src/types/api.ts packages/dashboard/src
git commit -m "feat(shared): friction statuses, kind, session_analysis job type, chunk wire contracts (#55)"
```

---

### Task 3: Ingestion read path — `kind` exposed, `candidate` hidden

**Files:**
- Modify: `packages/ingestion/db/queries.go` (ErrorGroup struct ~:230, `ListErrorGroups` :491-554, the single-group getter used by the incident-detail handler)
- Modify: `packages/ingestion/handler/read_api.go` (`incidentJSON` :18, `toIncidentJSON` :55)
- Test: `packages/ingestion/db/queries_test.go` or the existing pattern in `packages/ingestion/handler/read_api_test.go`

**Step 1: Write failing tests**

Follow the existing integration-test pattern in `read_api_test.go` / `db` tests (live Postgres). Three behaviors:

```go
// 1. kind round-trips: insert a group with kind='friction', list it, expect Kind=="friction".
// 2. candidate is invisible: insert a group with status='candidate';
//    ListErrorGroups (no filter) must NOT return it; ListErrorGroups with
//    Status:"candidate" must ALSO return empty (hidden means hidden, v4-10).
// 3. the single-incident getter returns not-found for a candidate group.
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && go test ./db ./handler -run 'Candidate|Kind'`
Expected: FAIL (no Kind field; candidate rows returned).

**Step 3: Implement**

- `ErrorGroup` struct: add `Kind string` (and `SignalType`, `ElementSelector`, `PageURLNormalized *string` — cheap to carry now, the Batch 4 dashboard needs them).
- `ListErrorGroups` (queries.go:492): add `eg.kind` to the SELECT and `&g.Kind` to Scan; add a **non-optional** where clause next to `eg.project_id = $1`:

```go
wheres := []string{"eg.project_id = $1", "eg.status <> 'candidate'"}
```

- Apply the same `status <> 'candidate'` guard to the single-group getter the incident-detail endpoint uses (find it near `ListErrorGroups`; it must return `pgx.ErrNoRows` → 404 for candidates).
- `incidentJSON`: add `Kind string \`json:"kind"\``; map it in `toIncidentJSON`. Mirror `Incident.kind` in `shared/src/types.ts` (Task 2 noted it).

**Step 4: Run tests to verify they pass**

Run: `cd packages/ingestion && go test ./db ./handler`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/handler/read_api.go packages/ingestion/db/*_test.go packages/ingestion/handler/*_test.go shared/src/types.ts
git commit -m "feat(ingestion): expose incident kind; hide candidate from all read paths (#55)"
```

---

### Task 4: TriggerFix gate — kind AND status, `insight` never

**Files:**
- Modify: `packages/ingestion/db/queries.go` (`TriggerFixJob` :729-769, `UnarchiveErrorGroup` :1143)
- Modify: `packages/ingestion/handler/read_api.go` (409 message :640)
- Test: existing TriggerFix tests in `packages/ingestion/handler/read_api_test.go` / db tests

**Step 1: Write failing tests** — all four kind/status combinations, plus insight, plus unarchive:

```go
// TriggerFix matrix:
// 1. kind='error',    status='investigated'      → succeeds; group 'fixing'; job row
//    has job_type='fix' AND triggered_by='human'.
// 2. kind='friction', status='awaiting_approval' → succeeds (same assertions).
// 3. kind='friction', status='investigated'      → ErrNotInvestigated (409). Reachable
//    state — see unarchive below — and NOT part of the friction contract.
// 4. kind='error',    status='awaiting_approval' → ErrNotInvestigated (409).
// 5. any kind,        status='insight'           → ErrNotInvestigated (409). NEVER a PR.
// 6. regression: kind='error', status='new'      → 409 (unchanged).
// Unarchive:
// 7. archived error    → unarchive → status 'investigated' (existing contract).
// 8. archived friction → unarchive → status 'insight' (never mints fix-eligibility).
```

**Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./db ./handler -run 'TriggerFix|Unarchive'`
Expected: FAIL (awaiting_approval rejected; friction unarchives to investigated; no triggered_by).

**Step 3: Implement**

In `TriggerFixJob` (queries.go:738-758):

```go
// Fix-triggerable states are per-kind (design v4-4): errors keep their public
// 'investigated' contract; friction requires 'awaiting_approval'. The cross
// combinations are real, reachable states (unarchive, below) and are rejected.
// 'insight' is terminal and deliberately absent — it must never become a PR.
`UPDATE error_groups
 SET status = 'fixing', updated_at = now()
 WHERE id = $1 AND project_id = $2
   AND (
     (kind = 'error'    AND status = 'investigated')
     OR
     (kind = 'friction' AND status = 'awaiting_approval')
   )
 RETURNING id`,
```

Make `UnarchiveErrorGroup` (queries.go:1143) kind-aware — unarchiving must restore a kind-safe state, and conservatively (a fix-eligible state is granted by investigation, not by unarchiving):

```go
`UPDATE error_groups
 SET status = CASE WHEN kind = 'friction' THEN 'insight'::error_group_status
                   ELSE 'investigated'::error_group_status END,
     archived_at = NULL, updated_at = now()
 WHERE id = $1 AND project_id = $2 AND status = 'archived'`,
```

(A friction incident that was `awaiting_approval` before archiving comes back as `insight`; the recorded `root_cause` survives, and re-investigation can re-promote it. Carrying a `pre_archive_status` column is deliberate non-scope.)

Stamp the receipt on the TriggerFix insert:

```go
`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, guidance, triggered_by)
 VALUES ($1, $2, 'fix', $3, 'human')
 RETURNING id`,
```

Update the handler's 409 text (read_api.go:641) to `"incident is not in a fix-triggerable state"`.

**Step 4: Run tests**

Run: `cd packages/ingestion && go test ./db ./handler && go build ./...`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/handler/read_api.go packages/ingestion/*_test.go
git commit -m "feat(ingestion): TriggerFix gates on kind+status, never insight; kind-aware unarchive; triggered_by=human (#55)"
```

---

### Task 5: Worker DB layer — kind awareness, new statuses, receipts, friction queries

**Files:**
- Modify: `packages/worker/src/db.ts`
- Test: `packages/worker/src/__tests__/db-queries.test.ts` (mocked-pg pattern, see :1-10 of that file)

**Step 1: Write failing tests** (mocked pg; assert SQL text + params like the existing tests do)

```ts
// 1. getErrorGroup returns kind (mock a row with kind: 'friction').
// 2. updateGroupInvestigation accepts status 'insight' and 'awaiting_approval'
//    (compile-level: the union; runtime: passes status through as $3).
// 3. updateGroupAndCreateFixJob's INSERT includes triggered_by = 'auto'.
// 4. getFrictionSignalsForGroup queries friction_signals scoped by incident_id AND project_id.
// 5. getScrubbedChunksForSession's SQL contains "scrubbed_at IS NOT NULL" (fail-closed).
// 6. getSessionForAnalysis selects environment_id, end_user_id, status.
```

**Step 2: Run to verify failure**

Run: `pnpm --filter @opslane/worker test -- db-queries`
Expected: FAIL.

**Step 3: Implement in `db.ts`**

- `ErrorGroupData` (:330): add `kind: 'error' | 'friction'; signal_type: string | null; element_selector: string | null; page_url_normalized: string | null;` and add the four columns to `getErrorGroup`'s SELECT (:342).
- `updateGroupInvestigation` (:488): widen the status union to `'investigated' | 'fixing' | 'needs_human' | 'insight' | 'awaiting_approval'`. The needs_human reason contract stays untouched.
- `updateGroupAndCreateFixJob` (:564): `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by) VALUES ($1, $2, 'fix', 'auto')`.
- New queries (each tenant-scoped, per worker AGENTS.md):

```ts
export interface FrictionSignalRow {
  id: string;
  session_id: string;
  signal_type: 'rage_click' | 'dead_click' | 'form_abandon';
  fingerprint: string;
  element_selector: string | null;
  page_url_normalized: string;
  occurred_at: string;
  occurrence_count: number;
  rule_version: number;
}

export async function getFrictionSignalsForGroup(errorGroupId: string, projectId: string): Promise<FrictionSignalRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<FrictionSignalRow>(
    `SELECT id, session_id, signal_type, fingerprint, element_selector,
            page_url_normalized, occurred_at, occurrence_count, rule_version
     FROM friction_signals
     WHERE incident_id = $1 AND project_id = $2
       AND superseded_by IS NULL AND retracted_at IS NULL
     ORDER BY occurred_at ASC`,
    [errorGroupId, projectId],
  );
  return rows;
}

export interface SessionChunkRow { session_id: string; seq: number; object_key: string; size_bytes: number | null; has_full_snapshot: boolean; }

/** FAIL-CLOSED (design v4-2/#47): only scrubbed chunks are ever readable.
 *  size_bytes (server-verified at commit) drives the bounded-read budget (Task 8/9). */
export async function getScrubbedChunksForSession(sessionId: string, projectId: string): Promise<SessionChunkRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<SessionChunkRow>(
    `SELECT session_id, seq, object_key, size_bytes, has_full_snapshot
     FROM session_chunks
     WHERE session_id = $1 AND project_id = $2 AND scrubbed_at IS NOT NULL
     ORDER BY seq ASC`,
    [sessionId, projectId],
  );
  return rows;
}

export interface SessionRow { id: string; project_id: string; environment_id: string; end_user_id: string | null; status: string; }

export async function getSessionForAnalysis(sessionId: string, projectId: string): Promise<SessionRow | null> { /* SELECT the five columns, WHERE id AND project_id */ }

export async function setSessionAnalysisStatus(
  sessionId: string, projectId: string,
  status: 'analyzing' | 'analyzed' | 'analysis_failed',
  ruleVersion?: number,
): Promise<void> {
  // UPDATE sessions SET status=$3, analyzer_rule_version = COALESCE($4, analyzer_rule_version)
  // WHERE id=$1 AND project_id=$2
}
```

**Step 4: Run tests**

Run: `pnpm --filter @opslane/worker test -- db-queries && pnpm --filter @opslane/worker build`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/__tests__/db-queries.test.ts
git commit -m "feat(worker): kind-aware group reads, friction/session queries, triggered_by=auto receipt (#55)"
```

---

### Task 6: Friction analyzer core — rules v1 + golden fixtures

Pure functions, zero I/O. This is the heart of the batch; do it before the worker routing so the evidence gatherer can reuse its parsing.

**Files:**
- Create: `packages/worker/src/friction/analyzer.ts`
- Create: `packages/worker/src/friction/fingerprint.ts`
- Create: `packages/worker/src/friction/__tests__/analyzer.test.ts`
- Create: `packages/worker/src/friction/__tests__/fixtures/` — `rage_dead_click.json`, `stepper_clicks.json`, `dead_click.json`, `slow_async_click.json`, `unrelated_poll.json`, `form_abandon.json`, `form_completed.json`, `late_chunk_retraction.json`

**Step 1: Author the fixtures first** (each is a JSON array of `SessionChunkEnvelope`s — hand-written, small, with a comment-bearing `meta.sdk_version` like `"fixture"`; timestamps are epoch ms). Telemetry event shapes come from `shared` (Task 2). Every fixture chunk starts with a stub full-snapshot event (`{"type":2,"data":{},"timestamp":...}`) and a Meta event carrying the page URL (`{"type":4,"data":{"href":"https://app.example.com/checkout/42?q=1"},"timestamp":...}`). Encode DOM responses as rrweb mutations `{"type":3,"data":{"source":0,...},"timestamp":...}` and input activity as `{"type":3,"data":{"source":5,"id":<nodeId>,...},"timestamp":...}`.

Fixture truth table (this IS the spec — design §3):

| Fixture | Contents | Expected signals |
|---|---|---|
| `rage_dead_click.json` | 4 clicks on `[data-testid="save"]` at t, t+250, t+500, t+800; no mutation, no request_start with any of those clickIds within 1s of the last click | 1 × `rage_click`, occurrence_count 1, occurred_at = last click |
| `stepper_clicks.json` | 4 fast clicks on `[data-testid="qty-up"]`, each followed by a mutation within 100ms | none |
| `dead_click.json` | 1 click, `cursor:"pointer"`, no mutation and no causally-linked request within 1s | 1 × `dead_click` |
| `slow_async_click.json` | 1 click; `request_start` with **matching clickId** at +200ms (response may come later) | none (causal attribution, v4-12) |
| `unrelated_poll.json` | 1 click on pointer element; `request_start` with `clickId: null` at +300ms (an analytics poller); no mutation | 1 × `dead_click` — the poll must NOT suppress it (v4-12) |
| `form_abandon.json` | input mutations on 3 distinct node ids spanning 12s; no `form_submit`; session ends | 1 × `form_abandon` |
| `form_completed.json` | same but with a `form_submit` after the inputs | none |
| `late_chunk_retraction.json` | chunk 0: the `dead_click.json` scenario; chunk 1: the mutation at +400ms after the click (boundary split the click from its response) | analyzing chunk 0 only → `dead_click`; analyzing both → none (Task 7 tests the `retracted_at` write) |

**Step 2: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { analyzeSession, RULE_VERSION } from '../analyzer.js';
import rageFixture from './fixtures/rage_dead_click.json';
// ... one describe block per fixture row above, e.g.:
it('flags a rage click when repeated clicks cause nothing', () => {
  const signals = analyzeSession(rageFixture as never);
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    signalType: 'rage_click',
    elementSelector: '[data-testid="save"]',
    pageUrlNormalized: 'https://app.example.com/checkout/:id', // query stripped, numeric segment templated
    ruleVersion: RULE_VERSION,
  });
});
// Same-signal-twice-in-one-session fixture (append a second rage cluster on the
// same selector): expect ONE signal with occurrenceCount: 2 (v4-5).
// Determinism: analyzeSession(f) deep-equals analyzeSession(f) run twice.
```

**Step 3: Run to verify failure**

Run: `pnpm --filter @opslane/worker test -- friction`
Expected: FAIL (module doesn't exist).

**Step 4: Implement**

`fingerprint.ts`:

```ts
import { createHash } from 'node:crypto';

/** Strip query/hash; template numeric and uuid/hash-like path segments (#30 family). */
export function normalizePageUrl(href: string): string {
  try {
    const u = new URL(href);
    const path = u.pathname.split('/').map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f-]{8,}$/i.test(seg) ? ':id' : seg,
    ).join('/');
    return `${u.origin}${path}`;
  } catch { return href.split(/[?#]/)[0] ?? href; }
}

export function frictionFingerprint(signalType: string, selector: string | null, pageUrl: string): string {
  return createHash('sha256').update(`${signalType}|${selector ?? ''}|${pageUrl}`).digest('hex').slice(0, 32);
}
```

`analyzer.ts` — the contract:

```ts
import type { SessionChunkEnvelope, SessionTelemetryEvent, FrictionSignalType } from '@opslane/shared';

export const RULE_VERSION = 1;
// Rule constants — keep them named, they ARE the spec:
const CLICK_CLUSTER_GAP_MS = 1_000;   // successive rage clicks
const RAGE_MIN_CLICKS = 3;
const RESPONSE_WINDOW_MS = 1_000;     // click → mutation/causal-request window
const FORM_MIN_FIELDS = 2;
const FORM_MIN_ENGAGED_MS = 10_000;

export interface DetectedSignal {
  signalType: FrictionSignalType;
  fingerprint: string;
  elementSelector: string | null;
  pageUrlNormalized: string;
  occurredAt: number;        // epoch ms (client time — the telemetry `at`)
  occurrenceCount: number;
  ruleVersion: number;
}

/** Pure + deterministic over the scrubbed chunks it is given (sorted by seq).
 *  Late chunks change the answer — retraction is the CALLER's job (persist step). */
export function analyzeSession(chunks: SessionChunkEnvelope[]): DetectedSignal[] { ... }
```

Implementation notes (keep inside the file as short comments only where non-obvious):
- Parse defensively: `events` is `unknown[]`; narrow each entry — a telemetry event is `{ type: 5, data: { tag: 'opslane.telemetry', payload } }` at the TOP level of `events` (`type: 5` also occurs as a *node* type inside snapshots — only trust top-level events). Collect: telemetry list, mutation timestamps (`type === 3 && data.source === 0`), input events (`type === 3 && data.source === 5`, keep `data.id`), current page URL (last `type === 4` Meta `href` seen — track per-timestamp so signals get the URL active at click time).
- **Causal attribution (v4-12):** a click is "answered" only by (a) a DOM mutation within `RESPONSE_WINDOW_MS` after it, or (b) a `request_start` whose `clickId` matches that click's `clickId`. `clickId: null` requests (pollers, analytics) never count. The SDK already excludes its own traffic (`network.ts isSdkEndpoint`).
- **Rage:** cluster clicks by selector where successive gaps ≤ `CLICK_CLUSTER_GAP_MS`; cluster size ≥ `RAGE_MIN_CLICKS`; unanswered (per above, measured from the last click) → one `rage_click`. A rage cluster suppresses per-click `dead_click` emissions for its members.
- **Dead click:** single unanswered click with `cursor === 'pointer'` (the clickable annotation).
- **Form abandon:** ≥ `FORM_MIN_FIELDS` distinct input `data.id`s, span first→last input ≥ `FORM_MIN_ENGAGED_MS`, and no `form_submit` telemetry anywhere later in the session. `elementSelector: null`, `occurredAt` = last input. One per session (v1).
- **Occurrence folding:** two clusters/instances with the same fingerprint → one `DetectedSignal` with `occurrenceCount` summed, `occurredAt` = first occurrence.

**Step 5: Run tests until green**

Run: `pnpm --filter @opslane/worker test -- friction && pnpm --filter @opslane/worker build`
Expected: PASS, all fixture rows.

**Step 6: Commit**

```bash
git add packages/worker/src/friction shared/src/types.ts
git commit -m "feat(worker): deterministic friction analyzer v1 — rage/dead click, form abandon, causal attribution (#55)"
```

---

### Task 7: Signal persistence — idempotent insert + retraction

**The settled semantics (matches the migration comment in Task 1):** every analysis pass is whole-session truth at its rule version. The current pass's signals are upserted live (clearing `retracted_at` — re-detection after new evidence is a legitimate recurrence, not a bug); live rows the current pass no longer produces get `retracted_at` set. `superseded_by` is reserved for cross-rule-version replacement and is untouched in Batch 3.

**Files:**
- Create: `packages/worker/src/friction/persist.ts`
- Test: `packages/worker/src/friction/__tests__/persist.test.ts` (mocked-pg pattern)

**Step 1: Write failing tests**

```ts
// 1. Idempotent: INSERT uses ON CONFLICT (session_id, fingerprint, rule_version)
//    DO UPDATE — running the same pass twice yields identical rows (v4-5).
// 2. Retraction: pass 1 produces [A, B]; pass 2 produces [A] → B gets
//    retracted_at set; A stays live.
// 3. Legitimate recurrence resurrects: pass 3 produces [A, B] again → B's
//    retracted_at is cleared by the upsert (whole-pass-is-truth).
// 4. Repeated reanalysis is stable: pass 4 = pass 3 → no net change.
// 5. superseded_by is never written by Batch 3 persistence.
// 6. environment_id / end_user_id come from the sessions row, not caller guesses.
```

**Step 2: Run to verify failure** — `pnpm --filter @opslane/worker test -- persist` → FAIL.

**Step 3: Implement**

```ts
import type { DetectedSignal } from './analyzer.js';
import { getPool, type SessionRow } from '../db.js';

/** Persist one analysis pass for a session (whole-pass-is-truth, see 003_friction.sql).
 *  Idempotent per (session, fingerprint, rule_version); absent-from-this-pass rows
 *  are retracted; re-detected rows are resurrected. */
export async function writeFrictionSignals(
  session: SessionRow,
  signals: DetectedSignal[],
  ruleVersion: number,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of signals) {
      await client.query(
        `INSERT INTO friction_signals
           (session_id, project_id, environment_id, end_user_id, rule_version,
            signal_type, fingerprint, element_selector, page_url_normalized,
            occurred_at, occurrence_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_timestamp($10 / 1000.0), $11)
         ON CONFLICT (session_id, fingerprint, rule_version)
         DO UPDATE SET occurrence_count = EXCLUDED.occurrence_count,
                       occurred_at = EXCLUDED.occurred_at,
                       retracted_at = NULL`,
        [session.id, session.project_id, session.environment_id, session.end_user_id,
         ruleVersion, s.signalType, s.fingerprint, s.elementSelector,
         s.pageUrlNormalized, s.occurredAt, s.occurrenceCount],
      );
    }
    // Retract (v4-5): live rows at this rule version that this pass no longer produces.
    await client.query(
      `UPDATE friction_signals SET retracted_at = now()
       WHERE session_id = $1 AND project_id = $2 AND rule_version = $3
         AND retracted_at IS NULL AND superseded_by IS NULL
         AND fingerprint <> ALL($4::text[])`,
      [session.id, session.project_id, ruleVersion, signals.map((s) => s.fingerprint)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

(Fold-propagation of retractions — un-boosting an incident a retracted signal was folded into — is Batch 4, when folding exists.)

**Step 4: Run tests** — `pnpm --filter @opslane/worker test -- persist` → PASS.

**Step 5: Integration check with the retraction fixture** — extend `analyzer.test.ts`'s late-chunk case to drive `writeFrictionSignals` across passes (chunk 0 only, then chunks 0+1, then a fixture where the signal re-proves) with mocked pg, asserting retract → resurrect transitions.

**Step 6: Commit**

```bash
git add packages/worker/src/friction/persist.ts packages/worker/src/friction/__tests__/persist.test.ts
git commit -m "feat(worker): idempotent friction signal persistence with retract/resurrect semantics (#55)"
```

---

### Task 8: Worker friction path — routing, guards skipped, insight/awaiting_approval

**Files:**
- Create: `packages/worker/src/friction/chunk-reader.ts` (bounded, fail-closed chunk reads — the ONLY code path allowed to touch chunk objects)
- Create: `packages/worker/src/friction/investigate-friction.ts`
- Create: `packages/worker/src/friction/friction-evidence.ts`
- Modify: `packages/worker/src/index.ts` (`processInvestigateJob` :150, `processFixJob` :354)
- Modify: `packages/worker/src/harness/diff-judge.ts` (`DiffJudgeInput` :46, prompt :60-84)
- Test: `packages/worker/src/friction/__tests__/friction-path.test.ts`, extend `packages/worker/src/__tests__/index.test.ts`

**Step 1: Write failing tests** (follow `index.test.ts`'s existing mocking style for `db` and `investigate`)

```ts
// THE BATCH GATE, as tests:
// 1. kind='friction' group + investigate job → hasNoAppFrames is NEVER called,
//    getSourceMaps/getReplayForGroup are NEVER called, and the group ends in
//    'insight' or 'awaiting_approval' — never needs_human/unfixable_no_app_frames.
// 2. friction + investigation finds a code cause (even confidence 'high') →
//    status 'awaiting_approval'; updateGroupAndCreateFixJob is NEVER called
//    (the v4-4 hard gate: friction never auto-fixes).
// 3. friction + no code cause → status 'insight' with rootCause stored; no job created.
// 4. processFixJob with a friction group and triggered_by !== 'human' → refuses:
//    group reverted to 'awaiting_approval', job completes without running the pipeline.
// 5. error-kind groups: behavior byte-identical to today (regression: existing
//    index.test.ts suite still green).
// 6. diff-judge: input with frictionEvidence renders a '## Friction Evidence'
//    section fenced in <untrusted_data>.
```

**Step 2: Run to verify failure** — `pnpm --filter @opslane/worker test -- index friction-path` → FAIL.

**Step 3: Implement**

`chunk-reader.ts` — the bounded-decompression contract (design line 145: "Size cap ~20MB **measured with a bounded streaming decompressor**"; #48's gzip-bomb concern applies to reads too):

```ts
import { gunzipSync } from 'node:zlib';
import type { SessionChunkEnvelope } from '@opslane/shared';
import type { SessionChunkRow } from '../db.js';
import { fetchObject, getMinIOConfig } from '../minio-client.js';

export const MAX_CHUNK_COMPRESSED_BYTES = 5 * 1024 * 1024;   // skip-fetch guard, from size_bytes
export const MAX_CHUNK_INFLATED_BYTES = 25 * 1024 * 1024;    // per-chunk bomb guard
export const MAX_SESSION_INFLATED_BYTES = 20 * 1024 * 1024;  // cumulative analysis budget (design §3)

export class ChunkReadError extends Error {}     // corrupt gzip/JSON — the session must NOT be marked analyzed

export interface BoundedReadResult {
  envelopes: SessionChunkEnvelope[];
  inflatedBytes: number;
  truncated: boolean;   // cumulative budget hit — envelopes are the bounded prefix
}

/** Reads scrubbed chunks in seq order under a hard byte budget.
 *  - compressed size over cap, or unknown (NULL size_bytes = never committed): REFUSE the chunk → ChunkReadError.
 *  - inflation is bounded (zlib maxOutputLength aborts instead of buffering a bomb).
 *  - cumulative inflated budget exhausted: STOP, return truncated=true (honest partial).
 *  - corrupt gzip / unparseable JSON: throw ChunkReadError — never silently skip. */
export async function readChunksBounded(chunks: SessionChunkRow[]): Promise<BoundedReadResult> {
  const minio = getMinIOConfig();
  if (!minio) throw new ChunkReadError('MinIO not configured');
  const envelopes: SessionChunkEnvelope[] = [];
  let inflatedBytes = 0;
  for (const chunk of chunks) {
    if (chunk.size_bytes == null || chunk.size_bytes > MAX_CHUNK_COMPRESSED_BYTES) {
      throw new ChunkReadError(`chunk ${chunk.session_id}/${chunk.seq}: compressed size ${chunk.size_bytes ?? 'unknown'} outside policy`);
    }
    if (inflatedBytes >= MAX_SESSION_INFLATED_BYTES) return { envelopes, inflatedBytes, truncated: true };
    const buf = await fetchObject(chunk.object_key, minio);
    let inflated: Buffer;
    try {
      inflated = gunzipSync(buf, { maxOutputLength: MAX_CHUNK_INFLATED_BYTES });
    } catch (err) {
      throw new ChunkReadError(`chunk ${chunk.session_id}/${chunk.seq}: gunzip failed/over-cap: ${String(err)}`);
    }
    inflatedBytes += inflated.length;
    try {
      envelopes.push(JSON.parse(inflated.toString('utf-8')) as SessionChunkEnvelope);
    } catch {
      throw new ChunkReadError(`chunk ${chunk.session_id}/${chunk.seq}: invalid JSON envelope`);
    }
  }
  return { envelopes, inflatedBytes, truncated: false };
}
```

Test it directly (`__tests__/chunk-reader.test.ts`): oversized `size_bytes` refused; NULL `size_bytes` refused; a real gzip bomb (gzip of 100MB of zeros) throws rather than inflating (assert `maxOutputLength` abort); cumulative budget returns `truncated: true` with the prefix; corrupt bytes throw `ChunkReadError`.

`friction-evidence.ts` — evidence for the investigator (and later the judge):

```ts
import type { SessionChunkEnvelope } from '@opslane/shared';
import * as db from '../db.js';
import { readChunksBounded } from './chunk-reader.js';

export interface FrictionEvidence {
  signals: db.FrictionSignalRow[];
  /** Human-readable interaction timeline around each signal (±15s), built from
   *  telemetry events in the SCRUBBED chunks only. */
  timeline: string;
  truncated: boolean;   // stated in the prompt when true — the model must know evidence is partial
}

export async function gatherFrictionEvidence(groupId: string, projectId: string): Promise<FrictionEvidence | null> {
  const signals = await db.getFrictionSignalsForGroup(groupId, projectId);
  if (signals.length === 0) return null;           // hand-created incidents may have none — investigation still runs
  // For each distinct session: getScrubbedChunksForSession (fail-closed) →
  // readChunksBounded (bounded, throwing on corruption) → extract telemetry
  // events (reuse the analyzer's narrowing helpers — export them), keep events
  // within ±15s of any signal.occurred_at, format as
  // "t+0.00s click [data-testid=save] (cursor: pointer)" lines.
  // A ChunkReadError here degrades to timeline-less evidence (signals only) with
  // a logged warning — investigation can proceed on signal metadata alone; it
  // does NOT fabricate a timeline.
  ...
}
```

`investigate-friction.ts` — reuses the agent loop pattern from `investigate.ts` (`investigateError` :379) with a friction prompt. Return shape:

```ts
export interface FrictionInvestigationResult {
  codeCause: boolean;                 // true → awaiting_approval, false → insight
  confidence: 'high' | 'medium' | 'low';
  reason: string;                     // root-cause narrative (or why it's UX-only)
  remediation?: string;
}
```

Prompt essentials (fence ALL evidence in `<untrusted_data>` like `investigate.ts` does for stack traces): the incident's `signal_type` / `element_selector` / `page_url_normalized`, the evidence timeline, and the classification instruction — "decide whether this friction has a CODE cause this repo could fix (a broken handler, a missing preventDefault, a dead route) or is a UX/design observation with no code defect. When in doubt: codeCause=false — an insight is honest, a speculative fix is not."

`index.ts` — branch at the top of `processInvestigateJob`, right after `getErrorGroup` (:157), BEFORE the no-app-frames guard:

```ts
if (group.kind === 'friction') {
  await processFrictionInvestigateJob(job, group, signal);
  return;
}
```

`processFrictionInvestigateJob` (new, in `index.ts` beside its sibling): sets `analyzing`; checks `ANTHROPIC_API_KEY` (same as :195-207); clones the repo (same as :226-253 — a friction investigation is codebase-aware); calls `gatherFrictionEvidence` + `investigateFriction`; routes:

```ts
if (result.codeCause) {
  await updateGroupInvestigation(job.errorGroupId, job.projectId, 'awaiting_approval', {
    rootCause: result.reason, suggestedMitigation: result.remediation, confidence: result.confidence,
  });
  // HARD GATE (design v4-4): friction NEVER auto-fixes in Batch 3/4 — even at
  // high confidence. updateGroupAndCreateFixJob must not be called on this path.
} else {
  await updateGroupInvestigation(job.errorGroupId, job.projectId, 'insight', {
    rootCause: result.reason, confidence: result.confidence,
  });
}
```

No `hasNoAppFrames`, no `getSourceMaps`, no `getReplayForGroup` on this path.

`processFixJob` guard, immediately after `getErrorGroup` (:359) — needs the job's `triggered_by` (add it to `claimJob`'s RETURNING + `ClaimedJob`):

```ts
if (group.kind === 'friction' && job.triggeredBy !== 'human') {
  // Batch 3-5 gap safety: only a human may move friction to a PR.
  await updateGroupStatus(job.errorGroupId, job.projectId, 'awaiting_approval' as never, {});
  logger.warn('Refused non-human friction fix job', { job_id: job.id });
  return;
}
```

(`updateGroupStatus`'s `ErrorGroupStatus` type already includes the new statuses after Task 2.)

`diff-judge.ts`: add `frictionEvidence?: string` to `DiffJudgeInput` (:46) and, after the "Files referenced in stack trace" block (:79):

```ts
${input.frictionEvidence ? `## Friction Evidence (what the user experienced)\n<untrusted_data>\n${input.frictionEvidence}\n</untrusted_data>\n` : ''}
```

Thread it from `agent-fix.ts`'s `judgeDiff` call site (:897-921) — pass evidence only when the group is friction (plumb via `runAgentFix` input; acceptable to land the field now and wire the value in the same task).

`pr.ts` honesty stamp (Decision 5): in `buildPRBody` (:267) and the PR title (:399), accept a `kind` field on the input; when `'friction'`, header becomes `## 💡 Opslane suggestion:` and title prefix `[Opslane] Suggestion:`. Test in `pr.test.ts`.

**Step 4: Run the full worker suite**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
Expected: PASS — new tests green, zero regressions in the existing error-path tests.

**Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): friction investigate path — guards skipped, insight/awaiting_approval routing, auto-fix hard gate (#55)"
```

---

### Task 9: `session_analysis` job handler (no producers)

**Files:**
- Modify: `packages/worker/src/index.ts` (`processJobInner` :108-143)
- Modify: `packages/worker/src/db.ts` (`claimJob` :36, `requeueStaleJobs` :153)
- Test: extend `packages/worker/src/__tests__/index.test.ts`, `db-queries.test.ts`

**Step 1: Write failing tests**

```ts
// 1. A claimed job with jobType 'session_analysis' and sessionId set is dispatched
//    to processSessionAnalysisJob BEFORE the errorGroupId-required check
//    (index.ts:113 throws today — the new branch must come first).
// 2. Handler flow: setSessionAnalysisStatus('analyzing') → getScrubbedChunksForSession
//    → readChunksBounded (Task 8 — the ONLY chunk-read path) → analyzeSession →
//    writeFrictionSignals → status 'analyzed' with RULE_VERSION. It NEVER creates
//    incidents or jobs (assert no INSERT into error_groups / error_group_jobs).
// 3. Analyzer throw → status 'analysis_failed', job rethrows (poller failJob handles retry).
// 4. ChunkReadError (corrupt/oversized/uncommitted chunk) → status 'analysis_failed'
//    + rethrow for retry/dead-letter. The session is NEVER marked 'analyzed' past
//    a corrupt chunk — no silent skips.
// 5. truncated=true (cumulative ~20MB budget) → analyze the bounded prefix, mark
//    'analyzed', and log the truncation with byte counts (honest partial — this IS
//    the design's session size cap, not an error).
// 6. Session with zero scrubbed chunks → 'analyzed' with zero signals (fail-closed
//    is not an error; late scrub triggers re-analysis in Batch 4).
// 7. requeueStaleJobs: a dead-lettered session_analysis job marks its session
//    'analysis_failed' (#25 coverage), mirroring the fix-job reconciliation at db.ts:188.
// 8. claimJob ORDER BY demotes session_analysis below every other type.
```

**Step 2: Run to verify failure** — `pnpm --filter @opslane/worker test -- index db-queries` → FAIL.

**Step 3: Implement**

- `claimJob` (db.ts:59): `ORDER BY CASE WHEN job_type = 'error_fix' THEN 0 WHEN job_type = 'session_analysis' THEN 2 ELSE 1 END, created_at ASC` — fix/investigate always beat session analysis (partial #28 mitigation; full fair scheduling stays in #28). Add `session_id` to the RETURNING and `sessionId`/`triggeredBy` to `ClaimedJob`.
- `index.ts`, before the `!job.errorGroupId` throw (:113):

```ts
if (job.jobType === 'session_analysis') {
  if (!job.sessionId) throw new Error(`Job ${job.id} missing session_id`);
  await processSessionAnalysisJob(job as ClaimedJob & { sessionId: string }, signal);
  return;
}
```

- `processSessionAnalysisJob`: load session (`getSessionForAnalysis`), mark `analyzing`, fetch scrubbed chunk rows, `readChunksBounded` (Task 8), `analyzeSession`, `writeFrictionSignals`, mark `analyzed` with `RULE_VERSION` (logging `truncated`/byte counts when the budget bit). Any throw — including `ChunkReadError` — lands in the catch: mark `analysis_failed` + rethrow so the poller's failJob retry/dead-letter path owns it. **No silent chunk skips; nothing in this function touches error_groups.**
- `requeueStaleJobs` (db.ts:191): add to the reconciliation loop — dead-lettered `session_analysis` with a `session_id` → `UPDATE sessions SET status='analysis_failed' WHERE id=... AND project_id=...` (add `session_id` to that query's RETURNING too).

**Step 4: Run tests** — `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` → PASS.

**Step 5: Verify the no-producer invariant**

Run: `grep -rn "session_analysis" packages/ingestion packages/worker/src --include='*.go' --include='*.ts' | grep -iv test | grep -i "insert\|enqueue\|values"`
Expected: **no output** — nothing inserts a `session_analysis` job. (Enqueue-on-session-close ships in Batch 4.)

**Step 6: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): session_analysis job handler — analyze, persist, never enqueue incidents (#55)"
```

---

### Task 10: Benchmark harness — prove O(seconds) at p95

**Files:**
- Create: `packages/worker/scripts/bench-analyzer.ts`
- Modify: `packages/worker/package.json` (add script `"bench:analyzer": "tsx scripts/bench-analyzer.ts"` — check whether `tsx` is already a devDependency; if not use the package's existing TS-run mechanism, e.g. build then `node dist/`)

**Step 1: Write the harness**

Synthesize a p95-shaped session in memory — no DB, no MinIO; the analyzer is pure and the issue's target is analyzer speed:
- 40 chunks (20-min session at 30s cadence), each ~500KB decompressed JSON of realistic rrweb noise (mutations, scroll, mousemove) → ~20MB total (the design's size cap), seeded with ~200 telemetry events including 3 known signal patterns.
- Run `analyzeSession` 10 times; report min/p50/p95 wall time and assert the seeded signals are found (a fast-but-wrong analyzer must fail the bench).
- Exit non-zero if p95 > 5,000ms. Print a one-line result: `analyzer bench: p50=…ms p95=…ms over 20.1MB/40 chunks — PASS`.

**Step 2: Run it**

Run: `pnpm --filter @opslane/worker bench:analyzer`
Expected: PASS with p95 well under 5s (pure array scans over ~20MB of parsed JSON; if it isn't, fix the analyzer — likely accidental O(n²) in click/mutation matching; pre-sort timestamps and binary-search windows).

**Step 3: Record the number** — paste the bench output into the PR description and issue #55. This is half the batch gate.

**Step 4: Commit**

```bash
git add packages/worker/scripts/bench-analyzer.ts packages/worker/package.json
git commit -m "perf(worker): friction analyzer benchmark — p95 session in O(seconds) (#55)"
```

---

### Task 11: Drop the dead friction tables (prod-gated)

**Files:**
- Modify: `packages/ingestion/db/migrations/001_baseline.sql` (remove lines 374-460: `friction_groups`, `friction_events`, `friction_group_affected_users` + their indexes)
- Modify: `packages/ingestion/db/migrations/003_friction.sql` (append guarded drops)

**Step 1: Verify emptiness in every real deployment** (design: "verify in prod before dropping"). Run against prod/staging DBs:

```sql
SELECT (SELECT count(*) FROM friction_groups) AS g,
       (SELECT count(*) FROM friction_events) AS e,
       (SELECT count(*) FROM friction_group_affected_users) AS u;
```

Expected: `0,0,0`. **If you cannot check prod, STOP and skip this task** — leave the tables and note it in the PR; dropping is irreversible (v4-20).

**Step 2: Implement** — append to `003_friction.sql`. The manual preflight is not the safety mechanism — the migration itself must refuse to destroy data, because a missed or future deployment never got the preflight:

```sql
-- Dead schema removal (design line 128). These tables shipped in the baseline
-- but never had a single reader or writer (verified repo-wide + prod row counts
-- of 0 on YYYY-MM-DD). friction_signals supersedes them.
-- EXECUTABLE GUARD: aborts the migration (ON_ERROR_STOP=1) on ANY database
-- where a table is unexpectedly non-empty, instead of dropping rows.
DO $$
DECLARE
  t TEXT;
  n BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['friction_group_affected_users','friction_events','friction_groups'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'refusing to drop %: contains % rows (expected 0 — investigate before migrating)', t, n;
      END IF;
      EXECUTE format('DROP TABLE %I', t);
    END IF;
  END LOOP;
END $$;
```

and delete their `CREATE` blocks from `001_baseline.sql` so fresh databases never create them (leaving them in 001 would make every boot create-then-drop). Re-runs are clean: `to_regclass` short-circuits once the tables are gone.

**Step 3: Re-run the idempotency check** (header command, fresh disposable DB, two passes). Expected: clean both passes; `\dt friction*` shows only `friction_signals`.

**Step 4: Commit**

```bash
git add packages/ingestion/db/migrations
git commit -m "chore(schema): drop never-populated legacy friction tables (#55)"
```

---

### Task 12: The batch gate — live smoke + full verification + docs

**Files:**
- Modify: `docs/plans/2026-07-13-unified-incidents-replay-friction-design.md` (mark the accounts decision resolved)

**Step 1: Full repository gate** (root AGENTS.md order — type check/tests/build at each layer):

```bash
pnpm install --frozen-lockfile && pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Expected: all green.

**Step 2: Live smoke — hand-created friction incident** (the issue's gate: flows to `insight`/`awaiting_approval` **without auto-termination**). Per root AGENTS.md: apply migrations, `scripts/seed-e2e.sql`, rebuild ingestion + worker, then:

```sql
-- psql to the local opslane DB (seeded project id from seed-e2e.sql):
INSERT INTO error_groups (project_id, fingerprint, title, kind, signal_type, element_selector, page_url_normalized, status)
VALUES ('<seed-project-id>', 'friction-smoke-1', 'Rage click on [data-testid="save"]',
        'friction', 'rage_click', '[data-testid="save"]', 'https://app.example.com/checkout/:id', 'queued')
RETURNING id;
INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
VALUES ('<group-id>', '<seed-project-id>', 'investigate', 'auto');
```

Watch the worker logs, then verify the terminal state:

```sql
SELECT status, kind, root_cause, reason_code FROM error_groups WHERE id = '<group-id>';
```

Expected: `status IN ('insight','awaiting_approval')`, `reason_code IS NULL` (specifically NOT `needs_human` / `unfixable_no_app_frames`), and `SELECT count(*) FROM error_group_jobs WHERE error_group_id='<group-id>' AND job_type='fix'` returns **0** (no auto-fix).

Also confirm visibility rules live: `curl` the incidents list — the friction incident appears with `"kind":"friction"`; flip its status to `candidate` in SQL and confirm it vanishes from the list.

**Step 3: TriggerFix smoke** — with the group in `awaiting_approval`, `POST /api/v1/projects/{p}/incidents/{id}/fix` → 200 + job with `triggered_by='human'`; set status to `insight` and repeat → 409.

**Step 4: Analyzer gate** — `pnpm --filter @opslane/worker test -- friction` (fixture correctness) + `pnpm --filter @opslane/worker bench:analyzer` (speed). Paste both outputs into issue #55.

**Step 5: Docs** — in the design doc, change the "Accounts entity (v4-18)" open question to **Decided (Batch 3): derived string, no table** with one line of rationale; note the Batch 3 gate evidence on issue #55.

**Step 6: Final commit + PR**

```bash
git add docs/plans/2026-07-13-unified-incidents-replay-friction-design.md
git commit -m "docs: record Batch 3 accounts decision; gate evidence (#55)"
# PR against main from this branch; reference #55; include bench + smoke outputs.
```

---

## Explicitly OUT of scope (do not build, even if tempting)

- Enqueueing `session_analysis` on session close; adjudication (LLM/`candidate` writes); fold/aggregate; environment-scoped thresholds; impact write paths — **Batch 4**.
- Dashboard kind badges, insight cards, Generate-fix button, autonomy settings UI, webhook → `pr_outcomes` writes — **Batches 4–5**.
- Screenshot rendering / headless rrweb — **Batch 6**.
- Full fair scheduling / per-type concurrency caps — **#28**.
- An accounts table — decided against (this plan, Decision 1).
