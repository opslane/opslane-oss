# Cloud auth with WorkOS — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add WorkOS-backed cloud auth (social + email now, SAML later) and multi-org membership as a cloud-gated feature, without breaking the OSS single-org schema or forcing self-hosters onto WorkOS.

**Architecture:** A pluggable `AuthProvider` interface (OSS = GitHub/password, cloud = WorkOS) chosen at boot by explicit `AUTH_PROVIDER`. Local Postgres stays the source of truth; WorkOS is identity-only. Active org is per-device session state carried in the JWT and pinned on the refresh token. Multi-org tables ship everywhere but are written/read only on the cloud path ("ship-but-gate").

**Tech Stack:** Go 1.24, chi, pgx/v5; hand-rolled HS256 JWT (`packages/ingestion/auth`); WorkOS official SDK `github.com/workos/workos-go`; Vue 3 dashboard.

**Design doc:** `docs/plans/2026-07-16-cloud-auth-workos-design.md`

## Conventions for every task

- Work from `packages/ingestion` unless a path says otherwise.
- Go tests: package `<pkg>_test`, get a pool with `testPool(t)` (db) — see `db/testhelper_test.go`. Seed tenants with `q.CreateOrg` / `q.CreateProject` / `q.CreateEnvironment` and register `t.Cleanup(func(){ cleanupTenant(t, pool, org.ID) })`.
- Migrations: append-only, next number is **009** (highest existing is `008`; note `006` is duplicated). Every statement uses `IF NOT EXISTS` / guarded DDL — `scripts/run-migrations.sh` reapplies every file on every boot. The existing harness `db/migrations_test.go` auto-tests fresh apply, reapply-idempotency, and roll-forward, so a new migration file is covered once it exists.
- Per-task verify: `go test ./db ./handler ./auth` while iterating; `go build ./... && go test ./...` before the phase-closing commit.
- Commit after each task with the message shown. Small, frequent commits.

---

## PHASE 1 — `auth_identities` table + GitHub login uses it (lands on main; OSS + cloud)

Generalizes today's `users.github_id` into a provider-agnostic identity map. Behavior stays identical; this is the seam future providers plug into.

### Task 1.1: Migration for `auth_identities`

**Files:**
- Create: `db/migrations/009_auth_identities.sql`

**Step 1: Write the migration**
```sql
-- 009_auth_identities.sql — provider-agnostic identity map.
-- Append-only after 001-008. Idempotent: run-migrations.sh reapplies every file.
-- Generalizes users.github_id so new IdPs (workos) are rows, not columns.
CREATE TABLE IF NOT EXISTS auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);

-- Backfill existing GitHub identities. Idempotent via ON CONFLICT.
INSERT INTO auth_identities (user_id, provider, provider_subject)
SELECT id, 'github', github_id::text FROM users WHERE github_id IS NOT NULL
ON CONFLICT (provider, provider_subject) DO NOTHING;
```

**Step 2: Run the migration test to verify it applies + reapplies clean**

Run: `go test ./db -run TestMigrations -v`
Expected: PASS (fresh apply, reapply-idempotent, roll-forward all green). If `psql` is absent the test skips — then apply manually to a disposable DB per AGENTS.md.

**Step 3: Commit**
```bash
git add db/migrations/009_auth_identities.sql
git commit -m "feat(db): add auth_identities table with github backfill"
```

### Task 1.2: Identity queries (write + lookup)

**Files:**
- Modify: `db/queries.go` (add near the user queries)
- Test: `db/auth_identities_test.go` (create)

