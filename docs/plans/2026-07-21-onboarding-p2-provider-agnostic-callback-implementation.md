# P2: Provider-Agnostic GitHub Callback (the launch gate)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make GitHub App installation complete under `AUTH_PROVIDER=workos`, so agent
onboarding can be activated without breaking web installs. The single gate on launching agent
onboarding; the built P1 reporting flow is unreachable by a hosted user until this lands.

**Architecture:** Design `docs/plans/2026-07-21-onboarding-unification-design.md` (iteration
12), decisions D2/D3/D4/D11/D12/D19-Q3. `OAuthLoginCallback` (github_oauth.go:131) sends an
install callback's **GitHub** code to `d.provider().ExchangeCode` (line 216); under WorkOS that
provider cannot exchange it, so the flow dies silently. We move install handling **ahead** of
the identity exchange with a dedicated GitHub exchange, make OAuth state reservable with an
ownership token, bind the initiating user, share one exported install-persistence primitive,
require admin, and — because P0's recovery was folded here — add the `installation_landed`
audit table and its diagnosis. The App toggle flips **last**, via runbook.

**Tech Stack:** Go 1.24 + pgx, Postgres 16. All work in `packages/ingestion`.

**Reviews:** two Codex rounds folded in (13 then 6 P1s; convergent).

---

## Independence

Entirely Go in `packages/ingestion`; P3 is TypeScript in `packages/agent-core`/`cli`. Zero file
overlap — parallelizable. Only late coupling: P3's `onboard` command consumes the login-first
provisioning this plan prepares.

---

## Conventions

- Handler tests are **`package handler`** (not `handler_test`) and use **`githubOAuthTestPool(t)`**
  (github_oauth_test.go:387), not `testPool`. DB tests are `package db_test` with `testPool(t)`.
  Run from `packages/ingestion`: `go build ./... && go test ./db ./handler`.
- **Red tests must compile.** A test that names a not-yet-created method/type will not compile,
  so it is not a valid red test. Two allowed patterns: (a) drive the fail-first with raw SQL or
  existing public behavior; or (b) **first add a compiling stub** (method/type that returns a
  `not implemented` error), commit nothing, write the red test against the stub (it fails at
  runtime, compiles), then implement. Tasks A3 and C1 use pattern (b) — add the stubs in step 3's
  file before the step 1 test.
- Migrations append-only from the highest existing (**022**), reapplication-safe. Take the next
  free number when writing each; the `scripts/check-migration-reapply.sh` gate now guards
  replay-with-data.
- Commit after every task. **Never flip the production App toggle from code or CI** (Phase G).

---

## Phase A — Audit table and reservable, actor-bound OAuth state

### Task A1: `installation_landed` audit table (P0 artifact, folded here)

**Files:** new migration `0NN_installation_landed.sql`; test in `db`.

> It does **not** exist yet (only `github_app_installations`, 001_baseline.sql:342). D1 and the
> diagnosis depend on it, so it comes first.

**Step 1:** Failing test inserts a landed row and reads it back (raw SQL, so it compiles).

**Step 2:** `go test ./db -run InstallationLanded -v` → FAIL (relation missing).

**Step 3:** Migration:
```sql
CREATE TABLE IF NOT EXISTS installation_landed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id BIGINT NOT NULL,
  org_id UUID REFERENCES orgs(id),
  repos TEXT[] NOT NULL DEFAULT '{}',
  landed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_installation_landed_at ON installation_landed(landed_at DESC);
```
Add an exported `InsertInstallationLanded(ctx/tx, …)` helper.

**Step 4:** Apply twice for idempotency; test → PASS. **Step 5: Commit** —
`feat(ingestion): installation_landed audit table`

### Task A2: `initiating_user_id` on install OAuth state, wired at creation

**Files:** migration `0NN_oauth_state_actor.sql`; `db/queries.go` (`StoreOAuthLoginStateForOrg`
~2568 and the `OAuthLoginState` struct); `github_oauth.go:574` (the install-state creator);
tests in `db` and `handler`.

