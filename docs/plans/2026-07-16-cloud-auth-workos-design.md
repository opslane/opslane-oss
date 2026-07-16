# Cloud auth with WorkOS — design

Date: 2026-07-16
Status: Design approved (revised after code review), not yet implemented
Branch context: `abhishekray07/auth`

## Problem

The OSS version has rudimentary auth: hand-rolled HS256 JWT, a custom OAuth/PKCE
server for the CLI, and GitHub OAuth for the dashboard. Users belong to exactly
one org (`users.org_id`, no membership table). The cloud version needs stronger,
lower-maintenance auth (social + email now, enterprise SAML later) that we do not
want to build or operate ourselves. We buy that from **WorkOS**.

Hard constraints:
- Do not break the existing DB schema (additive only).
- Do not force self-hosters to create a WorkOS account.
- Keep OSS simple: self-host stays one-user-one-org.

## Decisions

1. **Multi-org membership is a cloud-gated feature.** OSS keeps today's
   one-user-one-org model on `users.org_id`, untouched. Cloud adds a
   `memberships` table, an org-switcher, and invitations. The tables ship in
   the schema everywhere but are **written/read only on the cloud path**
   ("ship-but-gate"). OSS never adopts memberships, so there is no OSS
   dual-write migration.
2. **Local Postgres is the source of truth** for users, orgs, memberships, and
   invitations — for both OSS and cloud. WorkOS is **identity-only**: it proves
   "this is the person, email verified." The organization WorkOS may return in
   its auth response is **ignored** for standard login. On any conflict, local
   wins.
3. **SSO scope: social + email at launch, SAML later.** WorkOS AuthKit for
   GitHub/Google/email now. Per-org SAML fits the schema via a nullable
   `orgs.workos_org_id`. **SCIM/directory provisioning is NOT free-of-migration**
   — it introduces directory lifecycle events, directory users/groups, and
   per-org integration state, and will need its own tables when it lands. For
   SCIM-enabled orgs, WorkOS's directory becomes authoritative for *that org's*
   membership, mirrored in via webhooks. Scoped, later, not day-one.
4. **Pluggable auth provider.** A Go `AuthProvider` interface; OSS ships the
   existing GitHub/password provider, cloud configures a WorkOS provider.
   Selected at boot by explicit `AUTH_PROVIDER` config (below). Same tables,
   same core routes. OSS needs no WorkOS account.
5. **Keep our own JWT + rotating refresh token.** WorkOS only handles the login
   handshake. On callback we mint our own JWT and refresh token. `auth.go`
   middleware and cookies stay. Active org is modeled as **per-device session
   state** (below), not a property of the user.

## Guiding principle

The IdP never owns the user table. Our `users` / `orgs` tables stay the source of
truth; WorkOS proves identity, and we map external identity → local user row via a
stable subject id. This generalizes today's `users.github_id`. Treat the system as
three distinct layers, kept separate:
- **Authentication identity** (who you are) — GitHub or WorkOS.
- **Local authorization** (what you may access) — local users/orgs/memberships.
- **Per-device session context** (your active org right now) — carried in the
  JWT and pinned on the refresh token.

## 1. Data model (additive migrations)

Nothing existing is dropped. `users.org_id` stays as the OSS single-org pointer
and as a safe-rollback default.

### `memberships` — cloud-gated multi-org join table
```sql
CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  org_id  UUID NOT NULL REFERENCES orgs(id),
  role    TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id),
  CHECK (role IN ('owner','admin','member'))
);
```
Role hierarchy is explicit: `owner ⊇ admin ⊇ member`. `RequireRole("admin")` is
satisfied by `owner`. OSS does not write this table; cloud writes exactly one
membership per user at first login and more as invitations are accepted.

### `auth_identities` — generalizes `users.github_id`
```sql
CREATE TABLE auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,          -- 'github' | 'workos'
  provider_subject TEXT NOT NULL,  -- WorkOS user id, or GitHub id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
-- backfill: one row per users.github_id with provider='github'
```
Used on both paths (OSS GitHub login also writes/reads it). `github_id` stays as
a fallback during rollout.

### `orgs.workos_org_id` (nullable TEXT, UNIQUE when non-null)
Maps our org ↔ a WorkOS Organization. Empty until an org enables SSO.
```sql
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS workos_org_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_workos_org_id
  ON orgs(workos_org_id) WHERE workos_org_id IS NOT NULL;
```

