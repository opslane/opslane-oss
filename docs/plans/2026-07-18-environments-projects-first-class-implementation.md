# Environments & Projects First-Class Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Design authority: `docs/plans/2026-07-18-environments-projects-first-class-design.md` (v4, codex-reviewed ×3). If this plan and the design doc disagree, the design doc wins.

**Goal:** Make environments and projects usable end-to-end — SDK → ingest → grouping/reads → dashboard — with environment-scoped incident/session filtering, a real project switcher, and an opt-in Sentry-style `environment` payload field, without breaking the append-only wire contract.

**Architecture:** Error-group identity stays `(project_id, fingerprint)`; a new `error_group_environments` rollup table (maintained in the ingest tx + friction fold, backfilled by locked recompute-from-source) provides env-scoped filtering and aggregates. Payload env override is per-project opt-in, resolved by name within the key's project, with existing-session-wins semantics scoped `(session_id, project_id)`.

**Tech Stack:** Go 1.24 + chi + pgx (ingestion), Node 22 TS (worker, SDK, CLI), Vue 3 + Vite (dashboard), Postgres, Vitest, frozen wire fixtures.

**Verification baseline (run before starting):** `cd packages/ingestion && go build ./... && go test ./...` and `pnpm -r build && pnpm test` must be green on the branch tip.

**Conventions for every task:** TDD (write failing test → see it fail → implement → see it pass → commit). Small commits, one task each. Go DB tests live in `packages/ingestion/db/queries_test.go` siblings and run against the disposable test Postgres (`testhelper_test.go` harness — never the shared 5434 DB with retained data). Dashboard logic goes in pure `.ts` helpers with colocated `*.test.ts` (pattern: `components/org-switcher.ts` + `org-switcher.test.ts`).

---

## Phase 1 — Read-path foundation (rollup, filters, indexes)

### Task 1: Schema migration

**Files:**
- Create: `packages/ingestion/db/migrations/016_environments_first_class.sql` (next free number — verify with `ls packages/ingestion/db/migrations/`)

**Step 1: Write the migration** (idempotent — compose reruns migrations every boot, `run-migrations.sh`):

```sql
-- 016_environments_first_class.sql
-- Per-environment rollup for error-kind groups. Friction-kind groups never
-- get rows here; readers must gate on error_groups.kind.
CREATE TABLE IF NOT EXISTS error_group_environments (
  error_group_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  environment_id UUID NOT NULL REFERENCES environments(id),
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen  TIMESTAMPTZ NOT NULL,
  occurrence_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (error_group_id, environment_id)
);

-- Access path for "sparse environment ordered by env-scoped recency".
CREATE INDEX IF NOT EXISTS idx_ege_env_last_seen
  ON error_group_environments (environment_id, last_seen DESC, error_group_id);

-- Unfiltered incident list sorts on this; was missing.
CREATE INDEX IF NOT EXISTS idx_error_groups_project_last_seen
  ON error_groups (project_id, last_seen DESC);

-- Keyset path for env-filtered sessions list.
CREATE INDEX IF NOT EXISTS idx_sessions_project_env_started
  ON sessions (project_id, environment_id, started_at DESC, id DESC);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS allow_payload_environment BOOLEAN NOT NULL DEFAULT false;

-- Forward-only name hygiene; legacy names untouched until VALIDATEd separately.
DO $$ BEGIN
  ALTER TABLE environments ADD CONSTRAINT chk_environment_name_format
    CHECK (name ~ '^[A-Za-z0-9._-]{1,64}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Durable backfill state: single row.
CREATE TABLE IF NOT EXISTS rollup_backfill_state (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO rollup_backfill_state (status)
  SELECT 'pending' WHERE NOT EXISTS (SELECT 1 FROM rollup_backfill_state);

-- Per-batch ledger for the recompute backfill.
CREATE TABLE IF NOT EXISTS rollup_backfill_ledger (
  batch_start UUID NOT NULL,
  batch_end UUID NOT NULL,
  pass INT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_start, pass)
);
```

