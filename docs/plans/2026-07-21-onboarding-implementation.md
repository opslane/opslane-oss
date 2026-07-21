# Onboarding: Reporting Signal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make onboarding finish when the user's app first runs, instead of when a real
production error eventually occurs — plus the two decision spikes that gate everything after.

**Architecture:** Derived from `docs/plans/2026-07-21-onboarding-unification-design.md`
(iteration 12). Two spikes first, because both change the cost of later phases. Then the
session lifecycle the design needs, then the reporting signal itself. Every task is TDD:
failing test, run it, minimal implementation, run it, commit.

**Tech Stack:** Go 1.24 + pgx (ingestion), TypeScript + Vitest (SDK), Postgres 16.

**Review history:** three Codex review rounds; convergence 14 → 8 → 2 P1s. Round 1 forced the
scope cut below. Round 2 fixed the server-side replay gate (C5), missing lifecycle consumers
(admin metrics, purge ciphertext), key-creation precision, and stale line refs. Round 3 found
that `key_ok` had **no producer** and that cross-command opt-out is not observable until P4 —
C7 was rescoped to build only the real `key_ok` transition, and the opt-out terminal state is
deferred to the `onboard` command with the limitation stated plainly.

---

## Scope, and what a review removed

The first draft of this plan also covered P0 (diagnosis and recovery). A Codex review found
its recovery task (fresh GitHub re-authorization) is not implementable as a plain authenticated
endpoint — **the GitHub user token only exists during an OAuth callback**, so recovery needs a
full authorization-start/state/callback flow. That belongs with P2's callback work, not here.

**Removed from scope, with reasons:**

| Removed | Why |
|---|---|
| P0 diagnosis + recovery | Recovery needs an OAuth flow design; it moves to the P2 plan |
| Localhost origin allowlisting | `allowed_origins` is **project**-scoped (queries.go:314) and matching is exact string equality (ingest_limits.go:121), so `http://localhost` never matches `http://localhost:5173`. Making it work needs a schema change plus port/wildcard semantics. **Consequence: design decision D14's stronger completion claim must weaken** — update the design doc to say "a valid project key reported with SDK identity," dropping the browser-attested-origin wording |

**Still out of scope:** the provider-agnostic callback (P2), the local harness (P3), the
terminal UI (P4), Python, the `service` field, the runtime-fetched spec.

---

## Conventions

- **Go tests**: `package db_test` / `package handler_test`, `testPool(t)` for a live database.
  Run from `packages/ingestion`.
- **TS tests**: colocated in `__tests__`, Vitest.
- **Migrations are append-only and reapplication-safe** (`IF NOT EXISTS`, guarded `ALTER`).
  Highest existing is `020`. **Numbers below are relative** — take the next free number when
  you write each one, and update later references. Do not hardcode.
- **Commit after every task.**
- Verify: `go build ./... && go test ./db ./handler`, `pnpm --filter @opslane/sdk test`.

---

## Phase A — Spikes (both gate later phases; neither touches product code)

### Task A1: Anthropic agent SDK licensing verdict

**Files:** Create `docs/decisions/anthropic-agent-sdk-terms.md`

**Step 1:** `@anthropic-ai/claude-agent-sdk` publishes `license: "SEE LICENSE IN README.md"`.
Find and read that README.

**Step 2:** Answer three questions in the doc:
1. May it be redistributed as a dependency of a published package?
2. Does anything tie usage to being an Anthropic API customer? Self-hosters run our CLI against
   their own deployment — this is the realistic snag.
3. Any field-of-use restriction incompatible with a commercial product?

**Step 3:** Record the consequence. Permissive → confirmed for P3, and its
`allowedTools`/`canUseTool` give us the local executor boundary as configuration. Restrictive →
fall back to the Apache-2.0 Vercel AI SDK and P3 grows by the cost of building that boundary.

**Step 4: Commit** — `docs: record Anthropic agent SDK licensing verdict`

> Note: relicensing the CLI to AGPL removes our **CI** gate on this, not Anthropic's terms.
> That makes this human read the only remaining check.

### Task A2: Ink vs OpenTUI, decided by measurement

**Files:** `spikes/tui/` (throwaway), `docs/decisions/tui-renderer.md`

**Step 1:** Build the same screen in each — 7-item streaming task list, one select, a second
static pane.