**Step 1:** Failing test: after `GetGitHubAppStatus` mints an install state, the row carries
the **authenticated user's** id. (Ordinary login states — the non-install path — must stay
actorless; assert that too.)

**Step 2:** Run → FAIL (only `orgID` is stored today).

**Step 3:** Add `ADD COLUMN IF NOT EXISTS initiating_user_id UUID REFERENCES users(id)`. Extend
`StoreOAuthLoginStateForOrg` to accept and store it, and pass `UserIDFromCtx(r.Context())` at
github_oauth.go:574. Do **not** set it on the ordinary login-state insert.

**Step 4:** `go test ./db ./handler` → PASS. **Step 5: Commit** —
`feat(ingestion): bind initiating user to install oauth state`

### Task A3: Reserve / finalize / release with an ownership token

**Files:** migration adding `reserved_at TIMESTAMPTZ` + `reservation_token UUID`;
`db/queries.go` near `ConsumeOAuthLoginStateDetails` (2587); test in `db`.

> A bare `reserved_at` is race-unsafe: after lease expiry, a stale request could
> finalize/release a newer reservation. Reserve returns a **token**; finalize/release require
> the matching token.

**Step 1:** Failing tests (raw SQL to set up, public methods under test):
- `ReserveOAuthLoginState(hash)` → returns context (`target_org_id`, `initiating_user_id`) **and
  a `reservation_token`**; a second reserve within the lease returns "in flight".
- `FinalizeOAuthLoginState(hash, token)` consumes only when the token matches; wrong/expired
  token → no-op error.
- `ReleaseOAuthLoginState(hash, token)` clears the lease only for the matching token.
- After the lease TTL, a fresh reserve succeeds and issues a **new** token, invalidating the old.

**Step 2:** Run → FAIL.

**Step 3:** Implement as compare-and-set updates keyed on `(state_hash, reservation_token)`.
Keep `ConsumeOAuthLoginStateDetails` intact — callers switch in Task C3. **Lease TTL: 2
minutes** (long enough for a GitHub exchange, short enough to recover a crash).

**Step 4:** `go test ./db` → PASS. **Step 5: Commit** —
`feat(ingestion): token-guarded reservable oauth login state`

---

## Phase B — Dispatch on the session before requiring success params

### Task B1: Recognize the agent session from `state` alone; make `authorization_denied` reachable

**Files:** `github_oauth.go` dispatch block (131-143); `agent_setup.go` (`AgentAuthCallback`,
denial handling); test in `callback_test.go` (`package handler`, `githubOAuthTestPool`).

**Step 1:** Failing test: a callback with UUID `state`, `error=access_denied`, and **no**
`installation_id` drives the matching pending session to `authorization_denied` (today it falls
through to the login path and hangs — the guard at :135 requires `installation_id`).

**Step 2:** `go test ./handler -run AuthorizationDenied -v` → FAIL.

**Step 3:** Parse `state` first: a UUID naming a pending agent session routes to the agent
handler **regardless of** `installation_id`/`error`. The agent handler maps `error=access_denied`
→ `authorization_denied` (definitive, terminal); a missing code with no error stays pending
(transient — preserve the "cheap unauthenticated requests never kill a session" rule). **This
UUID/agent path is intentionally session-authenticated only; do not add the browser actor-match
that Task C3 adds to the web path.**

**Step 4:** `go test ./handler` → PASS. **Step 5: Commit** —
`fix(ingestion): dispatch github callback on session state before install params`

---

## Phase C — The B1 fix: exchange the GitHub code with GitHub, and persist through one primitive

Ordering note: **D-work (the shared primitive) comes before the exchange rewrite**, because C's
new install branch must persist through it.

### Task C1: Exported `persistInstallation` primitive, all three paths through it (D12)

