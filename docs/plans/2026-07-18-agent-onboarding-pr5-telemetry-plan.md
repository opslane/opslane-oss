# Agent Onboarding PR 5 — Funnel Telemetry Implementation Plan

> **Execution:** task-by-task, a commit per task (Claude: `superpowers:executing-plans`; other executors follow the same flow).

> **Status:** Revised after Codex review (1 P0, 10 P1, 4 P2). The P0 (wrong migration number → cohort filter can't exclude legacy rows) and every P1 are folded into the tasks below.

**Goal:** Surface the agent-onboarding funnel (started → auth-clicked → completed → key-claimed → first-event) plus a failure breakdown in the existing admin overview — as an accurate, best-effort operational metric, with no new vendor or route.

**Architecture:** One SQL statement (single scan, one snapshot) added to `AdminOverviewData`, one JSON field on `AdminOverview`, one dashboard section, and a small index migration. The funnel cohort is defined by the **v2 writer markers**, not by time alone, because the telemetry columns are nullable and pre-v2 rows have no defaults.

**Tech Stack:** Go 1.24 + pgx (db), Vue 3 + Tailwind (AdminView), go test / vitest.

**Context you need (verified against the merged code):**
- Design doc v5: PR 5 section + F18/F19. **Corrections from review, superseding the design-doc PR 5 wording:**
  - The funnel columns are in **migration `017_agent_sessions_v2.sql`** (not 016 — 016 is unrelated `016_platform.sql`). They are **nullable, no defaults**.
  - Cohort = **post-v2 sessions**, identified by `poll_token_hash IS NOT NULL AND agent_key_pub IS NOT NULL` (current `CreateAgentSession` always writes both — `queries.go` ~:2728). A time filter alone cannot exclude a recent pre-017 row; the marker filter can. The 30-day window is layered on top for recency.
  - `first_event_received` is **project activation**, not a strict "key→event" stage: it counts completed sessions whose project currently has any `error_events` row. It does **not** require `key_claimed_at` and does not prove ordering, so it can exceed `key_claimed`. Label and document it as activation, not as a strictly-ordered funnel step.
  - `auth_clicked` / `key_claimed` are **best-effort**: both stamps are written after the fact and their write failures are logged-and-swallowed (`agent_setup.go` ~:204, ~:270). Document as best-effort telemetry, not an exact action count.
- `packages/ingestion/db/admin.go` — `AdminOverview` struct + `AdminOverviewData`. **Match its real style:** each single-row section uses scoped `if err := q.pool.QueryRow(...).Scan(...); err != nil { return nil, fmt.Errorf("admin <label>: %w", err) }`; maps are pre-initialized; multi-row sections close rows, check `rows.Err()`, and use distinct query/scan/iterate error wraps. Error prefix is `admin ...`.
- `handler/admin.go` `AdminOverview` serves it; route already `RequireAdmin`-gated (`routes.go`). **No routes.go change.**
- Writers (do not reimplement): `MarkAgentSessionAuthClicked`, `MarkAgentKeyDelivered`, `MarkAgentSessionFailed` in `queries.go`; `agent_provision.go` sets `status='completed'`/`'failed'`. `error_events(project_id)` is indexed (`idx_error_events_project`, `001_baseline.sql:128`) — the correlated `EXISTS` is a short-circuiting indexed probe, **not** quadratic. `error_events.environment_id` is **NOT NULL** (`001_baseline.sql:59`).
- `agent_sessions` has only a partial pending-status index today and is never purged; the admin page auto-refreshes every 60s (`AdminView.vue:79`). → **add a `created_at` index** (Task 1) so the funnel scan is bounded; note purging as future work.
- Test patterns: DB tests that need migration-complete isolation use the **disposable-DB** helper (`migrations_test.go` `disposableDB`), NOT `testPool` baseline/delta — Go runs packages concurrently and other suites write agent_sessions to the shared retained DB. `handler/admin_integration_test.go` uses `authTestRouter` + allowlisted admin JWT. Dashboard: `// @vitest-environment jsdom` + `@vue/test-utils mount`.
- Docs: `scripts/check-docs-drift.mjs` parses only method/path cells (`:94`) — editing a description or adding a response-field table is NOT drift-checked. Do not claim field-level drift detection and do not add `covers:` frontmatter to `docs/reference/**` (deterministic tier — `docs-map.mjs:10`).
- **Gate commands:** run package tests directly (`go test ./db ./handler`, `pnpm --filter @opslane/dashboard test`) and the drift/scope scripts directly (`node scripts/check-docs-drift.mjs`, `node scripts/check-docs-scope.mjs`). Do NOT rely on root `pnpm test` for this work — its `docs:map:test` script walks `.claude/skills/**` and is not the right gate here.

---

## Task 1: Migration — `created_at` index + db funnel struct & query

**Files:** Create `packages/ingestion/db/migrations/018_agent_sessions_created_at_index.sql`; modify `packages/ingestion/db/admin.go`; test `packages/ingestion/db/admin_onboarding_test.go`.

**Step 1: Migration (idempotent, expand-only)**

```sql
-- 018_agent_sessions_created_at_index.sql
-- The admin onboarding funnel scans agent_sessions by created_at every ~60s
-- (admin dashboard auto-refresh). The table has only a partial pending index
-- and is never purged, so give the funnel a usable time index.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_created_at
  ON agent_sessions (created_at);
```

Apply to a disposable DB fresh + re-apply (idempotency): `go test ./db -run TestMigrations`.

**Step 2: Failing test** (`admin_onboarding_test.go`, package `db_test`) — use the **disposable-DB** pattern from `migrations_test.go`, not `testPool` delta:

```go
func TestAdminOverviewOnboardingFunnel(t *testing.T) {
	admin := testPool(t)                 // connection to create the throwaway DB
	pool, _ := disposableDB(t, admin)    // migrated, isolated — no cross-suite noise
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "funnel-org"); mustNil(t, err)
	project, err := q.CreateProject(ctx, org.ID, "funnel-proj", ptrStr("funnel/repo")); mustNil(t, err)
	env, err := q.CreateEnvironment(ctx, project.ID, "production"); mustNil(t, err) // error_events.environment_id is NOT NULL
	// insert one error_event for `project` via env.ID (copy the insert other db tests use)

	// Seed DISTINCT populations (not all +1), each a real v2 session:
	//  A: started only            (markers set, no auth_clicked)
	//  B: auth_clicked, not completed
	//  C: completed, key NOT claimed, project has NO event
	//  D: completed, key claimed,  project HAS an event   -> first_event
	//  E: failed, reason repo_not_granted
	//  F: failed, reason identity_unverified
	//  G: in-window LEGACY row (poll_token_hash NULL)      -> excluded from all counts
	//  H: post-v2 but created 40 days ago                  -> excluded by window
	// (create via q.CreateAgentSession for real markers; mutate state via checked UPDATEs)

	o, err := q.AdminOverviewData(ctx); mustNil(t, err)
	f := o.Onboarding
	// Disposable DB => absolute asserts, no deltas:
	if f.Started != 6 { t.Fatalf("started=%d want 6", f.Started) }       // A-F, not G/H
	if f.AuthClicked != 1 { ... }        // B (+ any that set it)
	if f.Completed != 2 { ... }          // C,D
	if f.KeyClaimed != 1 { ... }         // D
	if f.FirstEventReceived != 1 { ... } // D
	if f.Failed != 2 { ... }             // E,F
	if f.ByFailureReason["repo_not_granted"] != 1 || f.ByFailureReason["identity_unverified"] != 1 { ... }
}
```

Assert **every** fixture mutation's error (CreateOrg/CreateProject/CreateEnvironment/each UPDATE). Explicitly cover: the legacy row G (marker filter excludes it) and the out-of-window row H.

**Step 3: Run** → FAIL (`o.Onboarding` undefined).

**Step 4: Implement.** Add to `admin.go`:

```go
// AdminOnboardingOverview is the agent-onboarding funnel over v2 sessions in
// the last 30 days. Cohort = poll_token_hash/agent_key_pub NOT NULL (the v2
// writer markers) because the telemetry columns are nullable with no defaults,
// so a time filter alone cannot exclude pre-017 rows.
//
// Caveats (see plan): auth_clicked/key_claimed are best-effort stamps (their
// write failures are swallowed); FirstEventReceived is PROJECT ACTIVATION
// (completed session whose project has any event), not a strictly-ordered
// key->event step, so it may exceed KeyClaimed.
type AdminOnboardingOverview struct {
	Started            int64            `json:"started"`
	AuthClicked        int64            `json:"auth_clicked"`
	Completed          int64            `json:"completed"`
	KeyClaimed         int64            `json:"key_claimed"`
	FirstEventReceived int64            `json:"first_event_received"`
	Failed             int64            `json:"failed"`
	ByFailureReason    map[string]int64 `json:"by_failure_reason"`
}
```

Add `Onboarding AdminOnboardingOverview \`json:"onboarding"\`` to `AdminOverview`. Pre-init `ByFailureReason` with the other maps. **One statement, one snapshot** (fixes double-scan + cross-snapshot inconsistency between totals and the failure breakdown) via a CTE returning both the counters and the per-reason rows; scan the counters row, then iterate the reason rows — all from the single query. Sketch:

```go
const cohort = `poll_token_hash IS NOT NULL AND agent_key_pub IS NOT NULL
                AND created_at >= now() - interval '30 days'`
rows, err := q.pool.Query(ctx, `
    WITH funnel AS (SELECT * FROM agent_sessions WHERE `+cohort+`)
    SELECT
      'totals' AS kind, NULL::text AS reason,
      count(*), count(auth_clicked_at),
      count(*) FILTER (WHERE status='completed'),
      count(key_claimed_at),
      count(*) FILTER (WHERE status='completed' AND project_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM error_events e WHERE e.project_id = funnel.project_id)),
      count(*) FILTER (WHERE status='failed')
    FROM funnel
    UNION ALL
    SELECT 'reason', failure_reason, count(*),0,0,0,0,0
    FROM funnel WHERE status='failed' AND failure_reason IS NOT NULL
    GROUP BY failure_reason`)
```