**Step 2:** Measure, with **pinned versions** recorded in the decision doc (`ink`, `@inkjs/ui`,
`@opentui/core`, `@opentui/react` — capture exact versions, they move fast):

- **Cold start:** `npm cache clean --force`, then `time npx <pkg>`; three runs, report the median.
- **Download size:** `npm pack` the spike and record the installed `node_modules` size.
- **Platforms:** macOS arm64 natively; Linux glibc, **Linux musl (`node:22-alpine`)**, and Windows
  via containers or CI runners. Record the command used for each.
- **Resize:** resize to 40 columns mid-render; note any corruption.
- **Ergonomics:** one paragraph each.

**Step 3: The hard gate — piped output.** `node spike.js | cat` must contain **zero ANSI
escapes**. `docs/reference/cli-agent-contract.md` requires byte-clean JSON when stdout is not a
terminal; a renderer that writes escapes into a pipe breaks every agent caller and is
disqualified regardless of anything else.

**Step 4:** Record the decision with numbers. Delete `spikes/tui/`.

**Step 5: Commit** — `docs: choose terminal renderer from measured spike`

---

## Phase B — Session lifecycle

The design's status vocabulary does not exist yet. **Nothing in Phase C can be built until this
lands.** `agent_sessions.status` is constrained to `pending`, `completed`, `expired`, `failed`
(017_agent_sessions_v2.sql:27–29), and provisioning writes `completed` directly
(agent_provision.go:250).

### Task B1: Widen the status vocabulary

**Files:** Create `packages/ingestion/db/migrations/0NN_agent_session_lifecycle.sql`;
test in `packages/ingestion/db/agent_provision_test.go`

**Step 1: Write the failing test** — assert a session can be moved to `provisioned` and then
`app_reporting`.

**Step 2: Run** `go test ./db/ -run TestAgentSessionLifecycleStatuses -v` → FAIL on the CHECK
constraint.

**Step 3: Implement**, following the precedent comment in `017`:

```sql
-- Widening the CHECK is expand-safe: old binaries never write the new values.
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_status_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_status_check
  CHECK (status IN ('pending', 'completed', 'expired', 'failed',
                    'provisioned', 'key_ok', 'app_reporting'));
```

**Step 4: Run** the test → PASS. Apply the migration twice against a disposable database to
prove idempotency.

**Step 5: Commit** — `feat(ingestion): widen agent session status vocabulary`

### Task B2: Teach every lifecycle consumer the new statuses

**Files:** `db/agent_provision.go:250` (writes `completed`), `handler/agent_setup.go:179`
(`AgentPoll` status mapping), the expiry/purge queries, `cli/src/setup.ts:224` (rejects unknown
statuses), and **`db/admin.go:115`** (onboarding funnel metrics count only `completed` and will
silently undercount every new success state).

**Existing tests encode `completed`** across provisioning, callback, delivery, purge, and admin.
Updating them is part of this task, not a follow-up.

**Step 1:** Write tests for each consumer: provisioning writes `provisioned`, not `completed`;
`AgentPoll` reports the new statuses; the CLI does not hard-fail; admin funnel metrics count the
new success states.

> **The purge assertion needs stating precisely — "purge does not reap them" is not a red test**,
> because cleanup already ignores unknown statuses and would pass before any implementation. The
> real gap: sealed ciphertext is cleared **only** for `completed` (queries.go:3230). Assert
> instead: after expiry, a session in `provisioned` / `key_ok` / `app_reporting` **keeps its
> status** but has `api_key_sealed` cleared. That test is red today.

**Step 2: Run** → FAIL.

**Step 3: Implement.** **Decide and record here: which status does the CLI treat as "keep
polling" versus "done"?** Today it terminates only on `completed`. `provisioned` and `key_ok`
are *continue*; `app_reporting` is *done*.

**Step 4: Run** `go test ./db ./handler` and `pnpm --filter @opslane/cli test`.

**Step 5: Commit** — `feat: carry the new session statuses through every consumer`

---

## Phase C — Development environment and reporting signal

### Task C1: Provision a development environment

**Files:** `db/agent_provision.go:234`; test in `db/agent_provision_test.go`