**Files:** `db/agent_provision.go` (the tx at 45, install insert at 213); `github_oauth.go:472`
and `:540` (the two `SetOrgGitHubInstallation` callers); test in `db`.

**Step 1:** Failing test: an **exported** `PersistInstallation(ctx, tx, params)` writes the
installation and an `installation_landed` audit row **inside one transaction**. (Exported so
`package handler` and `db_test` can call it — a lowercase `db.persistInstallation` cannot be.)

**Step 2:** Run → FAIL.

**Step 3:** Define `PersistInstallationParams` covering **both** shapes: agent provisioning
writes rich `github_app_installations` metadata (org name, repos), the web/setup paths today
only update `orgs.github_installation_id`. The primitive writes the rich table **and** keeps the
legacy `orgs` column in sync, plus the audit row. Agent provisioning keeps its single large
transaction (begins at agent_provision.go:45; do not break its atomicity); the web/setup callers wrap it in their own tx.

**Step 4:** `go test ./db ./handler` → PASS. **Step 5: Commit** —
`refactor(ingestion): one exported transaction-aware installation persistence`

### Task C2: Install branch ahead of `provider().ExchangeCode`, dedicated GitHub exchange

**Files:** `github_oauth.go` (`OAuthLoginCallback` install detection ~133-192, exchange at 216,
web branch `applyCombinedGitHubInstallation` ~425-472); reuse `gh.ExchangeOAuthCode`
(agent_setup.go:353); test in `handler`.

> **This task carries the E-gate regression test** (moved here from a separate phase, because a
> pre-C checkout would not contain the test). Write the WorkOS test in this task and require it
> to demonstrate a *behavioral* failure (the WorkOS provider's `ExchangeCode` invoked with the
> GitHub code) on the code **before** step 3, captured by asserting on a spy provider — not a
> compile error.

**Step 1:** Failing test, `AUTH_PROVIDER=workos` with a **spy provider**: an install-shaped
browser callback (HMAC `state` + `installation_id` + `setup_action=install` + `code`) must
complete without the spy's `ExchangeCode` ever being called with the GitHub code. Assert the
spy records **zero** GitHub-code exchanges.