Also add the idempotency column used by Phase 3 (schema ships once):

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS idempotency_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_idem
  ON projects (org_id, idempotency_token) WHERE idempotency_token IS NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS provisioning_key_id UUID;
```

**Step 2:** Apply twice against a disposable DB; second run must no-op. Run the migration test suite: `cd packages/ingestion && go test ./db -run Migration -v` (see `db/migrations_test.go` for the harness). Expected: PASS both applications.

**Step 3:** Commit: `git commit -m "feat(ingestion): schema for env rollup, indexes, payload-env flag, backfill state"`

### Task 2: Rollup upsert in the error-ingest transaction

**Files:**
- Modify: `packages/ingestion/db/queries.go` — `InsertErrorEventAndGroup` (~:373-450; the group upsert is ~:426-438, event insert ~:398)
- Test: `packages/ingestion/db/queries_test.go`

**Step 1: Failing test** — insert two events for the same fingerprint in env A, one in env B; assert `error_group_environments` has (groupID, envA, count=2) and (groupID, envB, count=1) with correct first/last_seen; assert friction-kind groups (insert one via the friction fixture pattern in `db/friction_test.go`) get **no** row.

**Step 2:** Run `go test ./db -run TestRollupUpsert -v` → FAIL (table empty).

**Step 3: Implement** — inside the existing tx in `InsertErrorEventAndGroup`, after the event insert (the tx already holds the `error_groups` row lock):

```sql
INSERT INTO error_group_environments (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
VALUES ($1, $2, $3, $3, 1)
ON CONFLICT (error_group_id, environment_id) DO UPDATE
  SET last_seen = GREATEST(error_group_environments.last_seen, EXCLUDED.last_seen),
      occurrence_count = error_group_environments.occurrence_count + 1;
```

**Step 4:** Test passes. **Step 5:** Commit `feat(ingestion): maintain per-environment rollup in ingest tx`.

### Task 3: Friction-fold writer + retraction rebuild (worker)

**Files:**
- Modify: `packages/worker/src/friction/promotion-db.ts` — fold path (~:380) and retraction/supersession path (~:660)
- Test: colocated `__tests__` per worker patterns

**Step 1: Failing tests** — (a) folding an active friction signal into an error-kind group upserts the rollup with the signal's `environment_id`; (b) retraction triggers a rebuild: rollup rows for that group recomputed from `error_events` + remaining active folded `friction_signals` (write the rebuild as one SQL statement: `DELETE` group's rows + `INSERT ... SELECT` aggregate union, in one tx).

**Step 2-4:** Fail → implement → pass. Reuse the exact aggregate-union SQL from Task 4 (extract to a shared `.sql` const if both sides are TS/Go — they aren't; duplicate with a comment cross-referencing the Go version, and a test on each side asserting identical output for a seeded fixture).

**Step 5:** Commit `feat(worker): rollup writes on friction fold and rebuild on retraction`.

### Task 4: Guarded recompute backfill task

**Files:**
- Create: `packages/ingestion/db/rollup_backfill.go` + `rollup_backfill_test.go`
- Modify: ingestion startup (where background tasks launch — follow the pattern used by existing startup work in `cmd/` / `main.go`)

**Step 1: Failing tests:**
- Recompute exactness: seed events (2 envs) + an active folded friction signal; run backfill; rollup matches hand-computed aggregates. Aggregate source (design-doc mandated):

```sql
SELECT error_group_id, environment_id, MIN(ts) AS first_seen, MAX(ts) AS last_seen, COUNT(*) AS cnt
FROM (
  SELECT error_group_id, environment_id, created_at AS ts FROM error_events WHERE error_group_id = ANY($1)
  UNION ALL
  SELECT fs.folded_into_error_group_id, fs.environment_id, fs.occurred_at
    FROM friction_signals fs
    WHERE fs.folded_into_error_group_id = ANY($1) AND fs.status = 'active'  -- match real column/status names in 004_friction.sql before coding
) src GROUP BY 1, 2;
```

- Batch runs `SELECT id FROM error_groups WHERE kind='error' AND id = ANY($batch) FOR UPDATE` first (blocks concurrent ingest for exactness), then upserts **absolute** values.
- Restart replay: run backfill twice → identical rollup (recompute is idempotent).
- Single runner: second concurrent invocation exits immediately (pg advisory lock `pg_try_advisory_lock`).
- Ledger: each batch recorded; pass 2 (reconciliation sweep) reruns all batches; then state → `complete`. Fresh DB (zero groups) → `complete` immediately.

**Step 2-4:** Fail → implement → pass. `go test ./db -run TestRollupBackfill -v`.

**Step 5:** Wire into ingestion startup as a goroutine (state check is one cheap SELECT on later boots). Commit `feat(ingestion): guarded recompute backfill for env rollup`.

### Task 5: Kind-gated environment filter + scoped aggregates in ListErrorGroups

**Files:**
- Modify: `packages/ingestion/db/queries.go` — `ErrorGroupFilters` (:598-603), `ListErrorGroups` (:606-675)
- Test: `packages/ingestion/db/queries_test.go`

**Step 1: Failing tests:**
- `EnvironmentID` filter returns: error-kind groups with rollup rows in that env; friction-kind groups with `eg.environment_id` = env; excludes error-kind groups whose only presence is another env; excludes friction groups from other envs (cross-arm exclusion both ways).
- When filtered, returned `first_seen/last_seen/occurrence_count` are the **rollup's** values for error-kind (friction rows keep their own columns), and ordering is by `ege.last_seen DESC`.
- Unfiltered behavior unchanged (regression assertions on an existing test's expectations).

**Step 2: FAIL.** **Step 3: Implement:**

```go
type ErrorGroupFilters struct {
    AccountID     string
    EndUserID     string
    Status        string
    EnvironmentID string // uuid, optional
}
```

Filter clause appended to the `wheres` slice (kind gate uses the real `error_groups.kind` column, `004_friction.sql:14`):

```sql
AND (
  (eg.kind = 'friction' AND eg.environment_id = $N)
  OR (eg.kind = 'error' AND EXISTS (
        SELECT 1 FROM error_group_environments ege
        WHERE ege.error_group_id = eg.id AND ege.environment_id = $N))
)
```

When `EnvironmentID` is set, LEFT JOIN the rollup on `(eg.id, $N)` and select `COALESCE(ege.first_seen, eg.first_seen)` etc. for error-kind rows; `ORDER BY COALESCE(ege.last_seen, eg.last_seen) DESC`.

**Step 4: PASS.** **Step 5:** Commit `feat(ingestion): environment filter with env-scoped aggregates`.

### Task 6: Combined account/end-user × environment correlation

**Files:** same as Task 5.

**Step 1: Failing test** — the round-1 false-match case: account A affected only in staging; group also has unrelated production events. Filter `account=A AND env=production` must NOT return the group. Kind-specific correlation per design D1: error-kind via `error_events` rows carrying both linkages + active folded signals; friction-kind via `eg.environment_id` + `error_group_affected_users` (`001_baseline.sql:273`). **Read the real `ListAffectedUsers` join (queries.go:709) first** to get the actual event↔user linkage columns; adjust SQL to reality, not to this plan.

**Step 2-4:** Fail → implement (when both filters set, replace the independent predicates with the correlated EXISTS) → pass.

**Step 5:** Commit `feat(ingestion): correlate account and environment filters at event level`.

### Task 7: ListIncidents param parsing + environment access validation

**Files:**
- Modify: `packages/ingestion/handler/read_api.go` — `ListIncidents` (:185-217, param parsing :194-203)
- Test: `packages/ingestion/handler/read_api_test.go`

**Steps:** Failing handler tests: bad UUID → 400; env from another project → 404 (reuse the `VerifyEnvironmentAccess` pattern, `queries.go:2572-2589`, but check env belongs to the **path project**, not just org); valid → filter threaded into `ErrorGroupFilters`. Implement, pass, commit `feat(ingestion): environment_id param on incidents list`.

### Task 8: Sessions environment filter

**Files:**
- Modify: `packages/ingestion/db/sessions_read.go` — `SessionFilters` (:30), `ListSessions` (:68, WHERE :84)
- Modify: `packages/ingestion/handler/session_read.go` — `ListSessionsEndpoint` (:112) parsing + validation (NOT read_api.go — round-2 correction)
- Test: `packages/ingestion/db/sessions_read_test.go`, handler test sibling

**Steps:** Failing tests (filter arm, keyset pagination still correct under filter — cursor semantics preserved), implement (`sessions.environment_id` is NOT NULL so no NULL arm), pass, commit `feat(ingestion): environment filter on sessions list`.

### Task 9: GetIncident environments array

**Files:**
- Modify: `packages/ingestion/db/queries.go` — `GetErrorGroup` (:799) or a new `ListGroupEnvironments` query; `packages/ingestion/handler/read_api.go` — incident JSON (:26, :67-107)
- Modify: `shared/src/types.ts` — `Incident.environments?: {id, name, occurrence_count, last_seen}[]`
- Test: `read_api_test.go` (JSON-shape pattern of `TestIncidentJSON_AdjudicationFields` :89-107), `queries_test.go`

**Steps:** Failing tests: error-kind → rows from rollup joined to `environments` for names; friction-kind → single entry from `eg.environment_id`. Implement, pass, commit `feat(ingestion): per-environment breakdown on incident detail`.

**Phase 1 gate:** `cd packages/ingestion && go build ./... && go test ./...` all green. `EXPLAIN (ANALYZE, BUFFERS)` on the filtered list against a seeded ≥100k-event skewed dataset (write a throwaway seed script in scratchpad; confirm `idx_ege_env_last_seen` is used). Concurrency benchmark: hot single fingerprint×env, compare ingest p95 with/without rollup upsert (Go benchmark or a k6/psql loop; budget = noise).

---

## Phase 2 — Dashboard filtering

### Task 10: API client + types threading

**Files:**
- Modify: `packages/dashboard/src/api.ts` — `listIncidents` (:477-489), `listSessions` (:504-520), `getIncident`
- Modify: `packages/dashboard/src/types/api.ts` — `IncidentFilters`, `SessionFilters` (:184), `Incident` (add `environments?`), `SessionSummary` if needed
- Test: extend `packages/dashboard/src/api-project-settings.test.ts` pattern with a URL-assertion test for the new param

**Steps:** Failing test asserting `environment_id` lands in `URLSearchParams` only when set → implement → pass → commit `feat(dashboard): thread environment_id through API client`.

### Task 11: `useEnvironmentFilter` composable

**Files:**
- Create: `packages/dashboard/src/composables/useEnvironmentFilter.ts` + `useEnvironmentFilter.test.ts`

**Steps:** Pure logic (state from URL query `environment_id` > localStorage `opslane_environment_id`; setter syncs both; `clear()` for project switches; options loader via `listEnvironments(projectId)`). Test the pure state/sync logic without mounting Vue (follow `org-switcher.ts` extraction pattern). Commit `feat(dashboard): shared environment filter composable`.

### Task 12: FilterBar environment select (incidents list)

**Files:**
- Modify: `packages/dashboard/src/components/FilterBar.vue` (state init :18-19, URL sync :37-52, emit :30-35)
- Modify: `packages/dashboard/src/views/ActivityFeed.vue` (filter consumption :92-95, :116-120)

**Steps:** Third select ("All environments" default) fed by the composable; emits `environment_id` in `filter-change`; ActivityFeed passes it to `listIncidents`. Label the affected-users column/tooltip "users across all environments" when filter active (design D1). Manual verify via dashboard dev server + seeded data. Commit.

### Task 13: SessionsList filter + cursor reset

**Files:**
- Modify: `packages/dashboard/src/views/SessionsList.vue` (own filter form ~:26, pagination snapshot ~:107 — it does NOT use FilterBar)
- Test: extend `components/session-list-query.test.ts` for the query param + cursor-reset-on-change logic (extract to pure helper if not already)

**Steps:** Failing test: changing environment resets the keyset cursor. Implement select in the existing form, wire composable, pass, commit.

### Task 14: Incident detail environment chips

**Files:**
- Modify: `packages/dashboard/src/views/IncidentDetail.vue`

**Steps:** Render `incident.environments` as chips with count + relative last_seen; friction shows its single env. Manual verify both kinds. Commit.

### Task 15: Backfill-readiness gating

**Files:**
- Modify: `packages/ingestion/handler/read_api.go` — `ListEnvironmentsEndpoint` (:534) response gains `rollup_ready: bool` (from `rollup_backfill_state`)
- Modify: composable/FilterBar — hide env select until `rollup_ready`

**Steps:** Handler test for the flag; UI hides filter when false. Commit. **Phase 2 gate:** `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`; manual pass with 2 envs.

---

## Phase 3 — Projects first-class

### Task 16: `RequireRoleIfCloud` middleware on all provisioning routes

**Files:**
- Modify: `packages/ingestion/handler/auth.go` (existing `RequireRole` returns 404 outside cloud, :248 — do NOT reuse as-is)
- Modify: `packages/ingestion/handler/routes.go` — `POST /projects` (:115), `PATCH /projects/{id}` (:116), env create (:120), api-key create (:123), **`POST /onboarding/setup`** (:110-111)
- Test: `auth_middleware_test.go` pattern

**Steps:** Failing tests: cloud-mode member → 403 on each route; cloud-mode admin → pass-through; OSS (no memberships) → pass-through. Implement `RequireRoleIfCloud(minRole string)`. Commit `feat(ingestion): admin gating on provisioning routes in cloud mode`.

### Task 17: Composite, idempotent CreateProject

**Files:**
- Modify: `packages/ingestion/handler/read_api.go` — `CreateProjectEndpoint` (:416-457)
- Modify: `packages/ingestion/db/queries.go` / reuse `onboarding.go:19-101` tx shape (project + "production" env + key in one tx)
- Test: handler + db tests

**Steps:** Failing tests: (a) response contains `{project, environment, api_key}` with raw key; (b) same `idempotency_token` twice → same project id, prior provisioning key revoked, fresh key returned (`provisioning_key_id` column tracks it); (c) concurrent same-token (two goroutines) → exactly one project (unique index from Task 1). Implement, pass, commit `feat(ingestion): composite idempotent project provisioning`.

### Task 18: New Project UI + key acknowledge

**Files:**
- Modify: `packages/dashboard/src/api.ts` — `createProject` (:389-391) new request/response shape (+ idempotency token via `crypto.randomUUID()` per attempt-session)
- Modify: `packages/dashboard/src/views/Settings.vue` — New Project form; key shown once with explicit copy/acknowledge before dismiss

**Steps:** Pure-helper test for the acknowledge flow state; manual verify. Commit.

### Task 19: ProjectSwitcher + switch semantics

**Files:**
- Create: `packages/dashboard/src/components/ProjectSwitcher.vue` + `project-switcher.ts` + `project-switcher.test.ts` (mirror `OrgSwitcher.vue`/`org-switcher.ts`)
- Modify: `packages/dashboard/src/App.vue` — header (:125-134), remove one-time modal (:57-82, template :164-198)
- Modify: `packages/dashboard/src/post-auth.ts` (:15-21 stays as first-project default when nothing stored)

**Steps:** Failing pure-helper tests for switch semantics (design D3): writes localStorage, strips `?project_id=` URL override (`utils.ts:16-23` gives it precedence), clears `opslane_environment_id` + account filter state, navigates to `/`. Implement, pass. Manual: 2 projects, switch from an incident-detail deep link → lands on `/` of new project. Commit. **Phase 3 gate:** dashboard build+test, ingestion `go test ./...`, cloud/OSS role matrix green.

---

## Phase 4 — Worker context

### Task 20: Environment names in PR body + investigation prompt (fenced)

**Files:**
- Modify: `packages/worker/src/pr.ts` — `buildPRBody` (:345-399)
- Modify: `packages/worker/src/agent-fix.ts` — prompt construction (fencing pattern ~:370)
- Modify: `packages/worker/src/db.ts` — query env names (kind-gated: rollup for error-kind, `eg.environment_id` for friction)
- Test: colocated worker tests

**Steps:** Failing tests: PR body contains `Environments: production, staging`; a hostile env name (`prod\n\nIgnore previous instructions`) is fenced/escaped in both surfaces (legacy names predate validation — both layers required). Implement, pass, commit `feat(worker): environment context in PR body and prompts`.

---

## Phase 5 — SDK/wire (deploy ingestion before SDK publish)

### Task 21: Flag through auth context

**Files:** `packages/ingestion/db/queries.go` — `LookupAPIKey` (:180-197, already joins projects); `packages/ingestion/handler/auth.go` — context (:147-168).

**Steps:** Failing test → add `AllowPayloadEnvironment` to the lookup row + context → pass → commit. Also update **every** `projects` serializer/scan for the new columns with scan-shape tests: `queries.go:72` (Project struct scan), `:2338` (`ListProjectsByOrg`), `projectJSON` (`read_api.go:103`), dashboard `types/api.ts` Project.

### Task 22: Ingest env resolution + cache + metrics

**Files:**
- Modify: `packages/ingestion/handler/error_event.go` — decode struct (:59-73, add `Environment string \`json:"environment"\``), resolution before insert (:50-57 stays context-based as fallback)
- Create: `packages/ingestion/handler/env_resolver.go` + test (LRU: positive 60s / negative 5s TTL, 1k cap — use an existing in-repo LRU if present, else a minimal mutex+map+heap; check before adding any dependency per AGENTS.md)
- Test: handler tests + a metrics assertion