Scan the `totals` row into the counters, accumulate `reason` rows into `ByFailureReason`. Follow `admin.go`'s exact idioms: distinct query/scan/iterate error wraps prefixed `admin onboarding funnel:`, `defer rows.Close()`, check `rows.Err()`.

**Step 5:** `go test ./db -run 'TestAdminOverviewOnboardingFunnel|TestMigrations' -v` → PASS. **Step 6:** Commit: `feat(ingestion): agent-onboarding funnel in admin overview + created_at index`

---

## Task 2: Handler contract test

**Files:** Modify `packages/ingestion/handler/admin_integration_test.go`.

The existing admin test only asserts HTTP 200. Add: decode the `/api/v1/admin/overview` body and assert the `onboarding` object is present with the expected numeric fields (seed one completed+key-claimed session with an event beforehand, mirroring Task 1's fixture, via the test's DB pool). This proves the JSON tag + wiring, which the pure formatter test cannot. Run `go test ./handler -run Admin -v` → PASS. Commit: `test(ingestion): assert onboarding funnel in admin overview response`

---

## Task 3: Dashboard — optional type, funnel formatter + section, mount test

**Files:** Modify `packages/dashboard/src/types/api.ts`, `src/admin-format.ts`, `src/views/AdminView.vue`; tests `src/admin-format.test.ts`, and a mount test.

