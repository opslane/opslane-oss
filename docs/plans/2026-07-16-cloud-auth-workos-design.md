# Cloud auth with WorkOS — design

Date: 2026-07-16
Status: Design approved, not yet implemented
Branch context: `abhishekray07/auth`

## Problem

The OSS version has rudimentary auth: hand-rolled HS256 JWT, a custom OAuth/PKCE
server for the CLI, and GitHub OAuth for the dashboard. Users belong to exactly
one org (`users.org_id`, no membership table). The cloud version needs stronger,
lower-maintenance auth (social + email now, enterprise SAML/SCIM later) that we
do not want to build or operate ourselves. We buy that from **WorkOS**.

Hard constraint: do this **without breaking the DB schema** and **without forcing
self-hosters to create a WorkOS account**.

## Decisions (brainstorming outcome)

1. **Org model: users across many orgs.** A user can belong to several orgs and
   switch between them. Dashboard gets an org-switcher; the JWT carries the
   active org. WorkOS Organizations map 1:1 to our orgs.
2. **SSO scope: social + email at launch, SAML later.** Wire WorkOS AuthKit for
   GitHub/Google/email now. Schema is ready for per-org SAML/SCIM with no future
   migration.
3. **OSS/cloud split: pluggable auth provider.** A Go `AuthProvider` interface;
   OSS ships the existing GitHub/password provider, cloud configures a WorkOS
   provider. Chosen at boot by env. Same tables, same routes. OSS needs no
   WorkOS account.
4. **Session model: keep our own JWT + rotating refresh token.** WorkOS only
   handles the login handshake. On callback we mint our own JWT (with active
   `org_id`) and refresh token exactly as today. `auth.go` middleware, cookies,
   and the CLI PKCE flow stay working.

## Guiding principle

The IdP never owns the user table. Our `users` / `orgs` tables stay the source of
truth. WorkOS proves *identity*; we map external identity → local user row via a
stable subject id. This is exactly today's `users.github_id` pattern, generalized.
This is how Sentry (`AuthIdentity`), Cal.com (`Account`), GitLab, and Grafana add
cloud SSO without forking their schema.

## 1. Data model (additive migrations)

Nothing existing is dropped. Today's rows keep working. `users.org_id` stays as a
"default org" pointer during rollout for safe rollback; a later cleanup migration
can remove it.

### `memberships` — the multi-org join table (the real structural change)
```sql
CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  org_id  UUID NOT NULL REFERENCES orgs(id),
  role    TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);
-- backfill: one membership per existing user, role='owner', from users.org_id
```

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

### `orgs.workos_org_id` (nullable TEXT)
Maps our org ↔ a WorkOS Organization. Empty until an org needs SSO. This is the
"SAML drops in later, no migration" hook.

### `org_invitations`
Needed the moment a user can invite a teammate (multi-org is meaningless without
invites): `email`, `org_id`, `role`, `token_hash`, `expires_at`.

SDK `environment_api_keys` are untouched — separate machine-auth system.

## 2. Pluggable auth provider + WorkOS flow

New `packages/ingestion/auth/provider.go`:
```go
type AuthProvider interface {
    AuthorizeURL(state string) string
    ExchangeCode(ctx context.Context, code string) (Identity, error)
    Name() string // "github" | "workos"
}

type Identity struct {
    Provider        string // "github" | "workos"
    ProviderSubject string // stable IdP user id
    Email           string
    Name            string
    AvatarURL       string
}
```

- `GithubProvider` wraps today's `github_oauth.go` logic, behavior unchanged. OSS default.
- `WorkOSProvider` wraps the WorkOS AuthKit Go SDK (`workos-inc/workos-go`).
  Enabled when `WORKOS_API_KEY` + `WORKOS_CLIENT_ID` are set.
- Selection in `main.go`: WorkOS env present → WorkOS provider, else GitHub.
  One boot log line states which is active.

Login flow (cloud):
1. `Login.vue` hits `/auth/login` (renamed from hardcoded `/auth/github`).
2. Handler redirects to `provider.AuthorizeURL(state)` — for WorkOS this is
   AuthKit's hosted page (GitHub/Google/email in one UI), HMAC-signed state cookie
   as today.
3. WorkOS redirects to `/auth/callback`. Handler calls `provider.ExchangeCode` →
   `Identity`.
4. Resolve/provision (generalizes `github_oauth.go:132-175`): look up
   `auth_identities(provider, subject)` → else link by verified email → else
   create user. New users get a personal org + `owner` membership (just-in-time).
5. Mint our JWT + refresh (Section 3), set the existing `__opslane_*` cookies.

AuthKit provides the hosted login UI, so the hardcoded HTML form in
`auth_handlers.go:410-439` is deleted for cloud. CLI PKCE endpoints stay for OSS.

## 3. JWT with active org, switching, and authz