**Step 2:** `go test ./handler -run WorkosInstallCallback -v` → FAIL: the spy records the GitHub
code going into WorkOS (today's behavior).

**Step 3:** When the callback is install-shaped, branch **before** `d.provider().ExchangeCode`:
exchange `code` via `gh.ExchangeOAuthCode(...)`, run the existing user↔installation ownership
binding (`ListUserInstallations`), then persist via `PersistInstallation`. **Correction:** the
web flow has **no requested repository**, so it does **not** get `AgentAuthCallback`'s repo-grant
check — that check is specific to the agent flow's known repo. Web-branch verification is app
verification + ownership binding only, matching current `applyCombinedGitHubInstallation`.

**Step 4:** `go test ./handler ./db` → PASS. **Step 5: Commit** —
`fix(ingestion): exchange install callbacks with github, not the identity provider`

### Task C3: Web branch on reserve/finalize + actor match, retry-safe

**Files:** `github_oauth.go` (web branch, and the `__auth_state` cookie clear at 171);
`callback_test.go`.

> Three review corrections: (a) `/auth/callback` is unauthenticated middleware-wise
> (routes.go:57), so the actor match is **branch-local**. **Two different cookies:** validate
> the CSRF nonce `__auth_state`, but resolve the **session user** from the access cookie
> **`AccessCookieName` (`__opslane_at`)** — `__auth_state` holds only the nonce. Require the
> resolved user equals the reserved state's `initiating_user_id`, and do a **fresh admin
> membership lookup** for the reserved target org. (b) The handler **deletes `__auth_state`
> before** the exchange (line 171); on a transient failure it must be **preserved** and the
> reservation **released**. (c) Validate both cookies **before** reserving the state.

**Step 1:** Failing tests: a transient GitHub failure mid-install **releases** the reservation
**and preserves `__auth_state`**, so the same link retries; a mismatched actor is rejected; a
non-admin actor for the reserved org is rejected (403).

**Step 2:** Run → FAIL.

**Step 3:** In the web branch, in order: **validate `__auth_state` + `__opslane_at` and the
actor/admin first**, then `ReserveOAuthLoginState` (returns token) → `gh.ExchangeOAuthCode` and
the ownership binding (external calls) → then in **one DB transaction**
`FinalizeOAuthLoginState(hash, token)` **and** `PersistInstallation(tx, …)`, so a stale/expired
reservation cannot mutate installation data (finalize rejects the token in the same tx that
would persist), and a persistence failure rolls back the finalize. On transient GitHub failure
`ReleaseOAuthLoginState(hash, token)` and **keep** the cookie. None of this applies to the UUID
agent path (B1).

**Step 4:** `go test ./handler ./db` → PASS. **Step 5: Commit** —
`fix(ingestion): retry-safe, actor-bound web install callback`

---

## Phase D — Org precedence, admin, and divergence diagnosis

### Task D1: Enforce Q3 org precedence

**Files:** `agent_provision.go:139` (mapping-first); `github_oauth.go:461` (web active-org
target); consider legacy `orgs.github_installation_id`; test in `db`.

**Step 1:** Failing test: an installation already mapped to org A + a web session passing
`target_org_id = B` → **rejected with a specific reason**, not re-homed. Agent sessions with no
target still use the GitHub home org. Legacy `orgs.github_installation_id` mappings participate
in precedence (assert an org that owns the install via the legacy column also wins).

**Step 2:** Run → FAIL.

**Step 3:** Enforce: existing installation→org mapping (rich table **or** legacy column) wins; a
conflicting explicit target fails loudly.

**Step 4:** `go test ./db` → PASS. **Step 5: Commit** —
`feat(ingestion): enforce installation org precedence`

### Task D2: Admin on the install routes; callback-time revalidation

**Files:** `routes.go` — the **actual** routes are `/github/setup` (156) and `/github/status`
(157); there is **no** "relink route" (CLI relink uses existing project/environment key APIs).
Test in `handler`.

**Step 1:** Failing test: a non-admin member on `/github/setup` and `/github/status` → 403; admin
→ ok. Follow the admin-middleware pattern (routes.go:103), but use `RequireRoleIfCloud`.

**Step 2:** Run → FAIL (routes require auth but no role).

**Step 3:** Add **`RequireRoleIfCloud("admin")`** — **not** `RequireRole("admin")`, which
returns 404 whenever cloud auth is disabled (auth.go:294-299) and would break these routes for
OSS/GitHub-auth deployments. `RequireRoleIfCloud` enforces the role only under cloud auth. The C3
web callback already does a fresh admin lookup for the reserved org; reference that, don't
duplicate.

**Step 4:** `go test ./handler` → PASS. **Step 5: Commit** —
`feat(ingestion): require org admin for github install routes`

### Task D3: Divergence diagnosis on the agent poll (P0, folded here)

**Files:** `agent_setup.go` (`AgentPoll`); the install paths write `installation_landed` via
`PersistInstallation` (already, from C1); test in `handler`.

**Step 1:** Failing test: a pending agent session whose repo appears in a recent
`installation_landed` row gets a `diagnosis` explaining an install landed elsewhere and naming
recovery. **Read-only** — no session mutation (auto-attach by repo was the API-key theft vector).

**Step 2:** Run → FAIL.

**Step 3:** Populate `diagnosis` from a read-only `installation_landed` lookup keyed on the
session's repo, returned only to the poll-token holder.

> **Prerequisite for real diagnosis (fold into C1/C2):** web/setup installs have no requested
> repo, so unless we fetch the installation's **granted repositories** and store them in
> `installation_landed.repos`, that column is empty and a real divergent web install is
> undiagnosable — the test would pass on a hand-seeded row while production stays broken. The
> install branch must call `ListInstallationRepos` (already used by the agent flow) and pass the
> repo list to `PersistInstallation`, **without** enforcing an agent-style repo-grant check.

**Step 4:** `go test ./handler` → PASS. **Step 5: Commit** —
`feat(ingestion): explain divergent installs on the agent poll`

---

## Phase E — Prove it under WorkOS

### Task E1: Both flows complete under `AUTH_PROVIDER=workos`

**Files:** extend `agent_callback_integration_test.go` or add `workos_install_integration_test.go`
(`package handler`, `githubOAuthTestPool`).

**Step 1:** One integration test, `AUTH_PROVIDER=workos`, driving **both** the agent (UUID) and
web (HMAC) installs end to end — agent to a provisioned project+key, web to a stored
installation — asserting (via the spy provider) neither routes a GitHub code through WorkOS and
both persist via `PersistInstallation` with an audit row.

**Step 2:** Run on the completed Phases A–D → PASS. (The *behavioral* pre-fix failure is already
locked by the C2 spy test; this is the full-flow acceptance.)

**Step 3:** Full gate `go build ./... && go test ./...`; apply migrations to a disposable DB and
run `scripts/check-migration-reapply.sh`.

**Step 4:** Record the transcript here. **Step 5: Commit** —
`test(ingestion): workos install completes for both agent and web flows`

---

## Phase F — Convert the Setup URL handler (code)

### Task F1: `GitHubSetupCallback` becomes non-mutating

**Files:** `github_oauth.go:506` (`GitHubSetupCallback` — note it is defined at **506**, not
504); test in `handler`.

> Split out from the runbook per review: this is **tested code**, not documentation. After the
> toggle is enabled (Phase G) this handler can no longer receive a usable callback, so it must
> stop mutating.

**Step 1:** Failing test: `GitHubSetupCallback` performs **no** installation write and returns a
landing response (explain + redirect to the dashboard).

**Step 2:** Run → FAIL (it still writes today).

**Step 3:** Replace its mutation with a non-mutating landing response. Leave it deletable a
release later.

**Step 4:** `go test ./handler` → PASS. **Step 5: Commit** —
`refactor(ingestion): setup-url callback becomes a non-mutating landing page`

---

## Phase G — Activation runbook (human step, not code)

Create `docs/runbooks/activate-agent-onboarding.md`. Ordered, reversible, and explicit that two
independent toggles exist with **separate** rollbacks:

1. Confirm Phase E green on the deployed build, and Task F1 shipped.
2. **GitHub App toggle:** enable "Request user authorization (OAuth) during installation."
   Routes every install to the shared callback and disables the Setup URL — safe now (Phase C
   handles it under WorkOS, F1 made the old handler inert). **Rollback: disable the toggle.**
3. **Product feature flag:** un-draft `docs/quickstart/agent.md` / flip the agent-onboarding
   flag. **Rollback: re-draft / re-flip.**
4. Note which toggle changes which behavior; never flip either from CI.

**Commit** — `docs: activation runbook for agent onboarding`

---

## Before merge

```bash
pnpm install --frozen-lockfile
pnpm -r build
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```
Apply the new migrations to a disposable DB and run `scripts/check-migration-reapply.sh`.

**Acceptance criteria:**
1. The C2 spy test shows a WorkOS-exchange **behavioral** failure on pre-fix code and passes
   after; E1 completes both flows under WorkOS.
2. No install path calls `d.provider().ExchangeCode` with a GitHub code.
3. `authorization_denied` reachable (B1).
4. All three install paths persist through exported `PersistInstallation` with the audit row.
5. `/github/setup` and `/github/status` require admin.
6. Reserve/finalize/release is token-guarded; transient failure preserves `__auth_state` and
   releases the reservation.
7. The toggle flip exists only in the runbook.

---

## What this unblocks

A hosted (WorkOS) user can complete GitHub authorization, making the built P1 reporting flow
reachable end to end. Agent onboarding can be activated; P3's `onboard` experience integrates
against a working callback.