**Step 1: Type — optional for old-server compat (P2).** Add to `AdminOverview` in `types/api.ts`:

```ts
  onboarding?: {
    started: number; auth_clicked: number; completed: number;
    key_claimed: number; first_event_received: number; failed: number;
    by_failure_reason: Record<string, number>;
  };
```

Optional (`?`), so a pre-PR5 server payload type-checks and the `v-if` guard is honest rather than an untyped workaround.

**Step 2: Failing formatter test** (`admin-format.test.ts`): `onboardingFunnelStages(o)` returns stages in order started → auth_clicked → completed → key_claimed → first_event_received with `pctOfFirst` (100 for started, rounded after, 0 not NaN when started is 0). Add a helper `onboardingFunnelStages` to `admin-format.ts`.

**Step 3: Implement** helper; test PASS.

**Step 4: Render + mount test.** In `AdminView.vue`, after the headline-metrics grid, add a `<section v-if="overview.onboarding">` reusing the metric-card pattern (`rounded-lg border border-border bg-surface p-4`, label `text-xs text-text-muted`, value `text-2xl font-semibold tabular-nums`), a `funnelStages` computed, and a failure-reason line (label "Agent onboarding (30d) · activation & best-effort" so the caveats are visible). Add a jsdom mount test (mock `../api` `getAdminOverview` to return a payload WITH `onboarding`, plus one WITHOUT it to prove the `v-if` guard doesn't crash) asserting the funnel numbers render. This is the Vue-wiring proof the formatter test can't give.

**Step 5:** `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test` → PASS. Commit: `feat(dashboard): onboarding funnel section in admin view`

---

## Task 4: Docs + gate

**Files:** Modify `docs/reference/http-routes.md`.

1. Extend the `/api/v1/admin/overview` **description** cell only (the drift checker parses method/path, not descriptions or fields — do not claim field-level drift detection): "…observability overview incl. best-effort agent-onboarding funnel (404 unless allowlisted)". No `covers:` frontmatter (deterministic tier).
2. Gate (direct commands, not root `pnpm test`): `cd packages/ingestion && go build ./... && go test ./db ./handler`; `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`; `node scripts/check-docs-drift.mjs && node scripts/check-docs-scope.mjs`.
3. Migration idempotency on a disposable DB (fresh + reapply) already covered by `TestMigrations`; also apply 018 to the shared dev DB so local admin views work.
4. Live check: seed a session (or run one `opslane setup`), open `/admin` as an allowlisted user, confirm the funnel renders. Commit: `docs: admin overview covers onboarding funnel`. STOP — no push (repo hook); hand to the user for `! git push` + PR.

## Scoped out (recorded)

Card-impression / copy / doc-fetch / CLI-launch counts (F19 — needs a client analytics vendor decision). `since` as a query parameter (fixed 30-day window; the other AdminOverview sections use varied windows — 1h/5m/24h/48h/7d/all-time — so there is no single house style to match; parameterize only on request). `agent_sessions` purging/retention (future; the `created_at` index bounds the scan cost for now).