### `refresh_tokens.org_id` (nullable UUID) — active org as session state
```sql
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES orgs(id);
```
Pins the active org to the device/session. On refresh: if `org_id` is set (cloud),
mint the JWT with it; if NULL (OSS), fall back to `users.org_id`. **Never** update
`users.org_id` on an org switch — two devices may legitimately hold different
active orgs.

### `org_invitations` — cloud-gated
```sql
CREATE TABLE org_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,             -- normalized (lowercased, trimmed)
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  invited_by UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
-- at most one outstanding (unaccepted, unrevoked) invite per (org, email):
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invitations_outstanding
  ON org_invitations(org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```
Acceptance is single-use and email-bound: the accepting user's verified email
must equal the invite email.

SDK `environment_api_keys` are untouched — separate machine-auth system.

## 2. Pluggable auth provider + WorkOS flow

New `packages/ingestion/auth/provider.go`. The interface must be rich enough to
carry the CLI PKCE flow through an external IdP (see §4), so it is more than a
single `AuthorizeURL(state)`:

```go
type AuthProvider interface {
    Name() string // "github" | "workos"

    // Browser (dashboard) login.
    AuthorizeURL(req AuthRequest) string
    ExchangeCode(ctx context.Context, code string) (Identity, error)

    // Whether this provider serves the local CLI password form (OSS) or must
    // route the CLI through the external IdP and mint a local auth code (cloud).
    SupportsLocalPasswordForm() bool
}

type AuthRequest struct {
    State       string
    RedirectURI string // allowlisted, configured origin — not derived from Host header
}

type Identity struct {
    Provider        string
    ProviderSubject string
    Email           string
    EmailVerified   bool   // account-linking gate; see below
    Name            string
    AvatarURL       string
}
```

- `GithubProvider` wraps today's `github_oauth.go`. OSS default. Serves the local
  CLI password form.
- `WorkOSProvider` wraps the official Go SDK **`github.com/workos/workos-go`**.
  Enabled by config. Does not serve a local password form.

Provider selection in `main.go` is **explicit and fail-closed**:
`AUTH_PROVIDER=github|workos`. If `workos` is selected but `WORKOS_API_KEY` /
`WORKOS_CLIENT_ID` are missing, **boot fails** — no silent fallback. Inferring the
mode from the mere presence of secrets is rejected (accidental mode changes).

Browser login flow (cloud):
1. `Login.vue` hits `/auth/login`. `/auth/github` is kept as a **compatibility
   redirect** to `/auth/login` (the "same routes" claim was wrong — this is a
   rename plus alias).
2. Redirect to `provider.AuthorizeURL(...)` — AuthKit's hosted page for WorkOS
   (GitHub/Google/email), HMAC-signed state cookie as today.
3. WorkOS redirects to `/auth/callback`. The callback handler must handle:
   provider **denial/error** query params, **code replay** (single-use code),
   the **state-cookie path** scoping, and an **allowlisted configured redirect
   origin** (never trust the request Host header).
4. `provider.ExchangeCode` → `Identity`.
5. **Provision transactionally** (see §5).
6. Mint JWT + refresh (§3), set the existing `__opslane_*` cookies.

Account-linking gate: when resolving an identity, link to an existing user by
email **only if `Identity.EmailVerified` is true**. Email linking is an
account-takeover boundary; refuse it otherwise. AuthKit exposes `email_verified`
and normally verifies, but we enforce it ourselves.

## 3. JWT with active org, switching, and authz

### JWT claims (additive to `auth/jwt.go`)
```go
type Claims struct {
    Sub      string // user id
    OrgID    string // ACTIVE org
    Role     string // role in active org (cloud); empty/ignored in OSS
    Email    string
    Exp, Iat int64
}
```
OSS: `OrgID` = `users.org_id`, `Role` unused (OSS keeps `ADMIN_EMAILS` for the
operator surface). Cloud: `OrgID` = active org, `Role` = current membership role.

### Org switching (cloud-only) — `POST /auth/switch-org {org_id}`
1. Verify a `memberships` row exists for `(ctxUserID, org_id)`; reject otherwise.
2. Mint a **fresh JWT and a fresh refresh token**, the refresh token stamped with
   `org_id`. Rotate both cookies. No WorkOS round-trip. `users.org_id` is **not**
   touched.

