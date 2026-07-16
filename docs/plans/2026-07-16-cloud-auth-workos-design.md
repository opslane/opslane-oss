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

    // Browser (dashboard) login. Returns an error because AuthKit URL
    // generation can fail (SDK contract) — do not swallow it.
    AuthorizeURL(req AuthRequest) (string, error)
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
- `WorkOSProvider` wraps the official Go SDK **`github.com/workos/workos-go/v9`**
  (semantic-import versioned; the module is Go 1.25). Enabled by config. Does not
  serve a local password form.

Provider selection in `main.go` is **explicit and fail-closed**:
`AUTH_PROVIDER=github|workos`. If `workos` is selected but `WORKOS_API_KEY` /
`WORKOS_CLIENT_ID` are missing, **boot fails** — no silent fallback. Inferring the
mode from the mere presence of secrets is rejected (accidental mode changes).
Until the real `WorkOSProvider` exists (Phase 5), `AUTH_PROVIDER=workos` is
**rejected as unsupported** — never boot with a stub provider in a mode that
looks production-ready.

**Email normalization is a DB-level contract, not a per-call convenience.**
`users.email` and invitation email are today case-sensitive
(`GetUserByEmail` is `WHERE email = $1`). Normalize (lowercase + trim) on **every**
write and lookup, and back it with `lower(email)` uniqueness where feasible
(a functional unique index on `users(lower(email))`, and the invitation
outstanding index keyed on `lower(email)`). Mixed-case linking and invitation
acceptance must be tested.

Browser login flow (cloud):
1. `Login.vue` hits `/auth/login`. `/auth/github` is kept as a **compatibility
   redirect** to `/auth/login` (the "same routes" claim was wrong — this is a
   rename plus alias).
2. Redirect to `provider.AuthorizeURL(...)` — AuthKit's hosted page for WorkOS
   (GitHub/Google/email), HMAC-signed state cookie as today.
3. WorkOS redirects to `/auth/callback` (keep `/auth/github/callback` as an
   **alias** — existing deployments are configured for it, `routes.go:45`). The
   callback handler must handle: provider **denial/error** query params, **code
   replay** (single-use code), the **state-cookie path** scoping, and an
   **allowlisted configured redirect origin** (never trust the request Host
   header). This hardening ships **before** WorkOS is enabled, not after.
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
operator surface). Cloud: `OrgID` = active org.

**`Role` in the JWT is informational only and is never trusted for authorization.**
Every authorization decision reads the role from context, which the cloud
membership re-check (below) sets from the **current** membership row on each
request. A stale JWT role from before a downgrade must never grant access. If
this informational field adds confusion in review, drop it from `Claims` — the
DB is the sole authority either way.

### Org switching (cloud-only) — `POST /auth/switch-org {org_id}`
Switching must **rotate** the session, not merely add a second live token.
1. Require the **current** refresh token (cookie for browser, request field for
   CLI) and verify a `memberships` row exists for `(ctxUserID, org_id)`; reject
   otherwise.
2. **Atomically consume** the current refresh token (`ConsumeRefreshToken`) and
   issue the replacement **in the same family**, stamped with the target `org_id`,
   plus a fresh JWT. Rotate both cookies. The **old refresh token must stop
   working** — otherwise it could restore the previous org. No WorkOS round-trip.
   `users.org_id` is **not** touched (two devices may hold different active orgs).

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

Centralization goal: make the check a single enforced chokepoint so a new handler
cannot forget it — **keeping both branches intact**. But mind the routing:
project routes are registered individually, some with `AuthenticateSession` and
some with `AuthenticateSessionOrSDK` (`routes.go:95+`). A parent middleware group
could run **before** route-level authentication. So the contract is:
- Land now (safe): factor a `checkProjectAccess` core (both branches) and keep
  `verifyProjectAccess` as its wrapper — a pure refactor, no ordering risk, no
  extra DB reads.
- Promoting to `RequireProjectAccess` middleware is a **separate, careful** task:
  enforce ordering `Authenticate* → RequireProjectAccess`, add real-router tests
  for both session and SDK paths, and **remove the now-redundant in-handler check**
  on migrated routes so the session path does not double its DB reads.

Cloud adds a **membership re-check** in the session path: on each request (short
cache acceptable) load the **current** membership row and put its **current role**
into context — do **not** trust a stale JWT role. Otherwise an admin→member
downgrade or a membership removal stays ineffective until token expiry. OSS skips
this (no memberships, single org). This is also where `ctxRole`, `RoleFromCtx`,
and `RequireRole(role)` are defined (see §3 claims: role comes from the DB, never
the JWT). Middleware-order tests must prove authentication and membership loading
run before any role check.

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