**Step 1: Write the failing test.** There is **no** generic provisioning helper — follow
`TestProvisionAgentSession_NewOrgUserProjectKey` (agent_provision_test.go:165) and use
`newProvisionCleanup`, `newProvisionFixture`, `createProvisionSession`, `fixture.input(...)`:

```go
func TestProvisionCreatesDevelopmentEnvironment(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	repo := "Dev-Env-" + fixture.suffix + "/Repo"
	session := createProvisionSession(t, q, cleanup, strings.ToLower(repo))
	input := fixture.input(session.ID, repo)
	cleanup.installation(input.InstallationID)

	result, err := q.ProvisionAgentSession(ctx, input)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	cleanup.org(result.OrgID)

	envs, err := q.ListEnvironments(ctx, result.ProjectID)
	if err != nil {
		t.Fatalf("list environments: %v", err)
	}
	names := map[string]bool{}
	for _, e := range envs {
		names[e.Name] = true
	}
	if !names["production"] || !names["development"] {
		t.Fatalf("want production and development, got %v", names)
	}
}
```

> `AgentProvisionResult` may not expose `ProjectID`. Check first; add it if missing, in this
> task, with the test that needs it.

**Step 2: Run** → FAIL (only `production`).

**Step 3: Implement** after the existing `CreateEnvironmentTx(… "production")`.

**Step 4: Run** → PASS. **Step 5: Commit.**

### Task C2: Deliver the development key to the CLI

**Files:** `db/agent_provision.go`, `handler/agent_setup.go` (`AgentPoll`), tests for both

**The decision this task exists to make.** The CLI receives exactly one key — the sealed
`agent_sessions.api_key_sealed`, returned by `AgentPoll` as `api_key`. Adding a second key to
`AgentProvisionResult` delivers nothing on its own.

**Implementation correction:** provisioning creates the two environments but only the
development key, and seals that key. API keys are hash-only and their raw value is visible only
when created; precreating a production key here would discard its raw value, leaving an unreachable
active row that the dashboard cannot retrieve. `setup` stores the development key in the CLI's
agent credential file so the later `init`/snippet wiring step can write it into `.env.local`.
The dashboard mints and displays a production key when the user deploys.

**Step 1:** Write a test asserting (a) both environments exist with exactly one key total, and
(b) the **sealed** key resolves to the **development** environment via `LookupAPIKey`.

**Step 2: Run** → FAIL (the existing key is bound to production).

**Step 3:** Implement. Do not change the *number* of keys `AgentPoll` returns — change which one
is sealed.

**Step 4: Run** `go test ./db ./handler`. **Step 5: Commit.**

### Task C3: SDK reports its identity on session init

**Files:** `packages/sdk/src/replay.ts` (`registerSession`, ~line 140);
test in `packages/sdk/src/__tests__/replay.test.ts`

**Step 1: Write the failing test.** `init` must be imported, and `destroy()` called in cleanup
— `init` leaves module-level state and a patched `fetch` behind, so without it later tests in
the file break:

```ts
import { init, destroy } from '../index';

afterEach(() => { destroy(); vi.unstubAllGlobals(); });

it('sends sdk identity on session init', async () => {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchSpy);

  init({ apiKey: 'k', release: 'abc123', environment: 'development' });

  await vi.waitFor(() => {
    expect(fetchSpy.mock.calls.some(([u]) =>
      String(u).includes('/api/v1/sessions/init'))).toBe(true);
  });

  const call = fetchSpy.mock.calls.find(([u]) =>
    String(u).includes('/api/v1/sessions/init'))!;
  const body = JSON.parse((call[1] as RequestInit).body as string);
  expect(body.sdk).toEqual({ name: '@opslane/sdk', version: expect.any(String) });
  expect(body.release).toBe('abc123');
  expect(body.environment).toBe('development');
});
```

**Step 2: Run** `pnpm --filter @opslane/sdk test -- replay` → FAIL.

**Step 3: Implement.** `SDK_VERSION` already exists (used in `core.ts`).

**Step 4: Run** the full SDK suite — the `destroy()` cleanup matters here.

**Step 5: Commit** — `feat(sdk): report SDK identity on session init`

### Task C4: Register the session even when replay is off

**Files:** `packages/sdk/src/index.ts:23` (init path), `packages/sdk/src/replay.ts`, tests

**The problem.** `registerSession` is reached **only** through replay startup. Replay disabled
means no registration at all — so a replay-disabled user could never finish onboarding.