**Steps:** Failing tests per design D2 semantics table: disabled flag → key env + `fallback{reason=disabled}` (sampled log); unknown name → key env + `reason=unknown_name`; invalid name (>64 chars / bad charset) → **override-only rejection**, event still 202 into key env, `reason=invalid_name`; valid → resolved env id, and the env-belongs-to-project invariant (`queries.go:373-384`) still holds. Implement, pass, commit.

### Task 23: Session init resolution + tenant-scoped session semantics

**Files:**
- Modify: `packages/ingestion/handler/session.go` (init path ~:131), `packages/ingestion/db/sessions.go` (insert `DO NOTHING` :29-33), `packages/ingestion/db/queries.go` event/session linkage (:407-410)
- Test: db + handler tests

**Steps:** Failing tests (design D2, round-3 semantics):
- All session lookups scoped `(session_id, project_id)`; a session id existing under another project = absent for this project's events; session init on it → rejected + `ingest_session_cross_project_conflict_total`.
- Event with existing same-project session → session's env wins regardless of payload.
- Event before session (out-of-order) → own resolution + `ingest_env_session_divergence_total` when the later session differs.
- Same-project session-init env conflict → first registration wins + divergence metric (no silent `DO NOTHING`).

Implement, pass, commit `feat(ingestion): environment on session init with tenant-scoped session semantics`.