JWT gains an active-org claim (additive to `auth/jwt.go`):
```go
type Claims struct {
    Sub      string // user id
    OrgID    string // ACTIVE org — verified against memberships
    Role     string // role in the active org (for RequireRole)
    Email    string
    Exp, Iat int64
}
```
At login we pick a default active org (sole membership, or last-used).

Org switching — new `POST /auth/switch-org {org_id}`:
1. Verify a `memberships` row exists for `(ctxUserID, org_id)`; reject otherwise.
2. Mint a fresh JWT with new `OrgID`/`Role`, rotate cookies. No WorkOS round-trip.

Dashboard org-switcher reads `/auth/me`, which now returns the membership list +
active org.

Authz middleware — the security fix, not just a feature. Today `AuthenticateSession`
trusts the JWT `org_id`, but project routes trust `{projectID}` from the URL with
no systematic check that the project belongs to the org (cross-org IDOR risk).
Close it centrally:
- `AuthenticateSession` sets `ctxUserID`, `ctxOrgID` (active), `ctxRole`, and now
  re-checks the membership exists (cheap query or short cache) so a revoked
  member's still-valid JWT stops working within the access-token TTL.
- New `RequireOrgAccess` middleware on all `/projects/{projectID}/...` routes:
  verifies `project.org_id == ctxOrgID` once, in one place.
- `RequireRole("admin")` replaces the `ADMIN_EMAILS` allowlist for org-scoped
  admin actions. Keep `ADMIN_EMAILS` only for platform/operator surface.

CLI PKCE flow and SDK key auth untouched.

## 4. Rollout, WorkOS setup, testing

Migration order (each ships independently, reversible):
1. `memberships` + backfill (`owner` per existing user). Switch authz reads from
   `users.org_id` → `memberships`. No auth change yet — pure refactor. Verify OSS
   still logs in.
2. `RequireOrgAccess` + membership re-check in `AuthenticateSession`. Closes the
   IDOR gap. Ships before any cloud exposure.
3. `auth_identities` + backfill from `github_id`. Refactor GitHub login to
   write/read it. `github_id` stays as fallback.
4. Extract `AuthProvider` interface; wrap existing GitHub logic as
   `GithubProvider`. Behavior identical — this is the seam.
5. Add `WorkOSProvider` + `orgs.workos_org_id` + `org_invitations`. Enabled only
   when WorkOS env is set. OSS boot path never touches WorkOS.
6. Dashboard: org-switcher + invitations UI + rename `/auth/github` → `/auth/login`.

Steps 1–4 harden the OSS codebase and can land on `main` now. 5–6 are cloud-only.

WorkOS setup (in their dashboard): create project, set redirect URI to
`/auth/callback`, enable GitHub + Google + email in AuthKit, copy `WORKOS_API_KEY`
/ `WORKOS_CLIENT_ID` into cloud env only. SAML/SCIM per org is a later toggle;
schema already supports it via `workos_org_id`.

Testing:
- Go unit tests: identity resolution (new user, email-link, existing identity);
  `switch-org` rejects non-members; `RequireOrgAccess` blocks cross-org project IDs.
- A stub `AuthProvider` in tests so the flow runs without a live WorkOS.
- Live smoke per AGENTS.md: migrations + `seed-e2e.sql`, log in via OSS GitHub
  path, confirm existing user still authorized — proves no OSS regression.
- Manual WorkOS smoke in a staging cloud env.

Guardrail: no new queue/Redis; sessions stay JWT + refresh in Postgres
(`refresh_tokens`), preserving the existing rotation/reuse-detection contract.

## Files touched (map)

- `packages/ingestion/db/migrations/` — new migrations (memberships,
  auth_identities, orgs.workos_org_id, org_invitations).
- `packages/ingestion/auth/provider.go` (new), `auth/jwt.go` (claims),
  `auth/github_oauth.go` → `GithubProvider`, new `auth/workos.go`.
- `packages/ingestion/handler/auth.go` (membership re-check, `RequireOrgAccess`,
  `RequireRole`), `handler/auth_handlers.go` (drop hardcoded HTML form for cloud),
  `handler/routes.go` (wire middleware, `/auth/login`, `/auth/switch-org`),
  `handler/github_oauth.go` (provision via memberships/auth_identities).
- `packages/ingestion/db/queries.go` — membership/identity/invitation queries.
- `packages/ingestion/main.go` — provider selection by env.
- `packages/dashboard/src/views/Login.vue` (→ `/auth/login`), org-switcher +
  invitations UI, `src/api.ts` / `src/router.ts` as needed.

## Out of scope (YAGNI for now)

- SAML/SCIM wiring (schema-ready, deferred).
- Removing `users.org_id` (kept for rollback; later cleanup).
- Migrating SDK `environment_api_keys` (separate machine-auth, unchanged).