**Step 1:** Write a failing test: `init({ replay: { enabled: false } })` still posts to
`/api/v1/sessions/init`.

**Step 2: Run** → FAIL (no call).

**Step 3:** Move registration so it runs from `init` regardless of replay. Give reporting its
**own** opt-out (name it in this task; do not overload the replay flag).

> **Note the limit honestly:** if a user opts out, no request is sent, so neither the server nor
> the `setup` poll loop can observe it (they are separate commands from `init`). A tidy
> opt-out terminal state needs the unified `onboard` command and is **deferred to P4** (see Task
> C7). Here, opting out simply means the SDK stays silent — do not build a server-side "opted
> out" state that cannot be observed.

**Step 4: Run** the SDK suite. **Step 5: Commit.** Update `docs/guides/replay-privacy.md` in
the same commit.

> **C4 fixes only the client half.** `SessionInit` (handler/session.go) returns early when
> `d.MinIO == nil` (line ~62) and when `ProjectRecordingEnabled` is false (line ~114) — both
> **before** `RegisterSession`. So a project with recording disabled, or any deployment without
> object storage, still never registers a session and could never finish onboarding. Task C5
> fixes the server half.

### Task C5: Persist SDK identity server-side

**Files:** new migration; **`packages/ingestion/db/sessions.go:71`** (`RegisterSession` — the
handler alone cannot store these); the `/api/v1/sessions/init` handler; handler test

**Step 1:** Write **three** handler tests, all posting `sdk`, `release`, `environment`:
1. Normal case — fields persist.
2. **`ProjectRecordingEnabled` false** — identity still persists.
3. **`d.MinIO == nil`** — identity still persists.

**Step 2: Run** → all three FAIL (2 and 3 return early before `RegisterSession`).

> **The fix is ordering, not a new endpoint.** Move identity persistence and the onboarding
> advance **ahead of** the MinIO and recording-enabled gates in `SessionInit`; leave the
> replay-specific work behind them. Reporting must not inherit replay's preconditions.

**Step 3:** Migration adds `sdk_name`, `sdk_version`, `sdk_release` to `sessions`, all
nullable — old SDKs omit them. Extend `RegisterSession`'s signature and INSERT.

> **`RegisterSession` is idempotent via `ON CONFLICT DO NOTHING`.** Decide and record: on a
> retried init, are SDK fields left as first written, or updated? Recommended: **leave them** —
> matching the existing "neither errors nor resets session progress" contract.

**Step 4:** Apply twice for idempotency; `go test ./handler`. **Step 5: Commit.**

### Task C6: Session reaches `app_reporting`

**Files:** `/api/v1/sessions/init` handler, `db/queries.go`; test in `handler/agent_setup_test.go`

**Step 1:** Write a test: a session in `provisioned` moves to `app_reporting` when a session
init carrying SDK identity arrives for its project. Seeding `provisioned` requires Task B1.

**Step 2: Run** → FAIL.

**Step 3:** Implement as **compare-and-set on current status**, accepting from **both
`provisioned` and `key_ok`** — the CLI probe is an optimization, not a gate, and events arrive
out of order.

**Step 4: Run** `go test ./db ./handler`. **Step 5: Commit.**

### Task C7: Produce `key_ok`, and stop overreaching on opt-out

*Rewritten after review — the previous C7 tested a client decision with no server state under
it. Two real gaps it exposed:*

1. **`key_ok` has no producer.** `MarkAgentKeyDelivered` (queries.go:3241) only stamps
   `key_claimed_at` and only `WHERE status = 'completed'` — nothing ever writes `key_ok`. The
   lifecycle the design assumes is missing its middle transition.
2. **Cross-command opt-out is not observable in this phase.** `setup`, `init`, and `snippet`
   are separate CLI commands (index.ts). The `setup` poll loop cannot see a reporting opt-out
   that a later `init` writes into SDK config, and an opt-out sends no request, so the server
   never learns it either. A "terminate at `key_ok` because the user opted out" flow cannot be
   built until `setup` and `init` share state — which is P4's `onboard` command, not this plan.

**So this task builds only the piece that is real here: the `key_ok` transition.**

**Files:** `handler/agent_setup.go:204` (key-delivery path), `db/queries.go` (`MarkAgentKeyDelivered`);
test in `db/agent_provision_test.go` and `handler`