### Task 24: Replay-init session ownership check

**Files:** `packages/ingestion/handler/replay.go` (:86 accepts any nonempty session id today) + test.

**Steps:** Failing test: replay init with a session belonging to another project → 404/400. Implement, pass, commit.

### Task 25: Admin-gated Settings toggle

**Files:** `packages/ingestion/handler/read_api.go` — PATCH project handler (:459): changing `allow_payload_environment` requires admin in cloud mode (server-side, on top of Task 16 route gate); `packages/dashboard/src/views/Settings.vue` — toggle with warning copy.

**Steps:** Handler test (member PATCH flips flag → 403 cloud / OK OSS), UI toggle, commit.

### Task 26: SDK `environment` option + wire fixtures + version

**Files:**
- Modify: `shared/src/types.ts` — `ErrorEventPayload.environment?: string` (:38-70, append after `session_id`)
- Modify: `packages/sdk/src/config.ts` — `SdkInitOptions.environment?` + `SdkConfig` + `loadConfig` (:55-89, default like `release` :78)
- Modify: payload build (`core.ts`/`transport.ts` where `release` is attached) + session-init sender
- Modify: `packages/sdk/package.json` version → `1.1.0` (wire-shape test loads fixtures by version, `wire-shape.test.ts:15` — same commit as fixtures)
- Create: `test-fixtures/wire/events/v1.1.0-minimal.json`, `v1.1.0-full.json` (full includes `"environment": "staging"`); append to fixtures README per its append-only rules
- Tests: `packages/sdk/src/__tests__/wire-shape.test.ts` (± environment); Go `wire_compat_test.go` replays new fixtures automatically — confirm 202 + round-trip

