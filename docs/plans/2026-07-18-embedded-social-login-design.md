# Embedded Social Login Design (Google + GitHub via WorkOS)

**Goal:** Add "Sign in with Google" and "Sign in with GitHub" buttons to the
embedded login card, for the WorkOS (cloud) auth mode only. Self-hosted GitHub
installs are untouched and keep their existing native GitHub login.

**Key constraint:** Social sign-in cannot be truly no-redirect — Google/GitHub
OAuth inherently bounce the browser to their consent screen. "Embedded" here
means the buttons live on **our** login card and start the WorkOS OAuth redirect
**directly** (skipping the hosted AuthKit picker page), not that the handshake
avoids a redirect.

**Why it's small:** the redirect + callback + provisioning path already exists
and works for any WorkOS connection (`/auth/callback` → `ExchangeCode`). The only
thing hardcoded is that the authorize URL always sends `provider=authkit`
(`auth/workos.go`). This change makes the provider selectable and adds buttons.

---

## Trust model (read first — resolves what the allowlist is and is not)

`AUTH_WORKOS_SOCIAL` is **UI-capability configuration**, not a security
boundary. **The WorkOS dashboard is authoritative** for which authentication
methods actually work.

Why this framing is honest: the `provider` value is a browser-visible query
parameter. A user can obtain a valid `state` from a legitimate `/auth/login`
call, then hand-edit the WorkOS authorization URL to a different `provider`. Our
callback verifies `state` but not the authentication method used. So if an
operator enables Google in WorkOS but omits it from `AUTH_WORKOS_SOCIAL`, a
hand-crafted URL still logs the user in via Google — a real, WorkOS-enabled
method, with identical provisioning and no privilege gain. That is cosmetic
(a login method that wasn't shown as a button), not an escalation.

Therefore:
- The env allowlist decides **which buttons render** and **which `?provider=`
  values `/auth/login` will construct a URL for**. It is input validation and
  dead-button avoidance, not access control.
- Whether a method is truly usable is governed by the WorkOS dashboard. To
  disable Google, disable it in WorkOS — not just in `AUTH_WORKOS_SOCIAL`.
- **Bare `/auth/login`** (no `provider` param) keeps sending `authkit`, and
  AuthKit may present methods enabled in WorkOS even if omitted from the local
  list. That is expected: the local list is UI-only.

**Hardening path (not built now, YAGNI):** the SDK exposes
`AuthenticateResponse.AuthenticationMethod` (`Password`, `GoogleOAuth`,
`GitHubOAuth`, `SSO`, …). If strict server-side enforcement is ever required,
bind the expected method into `state` at `/auth/login` and compare it against the
returned `AuthenticationMethod` after `ExchangeCode`, rejecting a mismatch. We
deliberately do not do this now because the WorkOS dashboard is already
authoritative and the gap is cosmetic.

---

## Section 1 — Backend: provider-scoped authorize URL

Today `/auth/login` → `OAuthLoginStart` → `redirectToProvider` always builds an
`authkit` URL (the hosted picker). Make the provider selectable:

- **`auth.AuthRequest`** gains a `SocialProvider auth.SocialProvider` field
  (named `SocialProvider`, not `Connection` — WorkOS distinguishes `provider`
  from `connection_id`, and we set `provider`). Empty means "hosted AuthKit
  picker" — today's behavior, unchanged.
- **`auth.SocialProvider`** is a typed public value with constants
  `SocialProviderGoogle = "google"` and `SocialProviderGitHub = "github"`. The
  handler deals only in these typed public values.
- **Mapping ownership:** the public → WorkOS translation
  (`google` → `GoogleOAuth`, `github` → `GitHubOAuth`) lives **only** in
  `auth/workos.go`, inside `workOSSDKClient.AuthorizationURL`. If `SocialProvider`
  is set, it is translated to the WorkOS `Provider` string there; otherwise the
  client keeps `"authkit"`. WorkOS vocabulary never leaks into the handler.
  `GitHubProvider.AuthorizeURL` ignores the field, so self-hosted is untouched.
- **`OAuthLoginStart`** parses `?provider=` into an `auth.SocialProvider` via a
  fixed decoder that accepts only `google`/`github`. Anything else (including an
  otherwise-valid value not in the deployment's allowlist) is rejected — see
  Section 3.

State generation, the `__auth_state` cookie, the 5-minute stored state,
`/auth/callback`, `ExchangeCode`, and provisioning are all **unchanged**. A
Google/GitHub login returns through the exact same callback a WorkOS login uses
today. The identity's `Provider` stays `"workos"` regardless of which social
connection was used, so provisioning and the `auth_identities` table need no
changes.

---

## Section 2 — Capability discovery + config semantics

The card must not guess which buttons to show. The deployment declares it:

- **New env var:** `AUTH_WORKOS_SOCIAL=google,github`. Read once at boot in
  `main.go`, parsed into config on `Dependencies`. Empty → no social buttons
  (today's behavior). WorkOS has no clean runtime API to list enabled AuthKit
  social methods, so this is explicit config.

- **Parsing rules (defined, not left implicit):**
  - Split on comma; **trim** whitespace; **lowercase**; **dedupe**.
  - **Unknown value → startup failure** (fail closed, consistent with
    `SelectAuthProvider`). `AUTH_WORKOS_SOCIAL=google,facebook` refuses to boot.
  - **Set under non-WorkOS auth** (e.g. `AUTH_PROVIDER=github`) → log a warning
    and treat as empty; `/auth/config` still returns `[]` because social buttons
    are only meaningful for WorkOS.

- **Data shape (Go correctness):** store **both**
  - a canonical **ordered `[]string`** for the `/auth/config` response
    (deterministic, in declared order — a map/set iterates nondeterministically),
    and
  - a **set** (`map[auth.SocialProvider]struct{}`) for O(1) validation in
    Section 3.
  The config field is always a **non-nil slice** so it serializes as `[]`, never
  `null` (a nil `[]string` marshals to `null` and would break the typed frontend
  array).

- **`GET /auth/config`** gains `social_providers: ["google","github"]`. The
  dashboard already calls this endpoint to choose between the password form and
  the redirect button; it gets one more field.

- **Same set guards `/auth/login`** (Section 3). The list that renders buttons is
  the exact set that permits `?provider=` values, so they cannot drift.

---

## Section 3 — The 400 rejection path (explicit control flow)

Today every authorization-URL error becomes `503`
(`github_oauth.go` → `OAuthLoginStart`). Social validation must be a distinct,
**side-effect-free** rejection that runs **before** any state is minted:

In `OAuthLoginStart`, before `generateOAuthState`:
1. If `?provider=` is absent → unchanged AuthKit path (mint state, redirect).
2. If present, decode to `auth.SocialProvider`. If it is not a known public value
   **or** not in the deployment's allowlist set → return **`400`** immediately.
3. On that 400: **no** `Location` header, **no** `__auth_state` cookie, **no**
   `StoreOAuthLoginState` call, no redirect. Nothing is persisted or set.

This is a typed validation rejection, not the generic 503 (which stays for real
provider/config failures). Only after validation passes do we mint state, set the
cookie, store state, and redirect with the WorkOS provider.

**Tests assert the absence of side effects** on rejection: response is 400, and
the recorder shows no `Location`, no `Set-Cookie`, and (with a stub store) no
stored-state call.

---

## Section 4 — Frontend: the buttons

Buttons live on the existing login card (`Login.vue`), on the sign-in and
sign-up views only — not verify-code, forgot, or reset.

- **Layout:** social buttons sit **above** the email/password form, with a
  divider reading "or continue with email" between them.
- **Rendering:** one button per entry in `config.social_providers`, in the order
  the backend returns. Reuse the existing GitHub SVG in the file; add a Google
  "G" mark. Empty list → no divider, no buttons; the card looks exactly like
  today.
- **Behavior:** a plain full-page navigation —
  `window.location.href = '/auth/login?provider=google'`. No fetch, no JSON. The
  browser leaves for the WorkOS→Google trip and returns through `/auth/callback`,
  which already runs `completePostAuth`, so social reuses the same post-login
  setup as everything else.
- **Redirect-mode card:** when a provider supports only redirect (no password),
  the current single "Continue to sign in" button stays; if that provider also
  lists social connections, the social buttons render there too.
- **Types:** `AuthConfig.social_providers` is typed
  `Array<'google' | 'github'>`. All existing `AuthConfig` test fixtures are
  updated to include the field.

No new state in `useLoginFlow` — social is a leave-the-page action, not a state
transition, so the composable's state machine is untouched.

---

## Section 5 — Deployment wiring (required, not optional)

Adding an `os.Getenv` without wiring breaks two things: Compose won't pass it,
and CI fails. Both must land in the same change:

- **`docker-compose.yml`:** add `AUTH_WORKOS_SOCIAL: ${AUTH_WORKOS_SOCIAL:-}`
  alongside the existing `WORKOS_*` and `ADMIN_EMAILS` entries. Without this,
  setting the variable on the host does nothing in Compose.
- **`docs/reference/environment-variables.md`:** add a row for
  `AUTH_WORKOS_SOCIAL` (Required: no; Purpose: comma-separated social login
  buttons to show under `AUTH_PROVIDER=workos`, e.g. `google,github`). **This is
  mandatory:** `scripts/check-docs-drift.mjs` fails the repo test gate
  (`pnpm test`, run in CI) if code reads an env var the doc omits.
- **Rollout/rollback:** env-var only, no migration. Roll out by setting
  `AUTH_WORKOS_SOCIAL` (and enabling the matching connections in the WorkOS
  dashboard). Roll back by unsetting it — buttons disappear; the redirect and
  password flows are unaffected.

---

## Section 6 — Testing and scope

**Backend tests (Go):**
- `AuthorizeURL` with `SocialProvider=google` produces `provider=GoogleOAuth`;
  empty `SocialProvider` still produces `provider=authkit` (locks the default).
- `OAuthLoginStart`: `?provider=google` when Google is allowed → 302 whose URL
  carries the Google provider; `?provider=github` when GitHub is **not** in the
  allowlist → 400 with **no** Location, cookie, or stored state; no param →
  today's AuthKit redirect unchanged.
- Decoder rejects any value not in the fixed public set (`?provider=evil` → 400),
  proving raw input never reaches WorkOS.
- Config parsing: trims/lowercases/dedupes; unknown value fails startup; set
  under non-WorkOS auth warns and yields `[]`.
- `/auth/config` includes `social_providers` in declared order from the allowlist;
  empty env → `[]` (not `null`); GitHub (self-hosted) provider → `[]`.

**Frontend (Playwright, in `test-e2e` — harness already has `@playwright/test`):**
Mock `/auth/config` and assert button visibility per config, divider visibility,
provider order, and the navigation target (`/auth/login?provider=…`). This
config-to-DOM behavior is the core of the feature and is worth a browser test.

**Live smoke:** with a WorkOS staging env that has Google enabled — click the
Google button, complete Google's consent, land on the dashboard with cookies set;
confirm `?provider=github` 400s when GitHub is off.

**Explicitly out of scope:**
- Microsoft/other WorkOS social providers (trivial later — one decoder entry +
  one env value + one map entry in the adapter).
- Server-side method-binding enforcement (see Trust model — hardening path only).
- SSO/SAML enterprise connections.
- Self-hosted native Google (the OSS build has no Google provider; only WorkOS
  gets social).