### Refresh (`auth_handlers.go`)
Read the active org from `refresh_tokens.org_id`; fall back to `users.org_id`
when NULL (OSS). This replaces today's unconditional rebuild from `user.OrgID`,
which would otherwise silently revert a switched session to the default org.

### Authorization middleware
This is a **centralization of an existing check, not a fix for a missing one.**
`verifyProjectAccess` (`handler/read_api.go:141`) already enforces the tenant
boundary and is called from ~27 handlers. It has two branches that **must both be
preserved**:
- **SDK auth** (`ProjectIDFromCtx` set): the request's `projectID` must equal the
  authenticated project — exact match. An org-only check would let an environment
  API key reach **sibling projects in the same org** on `AuthenticateSessionOrSDK`
  routes. This isolation is non-negotiable.
- **Session auth**: the project's org must equal the active `ctxOrgID`
  (`GetProjectByOrgID`).

Centralization goal: promote this into middleware / a single enforced chokepoint
so a new handler cannot forget to call it — **keeping both branches intact**.

Cloud adds a **membership re-check** in the session path: on each request (short
cache acceptable) load the **current** membership row and put its **current role**
into context — do **not** trust a stale JWT role. Otherwise an admin→member
downgrade or a membership removal stays ineffective until token expiry. OSS skips
this (no memberships, single org).

CLI PKCE token exchange and SDK key auth are otherwise untouched.

## 4. CLI login on cloud (the corrected part)

Today `/oauth/authorize` (`auth_handlers.go`) serves a local email/password form
and only allows localhost redirect URIs. WorkOS-only users have **no local
password**, so "delete the form + leave CLI untouched + keep CLI working" cannot
all be true. Resolution:

- **OSS provider:** keeps the local password form and existing PKCE behavior.
- **Cloud provider:** `/oauth/authorize` still accepts the CLI's PKCE request
  (client_id, redirect_uri, code_challenge), but instead of rendering a password
  form it **redirects through AuthKit**. After AuthKit authenticates the user, the
  server issues the **existing local single-use authorization code** back to the
  CLI's localhost callback. The CLI's `/oauth/token` exchange is unchanged.

This is why the provider interface carries `SupportsLocalPasswordForm()` and the
flow is provider-driven rather than a single `AuthorizeURL(state)`.

## 5. Provisioning (transactional)

On first login and on invitation acceptance, create identity + user (+ org +
membership for cloud) in **one transaction**. Concurrent first logins and repeated
/replayed callbacks must not produce orphaned orgs or partial identities:
- Resolve by `auth_identities(provider, subject)` first (idempotent on replay).
- Else link by **verified** email.
- Else create user; cloud also creates a personal org + `owner` membership.
- Invitation acceptance: within the transaction, verify single-use + email match,
  then insert membership and stamp `accepted_at`.

WorkOS organization semantics for now: **ignored** at login. `workos_org_id` is
populated lazily only when an org enables SSO. Directory (SCIM) sync, when built,
applies provisioning webhooks **idempotently** and is authoritative only for the
membership of its own SCIM-enabled org.

## 6. Rollout order (each ships independently, reversible)

1. `auth_identities` + backfill from `github_id`; refactor GitHub login to
   write/read it. `github_id` kept as fallback. **Affects OSS + cloud.**
2. Centralize `verifyProjectAccess` into a single enforced chokepoint,
   **preserving both branches**. Add regression test: SDK key cannot access a
   sibling project. **Affects OSS + cloud.** Pure hardening.
3. Extract `AuthProvider` interface; wrap existing GitHub/password logic as
   `GithubProvider`. Behavior identical — the seam. Add explicit `AUTH_PROVIDER`
   config, fail-closed on partial WorkOS config. `/auth/github` → `/auth/login`
   with compatibility redirect.
4. Ship (but gate) `memberships`, `org_invitations`, `orgs.workos_org_id`,
   `refresh_tokens.org_id`. OSS ignores them; refresh falls back to
   `users.org_id`.
5. Add `WorkOSProvider` + transactional cloud provisioning + membership re-check
   middleware + `POST /auth/switch-org`. Enabled only under `AUTH_PROVIDER=workos`.