**Step 1: Write the failing test**
```go
package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestUpsertAndLookupIdentity(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "ident-test")
	if err != nil { t.Fatalf("CreateOrg: %v", err) }
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	user, err := q.CreateUserGitHub(ctx, org.ID, "id@example.com", "Id User", 4242, "iduser", "")
	if err != nil { t.Fatalf("CreateUserGitHub: %v", err) }

	if err := q.UpsertIdentity(ctx, user.ID, "workos", "user_abc"); err != nil {
		t.Fatalf("UpsertIdentity: %v", err)
	}
	// idempotent
	if err := q.UpsertIdentity(ctx, user.ID, "workos", "user_abc"); err != nil {
		t.Fatalf("UpsertIdentity (repeat): %v", err)
	}

	gotUserID, err := q.GetUserIDByIdentity(ctx, "workos", "user_abc")
	if err != nil { t.Fatalf("GetUserIDByIdentity: %v", err) }
	if gotUserID != user.ID {
		t.Fatalf("identity resolved to %q, want %q", gotUserID, user.ID)
	}

	// unknown identity returns "" and no error
	missing, err := q.GetUserIDByIdentity(ctx, "workos", "nope")
	if err != nil { t.Fatalf("GetUserIDByIdentity(missing): %v", err) }
	if missing != "" { t.Fatalf("expected empty for missing identity, got %q", missing) }
}
```

**Step 2: Run to verify it fails**

Run: `go test ./db -run TestUpsertAndLookupIdentity -v`
Expected: FAIL (compile error: `q.UpsertIdentity` / `q.GetUserIDByIdentity` undefined).

**Step 3: Implement the queries** (in `db/queries.go`)
```go
// === Auth identities ===

// UpsertIdentity records (provider, subject) -> user, idempotent on re-login.
func (q *Queries) UpsertIdentity(ctx context.Context, userID, provider, subject string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO auth_identities (user_id, provider, provider_subject)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (provider, provider_subject) DO NOTHING`,
		userID, provider, subject)
	if err != nil {
		return fmt.Errorf("upsert identity: %w", err)
	}
	return nil
}

