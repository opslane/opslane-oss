# Agent Onboarding PR 5 — Funnel Telemetry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface the agent-onboarding funnel (started → auth clicked → completed → key claimed → first event) plus failure breakdown in the existing admin overview, with no new vendor, route, or migration.

**Architecture:** Everything already exists except the read side: migration 016 added `auth_clicked_at` / `key_claimed_at` / `failure_reason`, and the write paths are live (`MarkAgentSessionAuthClicked` in the auth redirect, `MarkAgentKeyDelivered` on first key delivery, `MarkAgentSessionFailed` + the provisioning tx). This PR adds one query section to `AdminOverviewData`, one JSON field, one dashboard section, and tests.

**Tech Stack:** Go 1.24 + pgx (db), Vue 3 + Tailwind (AdminView), vitest/go test.

**Context you need:**
- Design doc v5: PR 5 section + F18/F19 dispositions. Funnel semantics fixed there: `since` = 30 days; **post-migration sessions only, no backfill** (old rows lack the timestamps — do not present pre-016 data as zeros); `first_event_received` is a point-in-time metric (read-time `EXISTS`), not an event log; card-impression/copy analytics are scoped out (F19).
- `packages/ingestion/db/admin.go` — `AdminOverview` struct (`Events/Jobs/Workers/Outcomes`) and `AdminOverviewData(ctx)`'s sequential-query pattern (pre-initialized maps, `fmt.Errorf("<label>: %w")`, explicit `rows.Close()`). Mirror it exactly.
- `handler/admin.go:AdminOverview` serves it; route already `RequireAdmin`-gated. **No routes.go change.**
- Funnel columns and writers (verify, don't re-implement): `db/queries.go` `MarkAgentSessionAuthClicked` (~:2806), `MarkAgentKeyDelivered` (~:2782), `MarkAgentSessionFailed` (~:2794); `agent_provision.go` sets `status='completed'`/`failed`. `error_events(project_id)` is indexed (`idx_error_events_project`).
- Dashboard: `src/types/api.ts` has the `AdminOverview` type consumed by `AdminView.vue`; the headline metric-card grid at `AdminView.vue:119-148` is the pattern to copy (`rounded-lg border border-border bg-surface p-4`, label `text-xs text-text-muted`, value `text-2xl font-semibold tabular-nums`).
- Test patterns: `db/admin_test.go` (DB-backed, `testPool`), `handler/admin_integration_test.go` (`authTestRouter` + allowlisted admin JWT), dashboard `// @vitest-environment jsdom` mounts.
- DB tests need local Postgres (compose, port 5434) with migrations applied.

---

## Task 1: db — funnel struct + query section

**Files:** Modify `packages/ingestion/db/admin.go`; test in `packages/ingestion/db/admin_test.go` (or a new `admin_onboarding_test.go` alongside, same package).

**Step 1: Failing test**

```go
func TestAdminOverviewOnboardingFunnel(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	// Seed four sessions in known funnel states (30-day window).
	// 1: started only. 2: started+clicked. 3: completed+key claimed, project
	// WITH an event. 4: failed with a reason. Plus one OLD session (created_at
	// 40 days ago) that must be excluded from every count.
	org, _ := q.CreateOrg(ctx, "funnel-test-org")
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, _ := q.CreateProject(ctx, org.ID, "funnel-proj", ptrStr("funnel/repo"))
	// insert an error_event row for project (copy the insert used by other db tests)

	mk := func(mut string) string { // helper: create session then apply mutation SQL
		s, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
			RepoURL: "funnel/repo-" + mut, PollTokenHash: "h", AgentKeyPub: "p"})
		if err != nil { t.Fatal(err) }
		t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id=$1`, s.ID) })
		return s.ID
	}
	_ = mk("started")
	s2 := mk("clicked")
	pool.Exec(ctx, `UPDATE agent_sessions SET auth_clicked_at=now() WHERE id=$1`, s2)
	s3 := mk("done")
	pool.Exec(ctx, `UPDATE agent_sessions SET auth_clicked_at=now(), status='completed',
		completed_at=now(), key_claimed_at=now(), org_id=$2, project_id=$3 WHERE id=$1`,
		s3, org.ID, project.ID)
	s4 := mk("failed")
	pool.Exec(ctx, `UPDATE agent_sessions SET status='failed', failure_reason='repo_not_granted' WHERE id=$1`, s4)
	s5 := mk("old")
	pool.Exec(ctx, `UPDATE agent_sessions SET created_at=now()-interval '40 days' WHERE id=$1`, s5)

	overview, err := q.AdminOverviewData(ctx)
	if err != nil { t.Fatal(err) }
	f := overview.Onboarding
	// Counts are >= seeded values (shared dev DB may hold other rows) — assert
	// deltas instead: run AdminOverviewData BEFORE seeding, diff after.
	_ = f
}
```

Structure the assertion as before/after delta (take a baseline `AdminOverviewData` before seeding, subtract) so the test is robust on the shared dev DB — same defensive style the other db tests use with cleanup. Assert deltas: `Started +4` (old excluded), `AuthClicked +2`, `Completed +1`, `KeyClaimed +1`, `FirstEvent +1`, `Failed +1`, `ByFailureReason["repo_not_granted"] +1`.

**Step 2:** `cd packages/ingestion && go test ./db -run TestAdminOverviewOnboardingFunnel -v` → FAIL (`overview.Onboarding` undefined).

**Step 3: Implement.** Add to `admin.go`:

```go
// AdminOnboardingOverview is the agent-onboarding funnel (design PR 5 / F18).
// Window: sessions created in the last 30 days. Pre-migration-016 rows lack
// click/claim timestamps and are naturally undercounted — no backfill, by design.
// FirstEventReceived is a point-in-time read (EXISTS against error_events),
// not an event log.
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