**Steps:** TDD via the wire-shape test; never edit existing frozen fixtures (CI `wire-fixtures.yml` blocks it). Commit `feat(sdk): environment init option (wire v1.1.0)`.

### Task 27: CLI codemod compile test

**Files:** `cli/` test that compiles a codemod-generated `init` snippet against real `@opslane/sdk` types (closes the pre-existing silent-mismatch: codemods already emit `environment: 'production'`, `react-vite.ts:36-39`).

**Steps:** Test would have failed before Task 26; now passes. Commit.

### Task 28: Docs

**Files:** `docs/contracts/events.md` (new optional field + fixture pair note), `docs/reference/sdk-options.md` (**drift-checked** by `scripts/check-docs-drift.mjs` — will fail CI if missed), `docs/reference/http-routes.md`, `docs/guides/replay-privacy.md` (env inference note), ops note for large-install `CREATE INDEX CONCURRENTLY`/backfill.

**Steps:** Run `node scripts/check-docs-drift.mjs` → PASS. Commit.

### Task 29: E2E

**Files:**
- Modify: `test-e2e/helpers.ts` — add `listSessions` helper (only `listIncidents` exists, :224); extend `listIncidents` with env param; `seedEnvironment` (:603) already exists
- Create: `test-e2e/environments.test.ts`

**Scenarios (from design Verification):** same fingerprint via two env keys → one group, per-env counts under each filter; override toggle on → named env; off/unknown/invalid → fallback + correct metric reason; event-before-session divergence + existing-session-wins; cross-project session id rejected; project switch clears env filter (dashboard-level if covered by e2e harness, else Vitest); New Project returns copyable key; non-admin blocked in cloud mode.

**Steps:** Red → green against compose stack. Commit.

---

## Final verification (before claiming done)

1. `pnpm install --frozen-lockfile && pnpm -r build && pnpm test`
2. `cd packages/ingestion && go build ./... && go test ./...`
3. `docker compose config --quiet`; rebuild ingestion + worker images
4. Migrations on clean disposable DB, then re-apply (no-op) on seeded DB
5. Live smoke per AGENTS.md: seed → event to `:8082/api/v1/events` → job reaches terminal state; manual dashboard pass with 2 projects × 2 environments
6. `EXPLAIN (ANALYZE, BUFFERS)` filtered list uses `idx_ege_env_last_seen`; ingest hot-path benchmark within noise