**Step 1:** Write a failing test — after key delivery, a session in `provisioned` is at `key_ok`
(not `completed`), preserving the "keep polling" semantics from Task B2.

**Step 2: Run** → FAIL (`MarkAgentKeyDelivered` guards on `completed` and never sets `key_ok`).

**Step 3:** Make key delivery a **compare-and-set** `provisioned → key_ok`. Preserve the
idempotent `key_claimed_at` stamp.

**Step 4: Run** `go test ./db ./handler`. **Step 5: Commit** —
`feat(ingestion): transition to key_ok on key delivery`

> **Explicitly deferred to P4 (record here so it is a decision):** terminating onboarding at
> `key_ok` when reporting is opted out. It needs `setup` and `init` to share state, which is the
> unified `onboard` command. Until then a replay/reporting-opted-out user simply does not reach
> `app_reporting`; the poll times out with an honest "waiting for your app" message rather than a
> tidy terminal state. Not ideal, not wrong, and not fixable without `onboard`.

### Task C8: End-to-end on a real fixture

**Deterministic DB-seeded run, not live OAuth.** A real OAuth flow needs a configured App and a
human — that is P2's live smoke. Here the reporting path is what's under test, so seed the rest.

**Step 1:** `docker compose up -d`, then apply `scripts/seed-e2e.sql`. Extend the seed (or add a
sibling `seed-onboarding.sql`) so it creates, for the fixture project: a `development` environment,
one API key per environment (dev key sealed), and an `agent_sessions` row in **`provisioned`**.
Because the CLI poll path authenticates against the row, the seed must set **consistent**
`poll_token_hash`, `agent_key_pub`, and `api_key_sealed`, and you must write the matching raw poll
token into the CLI's pending state (`~/.opslane/pending/<id>.json`). Record the exact SQL and the
pending-file contents in this plan. The seed today creates only a production environment and key
(`scripts/seed-e2e.sql:24`) and no agent session.

> `test-fixtures/vue-app/src/main.ts:8` defaults to the **production** seed key and sets no
> environment. **Pass the development key explicitly** via the fixture's env file — otherwise this
> passes while proving nothing.

**Step 2:** Run `opslane setup --poll <id>` against the seeded session so the CLI advances it to
`key_ok` (Task C7). Then `npm run dev` and load the page. Assert in the database, within 60
seconds: a `sessions` row with `sdk_name`/`sdk_version`, its `environment_id` resolving to
**`development`**, and the agent session at `app_reporting`.

> Loading the page creates a **session**, not an error event. Assert on the session row.

**Step 3 (opt-out, reduced scope):** with reporting opted out in the fixture SDK config, load the
page and assert **no** `sessions` row is written (the SDK sends nothing) and the agent session
stays at `key_ok`. This proves the opt-out does not *break* anything. The tidy terminal state for
opt-out is deferred to P4 (Task C7 note) — do **not** assert a `reason`-carrying exit here.

> This scenario needs a **fresh** seeded session — the Step 2 row is already `app_reporting`.
> Re-run the seed (or seed a second session id) before this step.

**Step 4:** Paste both transcripts into this file. **If either fails, stop.** This is the
phase's entire justification.

#### C8 implementation evidence — 2026-07-21

The deterministic seed is committed as `scripts/seed-onboarding.sql`. Its exact onboarding
rows are:

```sql
INSERT INTO environments (id, project_id, name) VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000010', 'development')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO environment_api_keys (id, environment_id, key_hash, key_prefix) VALUES
  ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000000101',
   '508823bf8ff4d9f79476e49235816b554864b5fdc65f1c4a7e7abf58e24e397d', 'e2e-dev-')
ON CONFLICT (id) DO UPDATE SET
  environment_id = EXCLUDED.environment_id,
  key_hash = EXCLUDED.key_hash,
  revoked_at = NULL;

INSERT INTO agent_sessions (
  id, repo_url, status, org_id, project_id, poll_token_hash, agent_key_pub,
  api_key_sealed, expires_at, completed_at, key_claimed_at, failure_reason
) VALUES (
  '00000000-0000-4000-8000-00000000a001',
  'opslane/defender-test-fixture',
  'provisioned',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000010',
  '1dd1432510c1f0541b2e3aeb3cc70e35766471c7e3859c8e370f47194da988e6',
  '9cjjJ7AOfdXVKfWwI3CsBHLxOf1YvmCOh+/V/KAG8Qk=',
  'UhFCFG9oy9a5zir6ph2y/RW7VUxCr8+WAUOG3biuKHB/UTyXaKHDRzGr/DtR/tvbro6VXhW7lu1Gw9yGbUTsnHlHY5JLIh6JaNx5aRmwP2lgWgWXJ/wFORo=',
  now() + interval '24 hours',
  NULL, NULL, NULL
)
ON CONFLICT (id) DO UPDATE SET
  status = 'provisioned',
  org_id = EXCLUDED.org_id,
  project_id = EXCLUDED.project_id,
  poll_token_hash = EXCLUDED.poll_token_hash,
  agent_key_pub = EXCLUDED.agent_key_pub,
  api_key_sealed = EXCLUDED.api_key_sealed,
  expires_at = EXCLUDED.expires_at,
  completed_at = NULL,
  key_claimed_at = NULL,
  failure_reason = NULL;
```

Matching pending state, written under a temporary smoke-test `HOME`:

```json
{
  "poll_id": "00000000-0000-4000-8000-00000000a001",
  "poll_token": "opt_9001e986d7d75a0051a2e832119dc17b3aec0390e8d1b986b0c2212fbc23cb5c",
  "api_url": "http://localhost:8082",
  "repo": "opslane/defender-test-fixture",
  "created_at": "2026-07-21T00:00:00.000Z"
}
```

Reporting enabled used a fixture `.env.local` with the development key and
`VITE_OPSLANE_REPORTING=true`. The CLI poll ran concurrently with a fresh headless Chromium
page load:

```text
$ HOME=/tmp/opslane-onboarding-home node cli/dist/index.js setup --poll \
    00000000-0000-4000-8000-00000000a001 --api-url http://localhost:8082 --timeout 120
{
  "api_key": "e2e-development-key-plaintext",
  "org_id": "00000000-0000-0000-0000-000000000001",
  "project_id": "00000000-0000-0000-0000-000000000010",
  "repo": "opslane/defender-test-fixture",
  "status": "completed"
}

$ chromium http://127.0.0.1:4175/
{"title":"Opslane Fixture App","url":"http://127.0.0.1:4175/","requestFailures":[]}

$ SELECT s.sdk_name, s.sdk_version, s.sdk_release, e.name AS environment ...
@opslane/sdk | 1.1.0 | e2e-fixture-v1 | development

$ SELECT status, key_claimed_at IS NOT NULL, completed_at IS NOT NULL ...
app_reporting | t | t
```

For opt-out, the seed was reapplied to reset the agent session, the pending file was recreated,
and only `VITE_OPSLANE_REPORTING=false` changed. A fresh Chromium process loaded the fixture:

```text
$ HOME=/tmp/opslane-onboarding-home node cli/dist/index.js setup --poll \
    00000000-0000-4000-8000-00000000a001 --api-url http://localhost:8082 --timeout 1
{
  "status": "pending",
  "poll_id": "00000000-0000-4000-8000-00000000a001",
  "message": "Waiting for your app to report. Start it locally, then run setup --poll again."
}

$ chromium http://127.0.0.1:4175/
{"title":"Opslane Fixture App","sessionInitRequests":0}

$ SELECT count(*) FROM sessions WHERE project_id = '00000000-0000-0000-0000-000000000010';
1

$ SELECT status, key_claimed_at IS NOT NULL ...
key_ok | t
```

The session count was `1` immediately before and after the opt-out load, so the second run
created no session row.

---

## Before merge

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Also update `docs/plans/2026-07-21-onboarding-unification-design.md`: weaken D14's completion
claim (see Scope above) and mark the Phase A spike verdicts.

---

## Follow-on plans

| Plan | Contains | Blocked on |
|---|---|---|
| P2 — provider-agnostic callback | WorkOS-safe dispatch, **and P0's diagnosis + recovery**, since recovery needs the OAuth flow this plan builds | — (launch gate) |
| P3 — local harness and spec | Agent loop extraction, `service` field, preflight | A1, A2 |
| P4 — entry points and UI | `onboard`, two-pane UI, dashboard handoff | A2 |