Add `Onboarding AdminOnboardingOverview \`json:"onboarding"\`` to `AdminOverview`. In `AdminOverviewData`, append a section (initialize `ByFailureReason` map up top with the other maps):

```go
	// Agent-onboarding funnel (last 30 days).
	err = q.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(auth_clicked_at),
		       count(*) FILTER (WHERE status = 'completed'),
		       count(key_claimed_at),
		       count(*) FILTER (WHERE status = 'completed' AND project_id IS NOT NULL
		         AND EXISTS (SELECT 1 FROM error_events e WHERE e.project_id = agent_sessions.project_id)),
		       count(*) FILTER (WHERE status = 'failed')
		FROM agent_sessions
		WHERE created_at >= now() - interval '30 days'`,
	).Scan(&result.Onboarding.Started, &result.Onboarding.AuthClicked,
		&result.Onboarding.Completed, &result.Onboarding.KeyClaimed,
		&result.Onboarding.FirstEventReceived, &result.Onboarding.Failed)
	if err != nil {
		return nil, fmt.Errorf("onboarding funnel: %w", err)
	}

	rows, err = q.pool.Query(ctx, `
		SELECT failure_reason, count(*) FROM agent_sessions
		WHERE status = 'failed' AND failure_reason IS NOT NULL
		  AND created_at >= now() - interval '30 days'
		GROUP BY failure_reason`)
	// ... scan into result.Onboarding.ByFailureReason, same rows pattern as the
	// jobs-by-status section, wrapped "onboarding failure reasons: %w".
```

**Step 4:** Test → PASS. Also `go test ./db ./handler` (the handler integration test for `/api/v1/admin/overview` must still pass — the response simply gains a field).

**Step 5:** Commit: `feat(ingestion): agent-onboarding funnel in admin overview`

---

## Task 2: Dashboard — type + AdminView funnel section

**Files:** Modify `packages/dashboard/src/types/api.ts`, `packages/dashboard/src/views/AdminView.vue`; test `packages/dashboard/src/admin-funnel.test.ts`.

**Step 1:** Add to the `AdminOverview` type in `types/api.ts`:

```ts
  onboarding: {
    started: number;
    auth_clicked: number;
    completed: number;
    key_claimed: number;
    first_event_received: number;
    failed: number;
    by_failure_reason: Record<string, number>;
  };
```

**Step 2: Failing test.** Extract a tiny pure helper so the display logic is testable without mounting the 335-line view — create `src/admin-format.ts` addition (that module already exists):

```ts
export interface FunnelStage { label: string; count: number; pctOfFirst: number; }
export function onboardingFunnelStages(o: AdminOverview['onboarding']): FunnelStage[]
```

Test (plain node env, next to `admin-format.test.ts`): stages in order started → auth_clicked → completed → key_claimed → first_event_received; `pctOfFirst` is 100 for the first stage and rounded percentages after; all-zero input yields pct 0 (no NaN).

**Step 3:** Implement helper; test PASS.

**Step 4: Render.** In `AdminView.vue`, after the headline-metrics section (the grid at ~lines 119-148), add a new section following the same card pattern:

```vue
      <section v-if="overview.onboarding" aria-label="Agent onboarding funnel" class="space-y-3">
        <h2 class="text-sm font-medium text-text">Agent onboarding (30d)</h2>
        <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div v-for="stage in funnelStages" :key="stage.label"
               class="rounded-lg border border-border bg-surface p-4">
            <p class="text-xs text-text-muted">{{ stage.label }}</p>
            <p class="mt-2 text-2xl font-semibold tabular-nums">{{ stage.count }}</p>
            <p class="text-xs text-text-faint">{{ stage.pctOfFirst }}%</p>
          </div>
        </div>
        <div v-if="Object.keys(overview.onboarding.by_failure_reason).length"
             class="text-xs text-text-muted">
          Failures:
          <span v-for="(n, reason) in overview.onboarding.by_failure_reason" :key="reason" class="mr-3">
            {{ reason }}: <span class="tabular-nums">{{ n }}</span>
          </span>
        </div>
      </section>
```

with `const funnelStages = computed(() => overview.value ? onboardingFunnelStages(overview.value.onboarding) : []);` in the script. Guard with `v-if="overview.onboarding"` so an older server payload doesn't crash the view.

**Step 5:** `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test` → PASS.

**Step 6:** Commit: `feat(dashboard): onboarding funnel section in admin view`

---

## Task 3: Docs + gate

**Files:** Modify `docs/reference/http-routes.md` (line ~54).

1. Extend the `/api/v1/admin/overview` row description: "…observability overview incl. agent-onboarding funnel (404 unless allowlisted)". Run root `pnpm test` — the drift checker must stay green.
2. Full gate: `cd packages/ingestion && go build ./... && go test ./... -count=1`; `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`.
3. Live check: compose up, run one `opslane setup --start` against local (or seed a session by SQL), open `/admin` as an allowlisted user, see the funnel render.
4. Commit: `docs: admin overview covers onboarding funnel`. STOP — no push (repo hook); hand to the user for `! git push` + `gh pr create`.

## Scoped out (recorded, not forgotten)

Card impressions / copy clicks / doc fetches / CLI-launch counts (F19 — requires a client analytics vendor decision); `since` as a query parameter (fixed 30-day window matches every other AdminOverview section; parameterize only when someone asks).
