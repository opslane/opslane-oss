# P2: Provider-Agnostic GitHub Callback (the launch gate)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the remaining gaps so agent onboarding can be activated: prove both install
flows complete through the shared callback with a WorkOS-shaped provider, harden the
assertions the shipped implementation is missing, produce skip-proof launch evidence, and
make the activation runbook executable.

**Architecture:** The core P2 work — install callbacks exchanging their GitHub code with
GitHub instead of the identity provider, one exported `PersistInstallation` primitive,
token-guarded reservable OAuth state, admin-gated install routes, divergence diagnosis, and
the inert Setup URL handler — **already shipped in commit `69e2c9a` (PR #175)**. This plan is
now two things: (1) a verification ledger of that shipped work, and (2) the remaining
phases: acceptance proof, assertion hardening, the launch-evidence gate, and the runbook
rewrite. Design: `docs/plans/2026-07-21-onboarding-unification-design.md` (iteration 12),
decisions D2/D3/D4/D11/D12/D19-Q3.

**Tech Stack:** Go 1.24 + pgx, Postgres 16. All code work in `packages/ingestion`.

**Reviews:** four Codex rounds folded in. Rounds 1–2 shaped the original build plan; rounds
3–4 (2026-07-22) audited HEAD `69e2c9a` task-by-task, converted the build phases into the
ledger below, and corrected the remaining phases (skip-gate ordering, one-use authorization
codes, tenant-safety of the diagnosis, activation mechanics).

---

## Status ledger at `69e2c9a` — shipped, do not rebuild

Verified task-by-task against HEAD (Codex round 3, 2026-07-22). Line numbers are current.

| Original task | Status | Evidence at HEAD |
| --- | --- | --- |
| A1 `installation_landed` table | Shipped | `db/migrations/023_installation_landed.sql`; `InsertInstallationLanded` (db/installations.go:77) |
| A2 actor-bound install state | Shipped | `024_oauth_state_actor.sql`; wired in `GetGitHubAppStatus` (handler/github_oauth.go:738) |
| A3 token-guarded reserve/finalize/release | Shipped | `025_oauth_state_reservations.sql`; `ReserveOAuthLoginState` (db/queries.go:2614) + lifecycle tests |
| B1 dispatch on session state | Shipped | UUID dispatch at handler/github_oauth.go:135; denial regression in handler/github_install_callback_test.go:158 |
| C1 exported `PersistInstallation` | Shipped | db/installations.go:26; all three mutating paths call it |
| C2 GitHub exchange for install callbacks | Shipped | `gitHubInstallCallback` (handler/github_oauth.go:252); WorkOS spy test exists |
| C3 reserve/finalize + actor match | Shipped | Validation → reserve → exchange → tx finalize+persist at handler/github_oauth.go:252-400 |
| D1 org precedence | Shipped | Conflict handling inside `PersistInstallation` (db/installations.go:33) — correctly part of the primitive, not a later phase |
| D2 admin on install routes | Shipped | `RequireRoleIfCloud("admin")` on `/github/setup` + `/github/status` (handler/routes.go:156-157) |
| D3 divergence diagnosis | Shipped | handler/agent_setup.go:225-240; `TestAgentPollDiagnosesDivergentInstallWithoutMutation` |
| F1 inert Setup URL handler | Shipped | Non-mutating `GitHubSetupCallback` (handler/github_oauth.go:707) |
| G runbook file | Exists, not executable | `docs/runbooks/activate-agent-onboarding.md` — rewritten in Phase 4 |

**Known-stale references from the original plan:** highest migration is now **025** (not
022); handler callback tests live in **`github_install_callback_test.go`** (not
`callback_test.go`); `GitHubSetupCallback` is at line ~707 (not 506). The dashboard
"feature flag" is `AGENT_ONBOARDING_ENABLED` in `packages/dashboard/src/agent-onboarding.ts:8`
— a **compile-time constant** flipped by a reviewed activation PR, deliberately not a
runtime flag. Its test (`agent-onboarding.test.ts:29`) hard-asserts `false`, and the agent
quickstart doc carries `draft: true` with its own assertion, so the activation PR touches
all three — it is **not** a one-line diff.

---

## Conventions (remaining work)

- Handler tests are **`package handler`** and use **`githubOAuthTestPool(t)`**
  (github_oauth_test.go:419). DB tests are `package db_test` with `testPool(t)`. Run from
  `packages/ingestion`.
- **Skip-proof validation from the start.** Both test pools `t.Skip` when Postgres is
  unreachable, so a bare green `go test` proves nothing. Every phase's Validate step uses
  the existing CI recipe (ci.yml:171):
  ```bash
  go test ./db ./handler -v -count=1 2>&1 | tee /tmp/go-test.log
  GO_MIN_TESTS=1 node ../../scripts/check-go-skips.mjs /tmp/go-test.log
  ```
  `check-go-skips.mjs` fails on any unexpected skip. Do **not** invent a new gate flag —
  this script already exists and CI already runs it.
- **Red tests must compile.** Where a task's test is expected to pass immediately
  (characterization of shipped behavior), it must instead carry a **mutation check**:
  temporarily break the code under test, confirm the test fails, revert. A test that can't
  be made to fail proves nothing.
- Migrations append-only from **025**; none of the remaining phases need one.
- Commit after every task. `AGENT_ONBOARDING_ENABLED` and the GitHub App OAuth toggle are
  flipped **only** via Phase 4's runbook — the constant through a reviewed activation PR
  deployed by normal CI, the App toggle by a human in GitHub App settings. No ad-hoc
  automation flips either.

---

## Phase 1 — Close the acceptance gap: agent flow through the shared callback

> **Phase deliverable:** An acceptance test in which the **agent flow enters through
> `OAuthLoginCallback`** — the shared handler behind `/auth/callback` and
> `/auth/github/callback` (routes.go:57-58), which is what GitHub actually calls once
> OAuth-during-install is enabled — not by invoking `AgentAuthCallback` directly. Today's
> test (agent_callback_integration_test.go:165) bypasses the dispatch under test, so a
> dispatch regression would ship green.
> **Validate:** the new test passes under the skip-proof recipe, and the mutation check
> (break the UUID dispatch at github_oauth.go:135) makes it fail.

### Task 1.1: Successful agent install via `OAuthLoginCallback`

**Files:** `packages/ingestion/handler/agent_callback_integration_test.go` (extend);
dispatch under test at `packages/ingestion/handler/github_oauth.go:131-140`.

**Step 1:** The existing fixture (stub GitHub server, `recordingProvider` spy,
`createCallbackSession`) is a closure inside one test, not reusable — **extract it into a
helper** (with tenant cleanup) or parameterize the existing `callback` closure with the
entrypoint. Then write `TestAgentInstallCompletesThroughSharedCallback`, building the
request as GitHub sends it and handing it to the **shared** entrypoint:

```go
req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
    "/auth/callback?state=%s&installation_id=%d&setup_action=install&code=x",
    session.ID, installationID), nil)
w := httptest.NewRecorder()
deps.OAuthLoginCallback(w, req) // NOT AgentAuthCallback
```

Assert the **exact** post-callback state: HTTP 200 with the "Done!" body; the session's
exact post-callback status (read it from `GetAgentSession` — do not assume `provisioned`
is terminal) with non-null org, project, sealed key, and installation fields; an
`installation_landed` audit row; and **zero** `ExchangeCode` calls recorded by the spy.
Name it precisely: this is a **WorkOS-shaped injected provider** (the spy), not
`AUTH_PROVIDER=workos` boot-time selection — don't claim the env var is exercised.

**Step 2:** Run under the skip-proof recipe → PASS expected (the dispatch shipped).
**Mutation check:** invert the UUID check at github_oauth.go:135, rerun → must FAIL,
revert. If it doesn't fail, the test isn't exercising the dispatch — fix the test.

**Step 3:** No production change expected. **Step 4:** Skip-proof recipe green.
**Step 5: Commit** — `test(ingestion): agent install completes through the shared oauth callback`

---

## Phase 2 — Harden the shipped assertions

> **Phase deliverable:** The coverage gaps Codex found are closed, plus three small
> production fixes: client-secret config guards, detached reservation release, and
> rollback-before-release ordering on persistence failure. Tasks are sequenced so 2.4
> builds on 2.3's detached release. Each task is independently committable.
> **Validate:** skip-proof recipe green after each task; production changes carry
> red-first tests; characterization tests carry mutation checks.

### Task 2.1: A3 takeover invalidates the old token for finalize AND release

**Files:** the reservation lifecycle tests in `packages/ingestion/db`.

**Step 1:** Extend the expired-lease test: reserve, force-expire (raw SQL backdating
`reserved_at`), reserve again (new token). Assert the **old** token fails
`FinalizeOAuthLoginState` **and** fails `ReleaseOAuthLoginState`, and the state stays
leased to the new token.

**Step 2:** Run → PASS expected (compare-and-set on `(state_hash, reservation_token)`).
Mutation check: drop the token predicate from the release query, confirm FAIL, revert.
If it fails unmutated, fix `db/queries.go`.

**Step 3–4:** Skip-proof recipe green. **Step 5: Commit** —
`test(ingestion): stale reservation token cannot finalize or release after takeover`

### Task 2.2: Config guards include the client secret — both branches

**Files:** `packages/ingestion/handler/github_oauth.go` (web install branch guard) **and**
`packages/ingestion/handler/agent_setup.go` (`AgentAuthCallback`'s guard — it has the same
omission); tests in `github_install_callback_test.go`.

**Step 1:** Red tests: deps with `GitHubAppClientSecret: ""` on (a) an install-shaped web
callback and (b) an agent callback → expect a clear "misconfigured" 500-class error, not a
confusing 502 from a doomed GitHub exchange.

**Step 2:** Run → FAIL (secret unchecked today). **Step 3:** Add the secret to both guards.

**Step 4:** Skip-proof recipe green. **Step 5: Commit** —
`fix(ingestion): fail fast when the github client secret is missing`

### Task 2.3: Reservation release survives request cancellation

**Files:** `packages/ingestion/handler/github_oauth.go:326` (release call); test in
`github_install_callback_test.go`.

**Step 1:** Red test: cancel the request context before the transient-failure release path
runs → assert the reservation is still released (a fresh reserve succeeds immediately, no
2-minute lockout).

**Step 2:** Run → FAIL (release uses `r.Context()`, already canceled).

**Step 3:** Release with a detached, **bounded** context — bare `WithoutCancel` can hang:

```go
releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
defer cancel()
```

**Step 4:** Skip-proof recipe green. **Step 5: Commit** —
`fix(ingestion): release oauth reservation even when the request is canceled`

### Task 2.4: Transient-failure recovery and finalize/persist atomicity (builds on 2.3)

**Files:** `packages/ingestion/handler/github_oauth.go` (web branch failure paths),
`github_install_callback_test.go`.

> GitHub authorization codes are **one-use**. A "retry" is the user traversing the same
> install link again, which produces a **fresh code** with the **same state**. Do not
> write a test that replays the same code and call it proof — a permissive stub would
> pass while production fails.

**Step 1:** Two tests. (a) **Exchange fails before the code is consumed** (GitHub token
endpoint 500s): assert the reservation is released, `__auth_state` is preserved, and a
second callback with the **same state + a fresh code** against a healthy stub completes
and persists. (b) **Persistence failure atomicity:** seed a conflicting installation→org
mapping so `PersistInstallation` errors inside the tx → assert the state row is **not**
consumed (finalize rolled back with it) and the reservation is released so the flow is
retryable.

**Step 2:** Run → (b) likely exposes a real ordering bug: the reservation lives outside
the tx, so on persistence failure the handler must **roll back the tx first, then release
via 2.3's detached context** — releasing before rollback can block on the transaction's
row lock.

**Step 3:** Fix the ordering if (b) fails. **Step 4:** Skip-proof recipe green.
**Step 5: Commit** — `fix(ingestion): install callback recovers cleanly from transient and persistence failures`

### Task 2.5: Tighten four weak assertions

**Files:** `packages/ingestion/handler/github_install_callback_test.go`,
`packages/ingestion/db` tests.

One commit, four edits — assert **endpoint-exact** results, not absence of failure:

- **D1 handler-level conflict:** web callback whose reserved target org conflicts with an
  existing mapping → assert the specific 409 response.
- **D2 admin success:** `/github/setup` returns its intentional **302** redirect;
  `/github/status` returns **200** (today "not 401/403" lets a 500 pass).
- **F1 zero writes:** the setup-callback test asserts no rows in
  `github_app_installations` **and** `installation_landed` (today only
  `orgs.github_installation_id`).
- **A1 direct coverage:** a `db_test` exercising `InsertInstallationLanded` directly.

**Steps:** mutation-check each, skip-proof recipe green.
**Commit** — `test(ingestion): tighten install-path assertions`

### Task 2.6: D3 diagnosis proven end-to-end — and kept tenant-safe

**Files:** `github_install_callback_test.go`; `handler/agent_setup.go:225-240` unchanged
in content.

> **Tenant-safety constraint (do the opposite of the earlier draft):** agent sessions are
> unauthenticated and accept arbitrary `owner/repo`; a poll token proves no membership.
> The diagnosis must **not** name the landing org or installation — that is a
> cross-tenant information leak. Keep the message generic recovery guidance.

**Step 1:** End-to-end test with **no hand-seeded rows**: drive a real web install through
`gitHubInstallCallback` for the session's repo, then poll the agent session → the generic
diagnosis appears. Add a negative assertion: the poll response contains no org name or
installation id from the other tenant.

**Step 2:** Run; mutation check by disabling the `installation_landed` lookup.

**Step 3–4:** Skip-proof recipe green. **Step 5: Commit** —
`test(ingestion): divergence diagnosis proven end-to-end and tenant-safe`

---

## Phase 3 — Launch evidence: the full gate, skip-proof, on a disposable DB

> **Phase deliverable:** A recorded transcript proving the full gate ran with **zero
> silent skips** against a disposable Postgres, tied to a commit SHA and CI run. This is
> the launch-gate proof; commands alone are not evidence.
> **Validate:** the transcript below shows verbose `-count=1` output piped through
> `scripts/check-go-skips.mjs` (the CI recipe), the migration-reapply check, and the
> repo-wide gate, all against the named SHA.

### Task 3.1: Disposable Postgres procedure (explicit — no shared 5434)

**Step 1:** Stand up a throwaway instance; the migration tests create child databases, so
the role needs `CREATEDB`:

```bash
docker run -d --name p2-gate-pg -e POSTGRES_USER=opslane -e POSTGRES_PASSWORD=opslane_dev \
  -e POSTGRES_DB=opslane -p 55440:5432 postgres:16
trap 'docker rm -f p2-gate-pg' EXIT
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:55440/opslane?sslmode=disable"
docker exec p2-gate-pg psql -U opslane -c 'ALTER ROLE opslane CREATEDB;'
```

**Step 2:** Apply all migrations, then `scripts/check-migration-reapply.sh` against this
instance. Never point any of this at the retained 5434 dev database.

### Task 3.2: Run and record the full gate

**Step 1:** From `packages/ingestion`, the CI recipe — verbose, uncached, skip-checked
(mirror ci.yml, including its `GO_ALLOWED_SKIP_PATTERN` for suites needing MinIO, or run
MinIO too):

```bash
go build ./...
go test ./... -v -count=1 2>&1 | tee /tmp/go-test.log
node ../../scripts/check-go-skips.mjs /tmp/go-test.log
```

**Step 2:** Repo-wide gate: `pnpm install --frozen-lockfile && pnpm -r build && pnpm test`,
`docker compose config --quiet`.

**Step 3:** Record in this section: the commit SHA, the CI run URL for that SHA, and the
tails of each command's output. Evidence must be attributable — a pasted tail with no SHA
is stale the moment the branch moves.

**Step 4: Commit** — `test(ingestion): record the launch-gate transcript`

**Transcript:** _(recorded when Phase 3 runs; must name the SHA and CI run)_

---

## Phase 4 — Rewrite the activation runbook around the real mechanism

> **Phase deliverable:** `docs/runbooks/activate-agent-onboarding.md` rewritten so a named
> human can execute it. Activation is (a) the GitHub App "Request user authorization
> (OAuth) during installation" toggle and (b) a reviewed **activation PR** — which flips
> `AGENT_ONBOARDING_ENABLED` (agent-onboarding.ts:8), updates the hard-coded `false`
> assertion (agent-onboarding.test.ts:29), and un-drafts the agent quickstart doc (its
> `draft: true` flag plus that draft's assertion). Deployed by normal CI after review —
> never ad-hoc automation.
> **Validate:** doc review against Task 4.1's checklist — every step has an owner role, an
> exact precondition, an exact artifact (toggle name / file+line / URL), a verification
> probe that exists (no fictional log queries), and an honest rollback; rollbacks run in
> reverse order (UI exposure off before docs unpublish).

### Task 4.1: The rewrite

**Files:** `docs/runbooks/activate-agent-onboarding.md`.

Required ordered steps, each with owner, precondition, verification, rollback:

0. **App prerequisites:** the GitHub App's callback URL includes
   `/auth/github/callback` (routes.go:58) and the App has Account permission
   **"Email addresses: Read-only"**. Verify in App settings before anything else.
1. **Precondition gate:** Phase 3 transcript green for the deployed SHA; CLI on npm —
   verify the **exact version** on the `latest` dist-tag and run a real
   `npx -y @opslane/cli@latest` smoke, not just registry existence.
2. **Publish docs:** `docs.opslane.com/agent.md` live. Verify **content** (fetch and check
   it contains the setup command), not just HTTP 200. Rollback: unpublish — but only
   after step 4's rollback (reverse order), since the dashboard prompt tells agents to
   fetch this file.
3. **GitHub App toggle:** enable "Request user authorization (OAuth) during installation"
   (owner: App admin). Verify: a fresh production install lands on the shared callback and
   completes; positive signal is `installation_landed` rows advancing. **Rollback honesty:
   disabling the toggle is a degraded emergency stop, not a clean rollback** — it restores
   the Setup URL path, whose handler is intentionally inert (F1), so new installs stop
   persisting until the toggle is re-enabled or a compatible code rollback ships. Say so
   in the runbook.
4. **Activation PR:** the three-file diff above, authored and merged by a named engineer,
   deployed through normal CI. Rollback: revert PR (this is the clean rollback lever).
5. **Post-activation probe:** run the quickstart on a clean repo against production;
   confirm session → provisioned and the dashboard card renders. If deeper production
   assurance is wanted (e.g. "no GitHub codes ever reach the identity provider"), add an
   explicit metric first — do not claim log evidence that isn't emitted.

**Commit** — `docs: executable activation runbook for agent onboarding`

---

## Acceptance criteria (remaining)

1. The agent flow completes through `OAuthLoginCallback` with a WorkOS-shaped spy
   provider recording zero code exchanges — and the mutation check proves the test fails
   when the UUID dispatch breaks (Phase 1).
2. Config guards cover the client secret in both callback branches; reservation release is
   detached and bounded; persistence failure rolls back finalize **then** releases; the
   same-state/fresh-code retry path is proven (Phase 2).
3. The diagnosis is proven end-to-end without seeded rows and leaks no tenant
   information (Task 2.6).
4. The launch transcript shows the CI skip-check recipe passing against a disposable DB,
   tied to a SHA and CI run (Phase 3).
5. The runbook names the real activation mechanisms with owners, existing probes, and
   honest rollbacks in reverse order (Phase 4).

---

## What this unblocks

A hosted user can complete GitHub authorization with recorded, attributable proof, making
the P1 reporting flow reachable end to end. Agent onboarding can be activated by executing
the Phase 4 runbook; P3's `onboard` experience integrates against a verified callback.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | CLEAR (all findings folded in) | R3: 9 P1 + 9 P2; R4: 14 P1 + 8 P2 — all addressed in this revision |

**CODEX:** Round 3 established the plan was stale (phases A–D/F already shipped at
`69e2c9a`) and drove the ledger restructure; round 4 corrected the remaining phases:
reuse `check-go-skips.mjs` instead of a new gate flag, one-use authorization-code retry
semantics, rollback-before-release ordering, endpoint-exact assertions, tenant-safe
diagnosis, and executable activation mechanics with honest rollbacks.

**VERDICT:** CODEX CLEARED — both review rounds' findings are incorporated; the plan is
ready to execute (eng review not run in this session).

NO UNRESOLVED DECISIONS