6. Dashboard: org-switcher + invitations UI. Cloud-only.

Steps 1–3 harden the shared codebase and can land on `main` now. 4–6 are the
cloud additions; OSS behavior is unchanged throughout.

WorkOS setup (in their dashboard): create project, set redirect URI to the
configured `/auth/callback` origin, enable GitHub + Google + email in AuthKit,
copy `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` into cloud env only.

## 7. Tests to add

- Refresh after an org switch preserves the selected org (reads
  `refresh_tokens.org_id`, not `users.org_id`).
- Two sessions for one user can hold different active orgs simultaneously.
- Membership removal and role downgrade take effect immediately (current role
  loaded from the membership row, not the JWT).
- **SDK key cannot access a sibling project in the same org** (both
  `verifyProjectAccess` branches preserved).
- Cloud CLI login works for a WorkOS-only user (no local password).
- Unverified email cannot link an existing account.
- Concurrent / replayed callbacks create exactly one identity and one membership.
- Invitation acceptance is single-use and email-bound.
- Migrations run on clean and representative existing databases and reapply
  idempotently.
- Partial WorkOS configuration fails boot closed (`AUTH_PROVIDER=workos` without
  keys does not start).
- A stub `AuthProvider` exercises the flow without a live WorkOS.
- Live smoke per AGENTS.md: migrations + `seed-e2e.sql`, log in via the OSS GitHub
  path, confirm an existing user is still authorized — proves no OSS regression.

## Files touched (map)

- `packages/ingestion/db/migrations/` — new additive migrations (auth_identities,
  memberships, org_invitations, orgs.workos_org_id, refresh_tokens.org_id).
- `packages/ingestion/auth/provider.go` (new), `auth/jwt.go` (claims + org),
  `auth/github_oauth.go` → `GithubProvider`, new `auth/workos.go`.
- `packages/ingestion/handler/read_api.go` (`verifyProjectAccess` → central
  chokepoint, both branches), `handler/auth.go` (membership re-check + role from
  DB, cloud), `handler/auth_handlers.go` (refresh reads `refresh_tokens.org_id`;
  cloud `/oauth/authorize` routes through AuthKit), `handler/routes.go`
  (`/auth/login`, `/auth/github` alias, `/auth/switch-org`),
  `handler/github_oauth.go` (transactional provisioning).
- `packages/ingestion/db/queries.go` — identity, membership, invitation,
  org-scoped refresh queries.
- `packages/ingestion/main.go` — explicit `AUTH_PROVIDER` selection, fail-closed.
- `packages/dashboard/src/views/Login.vue` (→ `/auth/login`), org-switcher +
  invitations UI (cloud), `src/api.ts` / `src/router.ts` as needed.

## Out of scope (YAGNI for now)

- SAML wiring (schema-ready via `workos_org_id`, deferred).
- SCIM / directory provisioning (needs its own lifecycle tables — a later
  migration, explicitly not "no migration").
- Removing `users.org_id` (kept for OSS single-org + rollback).
- Migrating SDK `environment_api_keys` (separate machine-auth, unchanged).

## Review resolutions (log)

- SDK isolation preserved in the centralized check (both branches). ✔
- Active org modeled as session state on `refresh_tokens`; switch rotates both
  tokens; `users.org_id` never updated on switch. ✔
- Cloud CLI login routes PKCE through AuthKit and issues a local auth code;
  richer provider interface. ✔
- WorkOS/local ownership resolved: local authoritative, WorkOS identity-only,
  `workos_org_id` lazy + unique, AuthKit org ignored for now, local wins on
  conflict; SCIM correctly scoped as a later, migration-bearing addition. ✔
- Current role loaded from membership row, not stale JWT. ✔
- `CHECK` on role + explicit hierarchy (owner ⊇ admin). ✔
- `EmailVerified` on identity; linking refused unless verified. ✔
- Transactional provisioning against concurrent/replayed callbacks. ✔
- Centralization reframed as removing fragile per-handler enforcement, not fixing
  an absence; OSS dual-write eliminated by keeping OSS off memberships. ✔
- Explicit `AUTH_PROVIDER`, fail-closed; `/auth/github` alias; `workos_org_id`
  unique; invitation lifecycle fields; correct SDK path
  `github.com/workos/workos-go`; callback error/replay/state/redirect handling. ✔