// GetUserIDByIdentity returns the user_id for a (provider, subject), or "" if none.
func (q *Queries) GetUserIDByIdentity(ctx context.Context, provider, subject string) (string, error) {
	var userID string
	err := q.pool.QueryRow(ctx,
		`SELECT user_id FROM auth_identities WHERE provider = $1 AND provider_subject = $2`,
		provider, subject).Scan(&userID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get user by identity: %w", err)
	}
	return userID, nil
}
```

**Step 4: Run to verify it passes**

Run: `go test ./db -run TestUpsertAndLookupIdentity -v`
Expected: PASS.

**Step 5: Commit**
```bash
git add db/queries.go db/auth_identities_test.go
git commit -m "feat(db): identity upsert + lookup queries"
```

### Task 1.3: GitHub login writes/reads `auth_identities`

Wire the existing GitHub provisioning to also write an identity row and to resolve by identity first. Keep `github_id` writes as-is (fallback during rollout).

**Files:**
- Modify: `handler/github_oauth.go:133-176` (the upsert block)
- Test: `handler/github_oauth_test.go` (add a case)

**Step 1: Write the failing test** — after a fresh GitHub login, an `auth_identities` row exists for `('github', <githubID>)` resolving to the created user. Model it on the existing tests in `handler/github_oauth_test.go` (reuse their callback harness). Assert:
```go
gotUserID, err := q.GetUserIDByIdentity(ctx, "github", strconv.FormatInt(ghID, 10))
if err != nil || gotUserID == "" {
	t.Fatalf("expected github identity row, got id=%q err=%v", gotUserID, err)
}
```

**Step 2: Run to verify it fails**

Run: `go test ./handler -run TestGitHub -v`
Expected: FAIL (no identity row written yet).

**Step 3: Implement** — in the three provisioning branches (existing-github-user, linked, new-user) of `handler/github_oauth.go`, after `user` is resolved, add:
```go
if err := d.Queries.UpsertIdentity(r.Context(), user.ID, "github", strconv.FormatInt(ghUser.ID, 10)); err != nil {
	slog.Error("upsert github identity failed", "error", err, "user_id", user.ID)
	// non-fatal during rollout: github_id column remains the fallback
}
```
(`strconv` is already imported in this file.)

**Step 4: Run to verify it passes**

Run: `go test ./handler -run TestGitHub -v`
Expected: PASS.

**Step 5: Commit**
```bash
git add handler/github_oauth.go handler/github_oauth_test.go
git commit -m "feat(auth): github login writes auth_identities row"
```

---

## PHASE 2 — Centralize the project-access check, preserving both branches (lands on main; OSS + cloud)

`verifyProjectAccess` (`handler/read_api.go:141`) already enforces the tenant boundary from ~27 call sites. This phase makes the enforcement structural (a chokepoint you cannot forget to call) **without changing either branch**. The SDK branch's exact-project match is a hard isolation boundary — do not loosen it to org-only.

### Task 2.1: Regression test — SDK key cannot reach a sibling project

Lock the current SDK-isolation behavior with a test *before* refactoring, so the refactor can't regress it.

**Files:**
- Test: `handler/read_api_test.go` (add)

**Step 1: Write the test**
```go
func TestSDKKeyCannotAccessSiblingProject(t *testing.T) {
	// Two projects in the SAME org. An API key scoped to project A must be
	// rejected (403) when used against project B's route.
	// Build the request with ctxProjectID = projectA (SDK path), then call a
	// handler guarded by verifyProjectAccess with projectID = projectB.
	// Assert HTTP 403 and body "project mismatch".
}
```
Use the existing read_api test harness (see other tests in this file for how they set `ctxProjectID` / route params). If no helper sets `ctxProjectID` directly, drive it through `AuthenticateSDK` with a real API key created via `q.CreateAPIKey` for project A.

**Step 2: Run to verify it passes NOW (guard test, documents current behavior)**

Run: `go test ./handler -run TestSDKKeyCannotAccessSiblingProject -v`
Expected: PASS against current code. (If it fails, stop — the isolation is already broken and that's a separate bug to raise.)

**Step 3: Commit**
```bash
git add handler/read_api_test.go
git commit -m "test(auth): lock SDK key cannot access sibling project"
```

### Task 2.2: Extract a `RequireProjectAccess` middleware wrapping the existing helper

**Files:**
- Modify: `handler/auth.go` (add middleware), `handler/routes.go` (apply on `/projects/{projectID}/...` groups)
- Test: `handler/auth_middleware_test.go` (add)

**Step 1: Write the failing test** — a request through `RequireProjectAccess` with a mismatched SDK project returns 403; with a matching SDK project passes; with a session whose org owns the project passes; with a session whose org does not own it returns 403. Reuse the branch logic already proven in `verifyProjectAccess`.

**Step 2: Run to verify it fails**

Run: `go test ./handler -run TestRequireProjectAccess -v`
Expected: FAIL (`RequireProjectAccess` undefined).

**Step 3: Implement** — factor the body of `verifyProjectAccess` into a boolean core `checkProjectAccess(ctx, projectID) (ok bool, status int, msg string)` (both branches unchanged), then:
```go
// RequireProjectAccess enforces the tenant boundary for {projectID} routes.
// SDK auth: projectID must equal the authenticated project (exact isolation).
// Session auth: the project's org must equal the active org.
func (d *Dependencies) RequireProjectAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		projectID := chi.URLParam(r, "projectID")
		ok, status, msg := d.checkProjectAccess(r.Context(), projectID)
		if !ok {
			writeJSONError(w, status, msg)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```
Keep `verifyProjectAccess` as a thin wrapper over `checkProjectAccess` so the ~27 existing call sites stay working (DRY, no churn). Apply `RequireProjectAccess` on the `/projects/{projectID}` route groups in `routes.go` as defense-in-depth.

**Step 4: Run to verify it passes**

Run: `go test ./handler -run 'TestRequireProjectAccess|TestSDKKeyCannotAccessSiblingProject' -v`
Expected: PASS (both, including the Phase-2.1 guard).

**Step 5: Commit**
```bash
git add handler/auth.go handler/routes.go handler/auth_middleware_test.go
git commit -m "refactor(auth): centralize project-access check as middleware, both branches intact"
```

---

## PHASE 3 — `AuthProvider` seam + explicit `AUTH_PROVIDER` + `/auth/login` alias (lands on main; OSS + cloud)

Introduce the interface and wrap today's GitHub logic as `GithubProvider`. Behavior identical. No WorkOS yet.

### Task 3.1: Define the `AuthProvider` interface + `Identity`

**Files:**
- Create: `auth/provider.go`
- Test: `auth/provider_test.go`

**Step 1: Write the failing test** — a compile-level test that a `stubProvider` satisfies `AuthProvider` and returns an `Identity` with `EmailVerified`:
```go
package auth_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

type stubProvider struct{}

func (stubProvider) Name() string { return "stub" }
func (stubProvider) AuthorizeURL(req auth.AuthRequest) string { return "https://idp/authorize?state=" + req.State }
func (stubProvider) ExchangeCode(ctx context.Context, code string) (auth.Identity, error) {
	return auth.Identity{Provider: "stub", ProviderSubject: "s1", Email: "a@b.com", EmailVerified: true}, nil
}
func (stubProvider) SupportsLocalPasswordForm() bool { return false }

func TestAuthProviderInterface(t *testing.T) {
	var p auth.AuthProvider = stubProvider{}
	id, err := p.ExchangeCode(context.Background(), "code")
	if err != nil || !id.EmailVerified || id.Email != "a@b.com" {
		t.Fatalf("unexpected identity: %+v err=%v", id, err)
	}
}
```

**Step 2: Run to verify it fails**

Run: `go test ./auth -run TestAuthProviderInterface -v`
Expected: FAIL (types undefined).

**Step 3: Implement** (`auth/provider.go`)
```go
package auth

import "context"

// AuthRequest carries the parameters needed to start a login. RedirectURI must
// be an allowlisted, configured origin — never derived from a request Host header.
type AuthRequest struct {
	State       string
	RedirectURI string
}

// Identity is the normalized result of authenticating with a provider.
type Identity struct {
	Provider        string
	ProviderSubject string
	Email           string
	EmailVerified   bool // account-linking gate: link by email only when true
	Name            string
	AvatarURL       string
}

// AuthProvider abstracts the identity provider (GitHub/password for OSS,
// WorkOS for cloud). Local Postgres remains the source of truth; a provider
// only proves identity.
type AuthProvider interface {
	Name() string
	AuthorizeURL(req AuthRequest) string
	ExchangeCode(ctx context.Context, code string) (Identity, error)
	// SupportsLocalPasswordForm reports whether /oauth/authorize should render
	// the local CLI password form (OSS) or route the CLI through the external
	// IdP and mint a local auth code (cloud).
	SupportsLocalPasswordForm() bool
}
```

**Step 4: Run to verify it passes**

Run: `go test ./auth -run TestAuthProviderInterface -v`
Expected: PASS.

**Step 5: Commit**
```bash
git add auth/provider.go auth/provider_test.go
git commit -m "feat(auth): AuthProvider interface + Identity type"
```

### Task 3.2: Explicit `AUTH_PROVIDER` selection, fail-closed

**Files:**
- Modify: `main.go` (env read + validation, near lines 63-100)
- Test: `main_test.go` (create) or a small `handler`-level config helper with a test

**Step 1: Write the failing test** — put the selection logic in a testable pure function `handler.SelectAuthProvider(cfg)` (or `auth.SelectAuthProvider`) rather than inline in `main`, and test:
- `AUTH_PROVIDER=github` → GitHub provider, no error.
- `AUTH_PROVIDER=workos` with empty `WORKOS_API_KEY` → error (fail closed).
- `AUTH_PROVIDER=workos` with keys present → WorkOS provider (can be a nil-safe stub until Phase 5).
- unset/empty `AUTH_PROVIDER` → defaults to `github` (OSS default), no error.
```go
func TestSelectAuthProviderFailsClosed(t *testing.T) {
	_, err := SelectAuthProvider(AuthConfig{Provider: "workos"}) // no keys
	if err == nil {
		t.Fatal("expected error when AUTH_PROVIDER=workos but WorkOS keys missing")
	}
}
```

**Step 2: Run to verify it fails**

Run: `go test ./... -run TestSelectAuthProvider -v`
Expected: FAIL (undefined).

**Step 3: Implement** the `SelectAuthProvider` function; call it from `main.go` and **fatal on error** before the server starts. Log one line naming the active provider.

**Step 4: Run to verify it passes**

Run: `go test ./... -run TestSelectAuthProvider -v`
Expected: PASS.

**Step 5: Commit**
```bash
git add main.go *_test.go
git commit -m "feat(auth): explicit AUTH_PROVIDER selection, fail-closed on partial config"
```

### Task 3.3: `/auth/login` route with `/auth/github` compatibility redirect

**Files:**
- Modify: `handler/routes.go` (add `/auth/login`; keep `/auth/github` as a 302 to `/auth/login`)
- Modify: `packages/dashboard/src/views/Login.vue:3` (`/auth/github` → `/auth/login`)
- Test: `handler/routes` test or `handler/github_oauth_test.go`

**Step 1: Write the failing test** — `GET /auth/github` returns 302 to `/auth/login`; `GET /auth/login` starts the provider flow (302 to the provider authorize URL).

**Step 2: Run to verify it fails** → **Step 3: Implement** → **Step 4: Run to verify it passes.**

**Step 5: Commit**
```bash
git add handler/routes.go packages/dashboard/src/views/Login.vue handler/*_test.go
git commit -m "feat(auth): /auth/login route with /auth/github compatibility redirect"
```

### Phase 3 close — full gate

Run: `go build ./... && go test ./...` and `(cd ../dashboard && pnpm build)`
Expected: all green. **Phases 1-3 are safe to land on `main`.**

---

## PHASE 4 — Ship-but-gate the multi-org schema + org-on-refresh-token (OSS unchanged)

Adds the cloud tables (unused by OSS) and threads the active org onto the refresh token so a future org-switch survives refresh. For OSS this stores/reads the user's single org — identical result, near-zero risk.

### Task 4.1: Migration for memberships, invitations, workos_org_id, refresh org

**Files:**
- Create: `db/migrations/010_multi_org.sql`

**Step 1: Write the migration**
```sql
-- 010_multi_org.sql — cloud-gated multi-org (memberships, invitations),
-- WorkOS org mapping, and active-org session state on refresh tokens.
-- Append-only, idempotent. OSS ships these tables but does not write them.

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id  UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role    TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id),
  CHECK (role IN ('owner','admin','member'))
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org  ON memberships(org_id);

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS workos_org_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_workos_org_id
  ON orgs(workos_org_id) WHERE workos_org_id IS NOT NULL;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES orgs(id);

CREATE TABLE IF NOT EXISTS org_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  invited_by UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invitations_outstanding
  ON org_invitations(org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

**Step 2: Verify apply + idempotency**

Run: `go test ./db -run TestMigrations -v`
Expected: PASS.

**Step 3: Commit**
```bash
git add db/migrations/010_multi_org.sql
git commit -m "feat(db): ship-but-gate multi-org schema + refresh org_id"
```

### Task 4.2: Persist + return active org on refresh tokens

**Files:**
- Modify: `db/queries.go` — `StoreRefreshToken` gains an `orgID` param; `ConsumeRefreshToken` returns `orgID`.
- Modify: `handler/auth_handlers.go` — `issueTokenPair` / `issueTokenPairCookie` pass their `orgID`; `Refresh` mints from the returned `orgID`, falling back to `user.OrgID` when empty.
- Test: `db/queries_test.go` (extend refresh-token tests)

**Step 1: Write the failing test**
```go
func TestRefreshTokenCarriesOrg(t *testing.T) {
	pool := testPool(t); q := db.New(pool); ctx := context.Background()
	org, _ := q.CreateOrg(ctx, "rt-org")
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	user, _ := q.CreateUserGitHub(ctx, org.ID, "rt@x.com", "RT", 91, "rt", "")

	raw, hash, _ := auth.GenerateRefreshToken()
	fam := "fam-1"
	if err := q.StoreRefreshToken(ctx, user.ID, hash, fam, org.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("StoreRefreshToken: %v", err)
	}
	gotUser, gotFam, gotOrg, err := q.ConsumeRefreshToken(ctx, auth.HashToken(raw))
	if err != nil { t.Fatalf("ConsumeRefreshToken: %v", err) }
	if gotUser != user.ID || gotFam != fam || gotOrg != org.ID {
		t.Fatalf("got (%s,%s,%s) want (%s,%s,%s)", gotUser, gotFam, gotOrg, user.ID, fam, org.ID)
	}
}
```

**Step 2: Run to verify it fails**

Run: `go test ./db -run TestRefreshTokenCarriesOrg -v`
Expected: FAIL (signature mismatch: `StoreRefreshToken`/`ConsumeRefreshToken` arity).

**Step 3: Implement**
- `StoreRefreshToken(ctx, userID, tokenHash, familyID, orgID string, expiresAt time.Time)` — insert `org_id`.
- `ConsumeRefreshToken(ctx, tokenHash) (userID, familyID, orgID string, err error)` — add `org_id` to the `RETURNING` and to the reuse-detection path.
- Update all call sites: `issueTokenPair` / `issueTokenPairCookie` already receive `orgID` — pass it through. In `Refresh` (`auth_handlers.go`), use the consumed `orgID`; if `""`, fall back to `user.OrgID`. Update the family-reuse branch signature too.

**Step 4: Run to verify it passes**

Run: `go test ./db ./handler -run 'Refresh|TokenReuse|RefreshTokenCarriesOrg' -v`
Expected: PASS (existing refresh + reuse tests still green with the new arity).

**Step 5: Commit**
```bash
git add db/queries.go handler/auth_handlers.go db/queries_test.go
git commit -m "feat(auth): pin active org on refresh token; refresh mints from it"
```

### Task 4.3: Membership + invitation queries (used by cloud in Phase 5)

**Files:**
- Modify: `db/queries.go`
- Test: `db/memberships_test.go` (create)

**Step 1: Write the failing test** covering: `CreateMembership`, `ListMembershipsByUser` (returns org_id + role), `GetMembership(userID, orgID)` returns role or not-found, `DeleteMembership` removes it. Include the role hierarchy helper test: `RoleSatisfies("owner","admin") == true`, `RoleSatisfies("member","admin") == false`.

**Step 2: Run to verify it fails** → **Step 3: Implement** the queries plus a pure `RoleSatisfies(have, need string) bool` in `auth` (owner⊇admin⊇member). **Step 4: passes.**

**Step 5: Commit**
```bash
git add db/queries.go db/memberships_test.go auth/roles.go auth/roles_test.go
git commit -m "feat(db): membership + invitation queries; role hierarchy helper"
```

### Phase 4 close — full gate

Run: `go build ./... && go test ./...`
Expected: green. OSS behavior unchanged (no memberships written; refresh falls back to `users.org_id`).

---

## PHASE 5 — WorkOS provider, transactional cloud provisioning, membership re-check, switch-org (cloud only)

> **PREREQUISITE (human):** Create the WorkOS project, enable GitHub + Google + email in AuthKit, set the redirect URI to the configured `/auth/callback` origin, and provide `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` in the cloud environment. Verify exact SDK call shapes against `github.com/workos/workos-go` (the tasks below name the operations; confirm signatures at implementation time — do not guess).

### Task 5.1: `WorkOSProvider` implementing `AuthProvider`

**Files:**
- Create: `auth/workos.go`, `auth/workos_test.go`

**Step 1: Write the failing test** — with the WorkOS HTTP client faked (inject an interface so no network in unit tests), `ExchangeCode` maps a WorkOS authentication response to `Identity{Provider:"workos", ProviderSubject:<workos user id>, Email, EmailVerified:<from response>, Name, AvatarURL}`. Assert `EmailVerified` is carried through and `AuthorizeURL` includes state + configured redirect.

**Step 2-4:** implement `WorkOSProvider` over the official SDK (AuthKit authorization URL + code exchange); map fields; `SupportsLocalPasswordForm() == false`. Keep all WorkOS calls behind a small internal interface so tests inject a fake.

**Step 5: Commit**
```bash
git add auth/workos.go auth/workos_test.go
git commit -m "feat(auth): WorkOSProvider (AuthKit) implementing AuthProvider"
```

### Task 5.2: Transactional cloud provisioning

**Files:**
- Modify: `db/queries.go` (add a `ProvisionFromIdentity` that runs in one `pgx.Tx`), `handler/github_oauth.go` / a shared callback handler to call the provider-driven path.
- Test: `db/provisioning_test.go`

**Step 1: Write the failing tests** (the concurrency/idempotency guarantees the reviewer required):
- New identity → creates user + personal org + one `owner` membership + identity row, all present.
- Repeated/replayed callback with the same identity → still exactly one user, one org, one membership (idempotent).
- Existing verified-email user, new provider identity → links identity, no new org.
- **Unverified email cannot link** — `EmailVerified:false` against an existing email must NOT link to the existing account (assert no membership/identity is attached to the pre-existing user).

**Step 2-4:** implement `ProvisionFromIdentity(ctx, tx, identity) (userID, orgID string, err error)`:
- `SELECT ... FOR UPDATE` / `ON CONFLICT DO NOTHING` on `auth_identities` so concurrent first-logins converge to one row.
- Link by email only when `identity.EmailVerified`.
- On new user (cloud): create org, user, `owner` membership, identity — same tx.
Wrap the whole thing in `pool.BeginTx`; on any error, roll back (no orphan orgs).

**Step 5: Commit**
```bash
git add db/queries.go handler/*.go db/provisioning_test.go
git commit -m "feat(auth): transactional cloud provisioning (idempotent, verified-email gate)"
```

### Task 5.3: Session middleware loads current role from membership (cloud)

**Files:**
- Modify: `handler/auth.go` — a cloud-only decorator (or a branch guarded by provider mode) that, after `AuthenticateSession`, loads the **current** membership for `(ctxUserID, ctxOrgID)`, rejects if absent (member removed), and puts the current `role` in context (not the JWT role).
- Test: `handler/auth_middleware_test.go`

**Step 1: Write the failing tests:**
- Membership removed → next request 401/403 within the access-token TTL (not after expiry).
- Role downgraded admin→member → `RequireRole("admin")` now rejects immediately.

**Step 2-4:** implement; short in-process cache acceptable but must honor removal/downgrade quickly (keep TTL ≤ a few seconds, or skip cache initially — measure before optimizing).

**Step 5: Commit**
```bash
git add handler/auth.go handler/auth_middleware_test.go
git commit -m "feat(auth): load current role from membership row, not stale JWT"
```

### Task 5.4: `POST /auth/switch-org`

**Files:**
- Modify: `handler/auth_handlers.go` (handler), `handler/routes.go` (route, session-authed)
- Test: `handler/switch_org_test.go`

**Step 1: Write the failing tests:**
- Switch to an org the user is a member of → new JWT + new refresh token, refresh token's `org_id` = target; cookies rotated; `users.org_id` unchanged.
- Switch to an org the user is NOT a member of → 403, no token minted.
- **Refresh after switch preserves the switched org** (integration: switch, then `/auth/refresh`, assert JWT org = switched org).

**Step 2-4:** implement: verify membership, then reissue via `issueTokenPairCookie` (cookie) / `issueTokenPair` (CLI) with the target `orgID`. Do not touch `users.org_id`.

**Step 5: Commit**
```bash
git add handler/auth_handlers.go handler/routes.go handler/switch_org_test.go
git commit -m "feat(auth): POST /auth/switch-org rotates tokens, pins active org"
```

### Task 5.5: Cloud CLI login through AuthKit

**Files:**
- Modify: `handler/auth_handlers.go` — when `provider.SupportsLocalPasswordForm()` is false, `/oauth/authorize` skips the password form, stashes the PKCE request, and redirects through AuthKit; the `/auth/callback` handler, when it detects a pending CLI PKCE request, issues the existing local single-use auth code back to the localhost redirect URI.
- Test: `handler/cli_cloud_login_test.go`

**Step 1: Write the failing test** — cloud CLI flow for a WorkOS-only user (no password): `/oauth/authorize` with PKCE params → redirect to AuthKit (not the HTML form) → simulated AuthKit callback → local auth code issued to the localhost `redirect_uri` → `/oauth/token` exchanges it for a JWT. Assert no password form is ever rendered and the localhost redirect allowlist still holds.

**Step 2-4:** implement the provider-branched `/oauth/authorize` and the callback bridge. Preserve `isAllowedRedirectURI` (localhost-only) for the final CLI redirect. OSS path (password form) unchanged.

**Step 5: Commit**
```bash
git add handler/auth_handlers.go handler/cli_cloud_login_test.go
git commit -m "feat(auth): cloud CLI login routes PKCE through AuthKit"
```

### Task 5.6: Callback hardening

**Files:**
- Modify: the `/auth/callback` handler
- Test: `handler/callback_test.go`

**Step 1: Write the failing tests** for: provider `error`/denial query params → clean 4xx (no crash); code replay → rejected (single-use); state-cookie path scoping honored; redirect origin taken from configured allowlist, never the request `Host` header.

**Step 2-4:** implement. **Step 5: Commit**
```bash
git add handler/*.go handler/callback_test.go
git commit -m "fix(auth): harden OAuth callback (denial, replay, state path, redirect allowlist)"
```

---

## PHASE 6 — Dashboard org-switcher + invitations UI (cloud only)

### Task 6.1: `/auth/me` returns memberships + active org

**Files:**
- Modify: `handler/auth_handlers.go` (the `/auth/me` handler) to include `memberships: [{org_id, name, role}]` and `active_org_id`.
- Test: `handler/auth_handlers_test.go`

TDD as above (failing test asserting the JSON shape → implement → pass → commit).

### Task 6.2: Org-switcher component

**Files:**
- Create: `packages/dashboard/src/components/OrgSwitcher.vue`
- Modify: header/layout to mount it; `src/api.ts` to add `switchOrg(orgID)` calling `POST /auth/switch-org` with `credentials:'include'`, then reload.
- Test: dashboard Vitest colocated in `__tests__` (mock the API).

Verify: `(cd packages/dashboard && pnpm build && pnpm test)`. Commit.

### Task 6.3: Invitations UI (create, list, accept)

**Files:**
- Backend: invitation create/list/revoke/accept handlers + routes (session-authed, `RequireRole("admin")`), backed by the Phase-4 queries; enforce single-use + email-bound acceptance transactionally.
- Frontend: an invitations panel; an `/invite/accept?token=…` view.
- Tests: Go handler tests (single-use, email-bound, expired rejected) + dashboard Vitest.

TDD per task; commit each.

### Phase 6 close — full repo gate (per AGENTS.md)

Run:
```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```
Then the live smoke: apply migrations, `scripts/seed-e2e.sql`, log in via OSS GitHub path AND cloud WorkOS path in staging, confirm existing user still authorized (no OSS regression) and a WorkOS-only user can log in + switch orgs.

---

## Test inventory (maps to design §7 — must all exist by end of Phase 5/6)

- [ ] Refresh after an org switch preserves the selected org (Task 5.4)
- [ ] Two sessions for one user hold different active orgs (Task 5.4 / 4.2)
- [ ] Membership removal + role downgrade take effect immediately (Task 5.3)
- [ ] SDK key cannot access a sibling project in the same org (Task 2.1)
- [ ] Cloud CLI login works for a WorkOS-only user (Task 5.5)
- [ ] Unverified email cannot link an existing account (Task 5.2)
- [ ] Concurrent / replayed callbacks create exactly one identity + membership (Task 5.2)
- [ ] Invitation acceptance is single-use and email-bound (Task 6.3)
- [ ] Migrations run on clean + representative DBs and reapply idempotently (Tasks 1.1, 4.1 via harness)
- [ ] Partial WorkOS config fails boot closed (Task 3.2)

## Rollback notes

- Phases 1-4 are additive; `users.org_id` and `github_id` remain the OSS truth. Reverting Phase 5-6 (cloud) leaves OSS fully functional.
- Removing `users.org_id` is explicitly deferred (out of scope) until multi-org is proven in cloud.