The pending CLI PKCE request must survive the AuthKit round-trip **across
ingestion replicas** — do not stash it in process memory. Persist it as a
**single-use, expiring DB record** (or an authenticated/encrypted cookie carrying
the request), keyed to the callback, consumed exactly once. The localhost-only
redirect allowlist (`isAllowedRedirectURI`) still gates the final CLI redirect.

This is why the provider interface carries `SupportsLocalPasswordForm()` and the
flow is provider-driven rather than a single `AuthorizeURL(state)`.

## 5. Provisioning (transactional)

On first login and on invitation acceptance, create identity + user (+ org +
membership for cloud) in **one transaction**. Concurrent first logins and repeated
/replayed callbacks must not produce orphaned orgs or partial identities:
- Resolve by `auth_identities(provider, subject)` first (idempotent on replay).
- Else link by **verified** email.
- Else create user; cloud also creates a personal org + `owner` membership.

**Concurrency (do it right).** `SELECT ... FOR UPDATE` cannot lock a row that does
not exist yet, so two simultaneous first-logins could each create a user+org
before one loses the `auth_identities` unique conflict — leaving an orphan org.
Use one of:
- a **transaction advisory lock** keyed by `hashtext(provider || ':' || subject)`
  taken at the top of the tx, or
- **insert-identity-first, then on unique conflict roll back and retry** the
  resolve path (the winner's row now exists).

`ON CONFLICT DO NOTHING` on the identity insert must **not** be treated as
success-by-default: re-read the row and validate the resolved owner; if the
subject already belongs to a **different** user, that is an error, not a link.
The regression test must use **genuinely concurrent transactions**, not sequential
replay.

**Defensive membership ensure (insurance, not P0).** When linking a verified
identity to an existing user, also ensure an `owner` membership exists for that
user's `users.org_id` (idempotent `ON CONFLICT DO NOTHING`). Cloud is greenfield
so no user should lack a membership — this just guarantees the Phase-5 session
re-check can never lock out a linked account.

- **Invitation acceptance** runs in the transaction: verify single-use +
  **not expired** + the accepting user's **verified, normalized** email equals the
  (normalized) invite email, then insert membership and stamp `accepted_at`.
  Acceptance is **not** admin-gated — the invitee is not a member yet. Only
  create/list/revoke require `RequireRole("admin")`.

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
- **Mixed-case** email links and invitation acceptance resolve correctly
  (normalization contract).
- Concurrent / replayed callbacks create exactly one identity and one membership —
  test uses **genuinely concurrent transactions**.
- Identity insert conflict for a subject owned by a **different** user is an error,
  not a silent link.
- **Old refresh token stops working after an org switch** (rotation, not addition).
- Invitation acceptance is single-use and email-bound, and is **not** admin-gated.
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

### Round 2 (post-implementation-plan review)

- **P0** Org switch must **consume** the current refresh token and reissue in the
  same family; the old token must stop working (was only additive). ✔
- **P0** Invitation **acceptance** is not admin-gated; requires an authenticated
  user whose verified/normalized email matches. Only create/list/revoke need
  admin. ✔
- **P1** Provisioning concurrency: advisory-lock or insert-then-conflict-retry
  (FOR UPDATE can't lock a nonexistent row); conflict on a different owner is an
  error; test with genuinely concurrent txns. ✔
- **P1** Phase 1 resolves **identity-first**, then email, then create; identity
  conflict validates the resolved owner (not silent DO-NOTHING). ✔
- **P1** Role authz surface defined: `ctxRole` / `RoleFromCtx` / `RequireRole`;
  JWT `Role` is informational-only and always overwritten from the DB;
  middleware-order tests required. ✔
- **P1** CLI PKCE pending request persisted as a single-use expiring DB record
  (multi-replica safe); callback hardening lands **before** enabling WorkOS;
  `/auth/github/callback` kept as an alias. ✔
- **P1** Email normalization is a DB contract: normalize on every write/lookup,
  `lower(email)` uniqueness where feasible, test mixed-case. ✔
- **P2** SDK `github.com/workos/workos-go/v9`; `AuthorizeURL` returns
  `(string, error)`; module is Go 1.25; `AUTH_PROVIDER=workos` rejected until the
  real provider exists (no stub boot). ✔
- **P2** `RequireProjectAccess` middleware promotion is a separate, careful task
  (ordering `Authenticate* → RequireProjectAccess`, real-router tests, remove
  redundant handler check to avoid double reads); Phase 2 lands only the safe
  `checkProjectAccess` extraction + guard test. ✔
- Defensive: ensure `owner` membership on link (insurance; no existing users at
  launch, so not P0). ✔
