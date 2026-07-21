# OAuth Email-Verification Challenge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a user who signs in with GitHub complete the WorkOS email-verification challenge, instead of dead-ending on `{"error":"authentication failed"}`.

**Architecture:** WorkOS returns a recoverable `email_verification_required` challenge carrying a `pending_authentication_token`. Today `ExchangeCode` throws that token away and the handler 502s. We translate the error, persist a short-lived server-side continuation record (purpose-sealed token + a self-contained snapshot of the flow context), hand the browser only an `HttpOnly` cookie holding a random flow id, and add an OAuth-specific verify endpoint that resolves the flow from the cookie and finishes login through a shared completion tail that **returns a result rather than writing the response**.

**Tech Stack:** Go 1.24 (chi, pgx), Vue 3 + Vite, Postgres, WorkOS `workos-go/v9`.

**Revision 4 (final).** Three independent-model review rounds. Fixes carry the tag of the
round that found them: **[R2-n]** from round 2 (11 findings, 9 confirmed fixed in v3, 2
partial), **[R3-n]** from round 3 (7 new defects plus the 2 partials). No further review
round was run — the review budget was 2 iterations and both are spent. Round 3's verdict on
v3 was "not safe to implement as written"; the fixes below are the response to that and have
**not themselves been re-reviewed**. Treat the [R3-n] items as the highest-risk parts of
this plan and scrutinize them during implementation.

---

## Background (read before Task 1)

**The bug, precisely.** `auth/workos.go:147` `ExchangeCode` returns the raw SDK error. The
password path 40 lines below (`workos.go:188`) calls `translateWorkOSError`. That helper
(`workos.go:160`) converts `workos.EmailVerificationRequiredCode` into a
`*auth.PendingVerificationError` carrying the pending token. The OAuth path never calls it,
so the token dies at the first step and every downstream layer sees an opaque error.

**Why the user hit it.** Both WorkOS users are `email_verified: true` with exactly one
identity, `GoogleOAuth`. Signing in with GitHub asks WorkOS to LINK a new credential to an
existing account; WorkOS demands proof of inbox access first. Not an unverified email.

**Do not touch `AuthCallback.vue`.** Routed at `/auth/complete` (`router.ts:20`); never runs
in this failure. `/auth/callback` is the Go handler (`routes.go:56`) writing JSON directly.

**The GitHub App install path is already dead under WorkOS.**
`applyCombinedGitHubInstallation` returns early unless `d.provider().Name() == "github"`
(`github_oauth.go:305`); WorkOS reports `"workos"` (`workos.go:113`). Build no storage for
install context. Fail loudly if it appears.

---

## Task 1: Translate the WorkOS error in `ExchangeCode` (the root fix)

This is the whole bug. Everything else is delivery.

**Files:**
- Modify: `packages/ingestion/auth/workos.go:147-156`
- Test: `packages/ingestion/auth/workos_test.go`

**Step 1: Write the failing test**

Mirror `TestAuthenticateWithPasswordTranslatesErrors` (workos_test.go:94):

```go
func TestExchangeCodeTranslatesEmailVerificationChallenge(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{
		err: &workos.APIError{
			ErrorCode:                  workos.EmailVerificationRequiredCode,
			PendingAuthenticationToken: "pat_abc",
			EmailVerificationID:        "ev_123",
		},
	})

	_, err := provider.ExchangeCode(context.Background(), "code_1")

	var pending *PendingVerificationError
	if !errors.As(err, &pending) {
		t.Fatalf("want *PendingVerificationError, got %T: %v", err, err)
	}
	if pending.PendingAuthenticationToken != "pat_abc" {
		t.Fatalf("pending token lost: %q", pending.PendingAuthenticationToken)
	}
	if pending.EmailVerificationID != "ev_123" {
		t.Fatalf("verification id lost: %q", pending.EmailVerificationID)
	}
}
```

Why at this level: a handler stub returning `PendingVerificationError` bypasses
`WorkOSProvider.ExchangeCode` and would pass even with the bug present.

**Step 2: Run it and watch it fail**

```bash
cd packages/ingestion && go test ./auth -run TestExchangeCodeTranslates -v
```
Expected: FAIL — `want *PendingVerificationError, got *workos.APIError`.

**Step 3: Minimal implementation** — `workos.go:150`, error return only:

```go
	response, err := p.client.AuthenticateCode(ctx, code)
	if err != nil {
		return Identity{}, translateWorkOSError(err)
	}
```

**Step 4: Verify** `cd packages/ingestion && go test ./auth -v` — PASS, no regressions.

**Step 5: Commit**

```bash
git add packages/ingestion/auth/workos.go packages/ingestion/auth/workos_test.go
git commit -m "fix(auth): translate WorkOS errors in ExchangeCode so the pending verification token survives"
```

---

## Task 2: Purpose-specific sealer for the pending token **[R2-5]**

Do **not** reuse `notify.ConfigCipher`. It derives a notification-scoped key with
`configKeyInfo = "opslane/notification-destination-config/v1"` (`notify/crypto.go:15`).
Reusing that key domain for auth bearer tokens is a layering mistake.

**Files:**
- Create: `packages/ingestion/auth/pendingcipher.go`
- Test: `packages/ingestion/auth/pendingcipher_test.go`

**Step 1: Failing tests** — round-trip seal/open; opening with a **different flow hash as
AAD fails** (ciphertext is bound to its flow); a tampered byte fails; a short secret errors.

**Step 2: Run, watch fail.**

**Step 3: Implement** — same shape as `notify/crypto.go` (HKDF-SHA256 over the JWT secret,
AES-GCM) but with its own info string and mandatory AAD:

```go
const pendingKeyInfo = "opslane/oauth-pending-verification/v1"

func NewPendingCipher(jwtSecret []byte) (*PendingCipher, error)
func (c *PendingCipher) Seal(plaintext, aad []byte) ([]byte, error)
func (c *PendingCipher) Open(blob, aad []byte) ([]byte, error)
```

Callers always pass the flow hash as AAD, so a ciphertext lifted from one row cannot be
replayed into another.

**Step 4: Wire it up [R3-5].** Nothing constructs this cipher yet. Add a `PendingCipher`
field to `handler.Dependencies` and build it once at startup in `packages/ingestion/main.go`
from the same JWT secret, beside the existing dependency wiring. Startup must fail loudly if
construction fails (a short `JWT_SECRET`) rather than leaving a nil cipher that panics on
the first challenge. Assert in a test that a nil cipher is rejected at construction, not at
use.

**Step 5: Verify** `go build ./... && go test ./auth -v`. **Step 6: Commit.**

---

## Task 3: Continuation table migration **[R2-6, R2-7]**

**Files:**
- Create: `packages/ingestion/db/migrations/020_oauth_verification_continuations.sql`

Modeled on `012_cli_pkce_requests.sql`. Highest existing migration is 019.

The CLI columns are a **self-contained snapshot**, not a pointer to `cli_pkce_requests`
**[R2-3]**: that table is stored with `authCodeTTL` = 5 minutes (`auth_handlers.go:589`),
which is shorter than this record's 10-minute life. Pointing at it would let a slow
verification silently lose the CLI flow and fall through to a browser session.

```sql
-- 020_oauth_verification_continuations.sql — single-use bridge that lets a
-- hosted OAuth login finish an emailed verification challenge. The WorkOS
-- pending token is a bearer credential: stored sealed (AAD-bound to flow_hash),
-- and the browser only ever holds a random flow id.
CREATE TABLE IF NOT EXISTS oauth_verification_continuations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_hash TEXT NOT NULL UNIQUE,
  pending_token_sealed BYTEA NOT NULL,
  flow_kind TEXT NOT NULL CHECK (flow_kind IN ('browser','cli')),
  target_org_id UUID,
  cli_client_id TEXT,
  cli_redirect_uri TEXT,
  cli_oauth_state TEXT,
  cli_code_challenge TEXT,
  cli_code_challenge_method TEXT,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_verification_continuations_expiry
  ON oauth_verification_continuations(expires_at);
```

**Step 2: Extend the existing cleanup [R2-7]** — `db/queries.go:2636` already deletes aged
`cli_pkce_requests` and `oauth_login_states` rows. Add the same clause for this table, or
sealed bearer tokens accumulate forever.

**Step 3: Apply to a disposable database and prove idempotency**

```bash
docker exec -i opslane-oss-postgres-1 psql -U opslane -d postgres -c 'CREATE DATABASE mig_check;'
docker exec -i opslane-oss-postgres-1 psql -U opslane -d mig_check < packages/ingestion/db/migrations/020_oauth_verification_continuations.sql
docker exec -i opslane-oss-postgres-1 psql -U opslane -d mig_check < packages/ingestion/db/migrations/020_oauth_verification_continuations.sql
docker exec -i opslane-oss-postgres-1 psql -U opslane -d postgres -c 'DROP DATABASE mig_check;'
```
Both runs succeed; the second is a no-op. Never run against a retained database.

**Step 4: Commit.**

---

## Task 4: Continuation queries with atomic attempt reservation **[R2-1, R2-2, R2-6]**

v2 split "consume" from "increment attempts", which contradicted itself: consuming before
calling WorkOS made a wrong-code retry impossible, and a separate increment let concurrent
requests race past the cap. One statement fixes both.

**Files:**
- Modify: `packages/ingestion/db/queries.go`
- Test: `packages/ingestion/db/queries_test.go` (real pgx, not stubs — the guarantee is in
  the SQL, so a handler-level test cannot prove it)

**Step 1: Failing tests**
- Reserve → returns the row and `attempts = 1`.
- Reserve 6 times → the 6th returns nil (cap enforced by the WHERE clause).
- **Concurrency:** N goroutines reserving the same flow produce exactly N distinct attempt
  numbers and never exceed the cap.
- Consume after success → a second consume returns nil.
- Expired row → reserve returns nil.
- Browser row (NULL `target_org_id`, NULL cli columns) scans without error **[R2-6]**.

**Step 2: Run, watch fail.**

**Step 3: Implement.** Reservation is one atomic statement — it bumps the counter, enforces
the cap, and returns the payload together:

```go
func (q *Queries) ReserveOAuthVerificationAttempt(ctx context.Context, flowHash string) (*OAuthVerificationContinuation, error) {
	var c OAuthVerificationContinuation
	err := q.pool.QueryRow(ctx,
		`UPDATE oauth_verification_continuations
		    SET attempts = attempts + 1
		  WHERE flow_hash = $1
		    AND consumed_at IS NULL
		    AND expires_at > now()
		    AND attempts < $2
		RETURNING pending_token_sealed, flow_kind,
		          COALESCE(target_org_id::text, ''),
		          COALESCE(cli_client_id, ''), COALESCE(cli_redirect_uri, ''),
		          COALESCE(cli_oauth_state, ''), COALESCE(cli_code_challenge, ''),
		          COALESCE(cli_code_challenge_method, ''), attempts`,
		flowHash, maxVerificationAttempts,
	).Scan(&c.PendingTokenSealed, &c.FlowKind, &c.TargetOrgID,
		&c.CLIClientID, &c.CLIRedirectURI, &c.CLIOAuthState,
		&c.CLICodeChallenge, &c.CLICodeChallengeMethod, &c.Attempts)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reserve OAuth verification attempt: %w", err)
	}
	return &c, nil
}
```

`COALESCE` on every nullable column is what makes the string scan safe **[R2-6]**.

Plus `StoreOAuthVerificationContinuation` (insert, mirroring `StoreCLIPKCERequest`) and
`ConsumeOAuthVerificationContinuation` (`UPDATE ... SET consumed_at = now() WHERE flow_hash
= $1 AND consumed_at IS NULL RETURNING id` — compare-and-set, called only after a
successful verification or on cap exhaustion).

**Step 4: Verify** `go test ./db -v`. **Step 5: Commit.**

---

## Task 5: Shared completion tail that RETURNS a result **[R2-4, R2-8]**

v2 extracted a tail that wrote redirects directly. That breaks the verify endpoint two ways:
a `fetch` follows the CLI loopback redirect (`github_oauth.go:201`) as an XHR rather than a
top-level navigation, and a `Set-Cookie` issued after the response is committed
(`github_oauth.go:225`) is never transmitted.

**Files:**
- Modify: `packages/ingestion/handler/github_oauth.go:156-226`

**Step 1: Green baseline** — `go test ./handler -v`. This task must not change behavior.

**Step 2: Extract** into a function that computes and returns, never writes. Both types are
defined here — v3 referenced `oauthContinuation` without defining it **[R3-4]**:

```go
// Input: the flow context, sourced from the live request on the normal path and
// from the continuation row on the resumed path.
type oauthContinuation struct {
	FlowKind    string // "browser" | "cli"
	TargetOrgID string
	// CLI snapshot; all empty for a browser flow.
	CLIClientID, CLIRedirectURI, CLIOAuthState string
	CLICodeChallenge, CLICodeChallengeMethod   string
}

type completionMode int

const (
	completionBrowser completionMode = iota // mint a browser session
	completionCLI                           // authorization-code hop, NO session cookies
)

// Output: what to deliver. Mode decides whether session cookies exist at all.
type oauthCompletion struct {
	Mode       completionMode
	RedirectTo string // CLI loopback URL, or DashboardOrigin + "/auth/complete"
	// Set only when Mode == completionBrowser. Empty for CLI.
	AccessToken, RefreshToken string
	OrgID                     string
}

func (d *Dependencies) completeOAuthIdentity(ctx context.Context, identity auth.Identity, cont oauthContinuation) (*oauthCompletion, error)
```

**`Mode` is load-bearing [R3-3].** Today the CLI branch returns at `github_oauth.go:204`,
*before* `setAuthCookies` at line 225 — a CLI login deliberately never mints a browser
session. A single struct carrying tokens for both modes would hand CLI logins browser
session cookies, which is a privilege leak. Callers MUST set cookies only when
`Mode == completionBrowser`, and a test must assert that a CLI completion emits no
`Set-Cookie` for the access or refresh cookie.

`OAuthLoginCallback` calls it, then sets cookies (browser mode only) and issues a 302 as
today. The verify endpoint calls it, then sets cookies (browser mode only), **clears the
flow cookie**, and returns `{"redirect_to": ...}` as JSON for the SPA to navigate to — so
cookie writes always precede response commitment **[R2-8]** and the CLI hop becomes a real
top-level navigation **[R2-4]**.

For `flow_kind = 'cli'`, build the loopback redirect from the continuation's own snapshot
columns, and **fail closed** with a distinct error if they are empty **[R2-3]**. Never
silently degrade a CLI login into a browser session.

**Post-verification failure semantics [R3-6].** Once WorkOS has verified the code, the
challenge is spent; a later failure in provisioning, authorization-code storage, or refresh
-token storage cannot be retried against the same continuation. Return a distinct error
saying the identity was verified but the session could not be created, and instruct a fresh
`/auth/login`. That retry now succeeds, because the identity is linked at WorkOS. Log at
ERROR — this path means we lost a session after a successful external side effect.

**Step 3: Verify** `go test ./handler -v` unchanged. **Step 4: Commit.**

---

## Task 6: Handle the challenge in the callback

**Files:**
- Modify: `packages/ingestion/handler/github_oauth.go:144-154`
- Test: `packages/ingestion/handler/github_oauth_test.go`

**Step 1: Failing tests**
- `*auth.PendingVerificationError` → 302 to `<DashboardOrigin>/login?challenge=email`, with
  an `__oauth_verify` cookie: `HttpOnly`, `SameSite=Lax`, `Path=/auth`, and `Secure` from
  `isSecureRequest(r)` (`cookies.go:20`), **not** hardcoded — hardcoding breaks the local
  HTTP test **[R2-9]**.
- The `Location` header and full response body contain neither the pending token nor the
  flow id. Assert on the literal token string.
- Any other exchange error → still 502 `authentication failed`.
- A CLI flow challenge snapshots the PKCE payload into the continuation **[R2-3]**.
- `setup_action=install` + challenge → distinct loud error.
- Continuation write fails → distinct error telling the user to sign in again (OAuth state
  was consumed at line 123, so a fresh login is the only recovery — documented, not silent).

**Step 2: Run, watch fail.**

**Step 3: Implement**

```go
providerCtx, cancel := providerContext(r)
defer cancel()
identity, err := d.provider().ExchangeCode(providerCtx, code)
if err != nil {
	var pending *auth.PendingVerificationError
	if errors.As(err, &pending) {
		d.startOAuthEmailVerification(w, r, pending, installTargetOrgID, state)
		return
	}
	slog.Warn("identity provider code exchange failed", "provider", d.provider().Name(), "error", err)
	writeJSONError(w, http.StatusBadGateway, "authentication failed")
	return
}
```

**Snapshot the CLI payload BEFORE the exchange, not after [R3-3 / R2-3 remainder].**
`cli_pkce_requests` rows live only `authCodeTTL` = 5 minutes (`auth_handlers.go:589`), and
the WorkOS round trip happens inside the callback. If the snapshot is taken after the
exchange, a slow provider response can let the CLI row expire in between, and the flow is
silently reclassified as `browser`. So: immediately after consuming the OAuth login state
(line 123) and before calling `ExchangeCode`, consume `cli_pkce_requests` for this state
hash and hold the payload in memory. On the success path pass it straight to
`completeOAuthIdentity`; on the challenge path persist it into the continuation. If the row
was already gone at that point, the flow is `browser` — a determination made once, before
any network call, so it can never flip.

`startOAuthEmailVerification` rejects an empty pending token, generates a flow id via
`auth.GenerateAuthCode()`, stores only `auth.HashToken(raw)`, seals the pending token with
`auth.PendingCipher` using the flow hash as AAD, writes the already-captured CLI snapshot,
sets the cookie (10-minute TTL) and `Cache-Control: no-store`, then redirects.

Note `providerContext(r)` (`embedded_auth.go:25`) — the callback currently passes the raw
request context while the embedded flow bounds it to 10s **[R2 v2 carry-over]**.

**Step 4: Verify. Step 5: Commit.**

---

## Task 7: `POST /auth/oauth/verify-email` **[R2-2, R2-11]**

Do **not** reuse `POST /auth/verify-email`: it takes the token in the JSON body
(`api.ts:288`) and always calls `completeEmbeddedLogin`, which issues a plain browser
session and would strand CLI state.

**Files:**
- Create: `packages/ingestion/handler/oauth_verify.go`
- Modify: `packages/ingestion/handler/routes.go` (beside line 46)
- Test: `packages/ingestion/handler/oauth_verify_test.go`

**Step 1: Failing tests**
- Happy path: cookie + correct code → identity → `completeOAuthIdentity` → session cookies
  set, flow cookie cleared, `{"redirect_to": ...}` returned.
- Wrong code → 401, **flow survives** (a typo must not force a restart), attempts increments.
- 6th wrong code → flow consumed, cookie cleared, restart required.
- Missing cookie → 400. Unknown/expired/consumed flow → 401 + cookie cleared.
- A `pending_authentication_token` in the request body is ignored, never trusted.
- **Origin enforcement [R2-11]:** requests whose `Origin` is absent or does not equal the
  configured dashboard origin are rejected. CORS config (`routes.go:214`) is not CSRF
  defense; this is an explicit check with its own tests.
- Rate limiting: `d.rateLimitAuth(w, r)` (`embedded_auth.go:105`) applied, with a test.

**Step 2: Run, watch fail.**

**Step 3: Implement** — read cookie → `auth.HashToken` → `ReserveOAuthVerificationAttempt`
(atomic, capped) → `PendingCipher.Open(sealed, flowHash)` →
`EmailVerifier.VerifyEmail(providerCtx, token, code)` → on success
`ConsumeOAuthVerificationContinuation` → **only if that consume returns a row** →
`completeOAuthIdentity` → set cookies (browser mode only) → clear flow cookie → JSON.
`Cache-Control: no-store`. Request body is only `{"code": "..."}`.

**Completion is gated on winning the consume [R3-1].** `ConsumeOAuthVerificationContinuation`
is compare-and-set and returns nil if another request already consumed the flow. Treat nil
as "you lost the race": abort with 401 and issue no session. Without this gate, two
concurrent correct-code submissions could each complete and mint two sessions. Add a
concurrency test asserting exactly one success across N parallel valid submissions.

**Cap exhaustion versus an in-flight success [R3-2].** A wrong code that trips the cap must
not cancel a still-running valid verification. Since both paths finish through the same
compare-and-set consume, define the outcome explicitly: whichever request wins the consume
determines the result, and the loser returns 401 without side effects. Test it — one valid
and one cap-tripping request in flight together, asserting the session is created if and
only if the valid one won.

**Step 4: Verify. Step 5: Commit.**

---

## Task 8: Revalidate target-org membership

`installTargetOrgID` is assigned to the session unconditionally (`github_oauth.go:207`);
membership is only checked inside the native-GitHub install branch, which never runs under
WorkOS.

**Files:** modify `completeOAuthIdentity`.

**Step 1: Failing tests**
- A resumed identity that is not a member of `target_org_id` falls back to its own org and
  never receives a session scoped to the requested org.
- **The membership query returning an error fails closed [R3-7]** — fall back to the user's
  own org and log, never treat a database error as a membership verdict either way. A
  transient error must not silently grant *or* silently revoke org scope.

**Steps 2-4:** implement the membership check before signing the access token; verify.
**Step 5: Commit.**

---

## Task 9: Dashboard API, dev proxy, and composable **[R2-9, R2-10]**

**Files:**
- Modify: `packages/dashboard/vite.config.ts`, `src/api.ts`, `src/types/api.ts`,
  `src/composables/useLoginFlow.ts`
- Test: `packages/dashboard/src/composables/useLoginFlow.test.ts`

**Step 1: Add the dev proxy entry [R2-9].** `vite.config.ts` proxies by prefix and has
`/auth/verify-email`, which does **not** match `/auth/oauth/verify-email`. Without a new
entry the flow 404s under `pnpm dev`:

```ts
      '/auth/oauth': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
```

**Step 2: Failing tests**
- `beginOAuthVerification()` puts the composable in `verify-code` mode holding **no** token.
- `submitVerification` in OAuth mode posts only the code and succeeds. Today it returns
  early unless `pendingAuthenticationToken` is set (`useLoginFlow.ts:127`), so without an
  explicit mode flag it silently no-ops **[R2-10]**.
- "Sign in again" from an OAuth challenge navigates to `/auth/login` rather than calling
  `showSignin`, which with `config === null` would render a password form WorkOS does not
  support **[R2-10]**.

- **A successful OAuth verification navigates the browser to the returned `redirect_to`
  [R3 / R2-4 remainder].** The server returns it as JSON precisely so the client performs a
  real top-level navigation; nothing consumes it yet. For a CLI flow that value is the
  loopback URL, and following it via `fetch` instead of navigation would break the CLI
  handoff. Test that a successful submit triggers navigation to the returned value, and that
  the value is never fetched.

**Step 3: Implement** — add `verificationMode: 'embedded' | 'oauth'`; branch
`submitVerification` on it; add `verifyOAuthEmail(code)` to `api.ts` (credentials included,
no token in the body) and its contract to `types/api.ts`. On success assign
`window.location.href = result.redirect_to` rather than routing internally, so both the
browser and CLI completions land correctly.

**Step 4:** `pnpm --filter @opslane/dashboard test`. **Step 5: Commit.**

---

## Task 10: Login view entry point

`Login.vue` runs `onMounted(loadConfig)` and `loadConfig` overwrites `mode` with
`signin`/`redirect` (`useLoginFlow.ts:52`), clobbering a pre-set verify mode.

**Step 1: Failing test** — mounting with `?challenge=email` ends in `verify-code` mode.

**Step 3: Implement**

```ts
onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('challenge') === 'email') {
    beginOAuthVerification();
    return;
  }
  loadConfig();
});
```

Exactly one initializer runs. Change the copy at `Login.vue:101` to generic text — the OAuth
flow has no email and `PendingVerificationError` carries none. Never read an email from the
URL.

**Step 4:** `pnpm --filter @opslane/dashboard build && test`. **Step 5: Commit.**

---

## Task 11: Live end-to-end verification

Not done until this passes. Reading code is not evidence.

**Step 1: Rebuild** `docker compose up -d --build ingestion worker` and check
`docker compose logs migrate --tail 20`.

**Step 2: Drive the real flow** — `http://localhost:8082`, "Sign in with GitHub" as
`abhishek@opslane.com`, land on the code screen (not raw JSON), read the real emailed code,
submit.

**Step 3: Prove the link happened**

```bash
set -a && source .env && set +a
curl -s -H "Authorization: Bearer $WORKOS_API_KEY" \
  "https://api.workos.com/user_management/users/user_01KXV2DDJ4Y5MKN8AD9KV2K7PP/identities" | python3 -m json.tool
```
Expected: a `GithubOAuth` entry beside `GoogleOAuth`. Before the fix: Google only.

**Step 4: Prove it stays fixed** — sign out, sign in with GitHub again: straight through, no
challenge.

**Step 5: Prove no leak**

```bash
docker compose logs ingestion --since 10m | grep -iE "pending_authentication_token|pat_" || echo "clean: no pending token in logs"
```
Confirm no token or flow id ever appeared in the address bar.

**Step 6: Wrong-code path live** — restart the flow, enter a wrong code, confirm the screen
lets you retry without restarting, then enter the right one.

**Step 7: Full gate**

```bash
pnpm install --frozen-lockfile && pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Step 8: Commit and open the PR.**

---

## Out of scope

- Native-GitHub-provider install flow combined with a verification challenge. Cannot occur
  under WorkOS; would additionally require `identityFromWorkOSUser` to carry a GitHub access
  token. Task 6 fails loudly if it appears.
- Any change to WorkOS dashboard configuration.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 3 | issues_found | R1: 13 findings on design; R2: 11 findings, 9 fixed / 2 partial; R3: 7 new defects, verdict "not safe as written" |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**CODEX:** Three rounds materially changed the design. Round 1 killed a wrong root-cause
attribution (`AuthCallback.vue`) and a self-contradictory token-transport answer. Round 2
forced atomic attempt reservation, a purpose-specific cipher, the CLI TTL snapshot, and the
Vite proxy entry. Round 3 caught a privilege leak (CLI completions minting browser session
cookies) and an unguarded compare-and-set that could mint two sessions concurrently.

**VERDICT:** No review is CLEAR. Codex's last verdict was on v3; v4 answers it but is
unreviewed. Eng review required before implementation.

**UNRESOLVED DECISIONS:**
- v4's [R3-n] fixes have not been re-reviewed by any independent model; the review budget of
  2 iterations is spent.
- Whether to implement this at all, versus making GitHub the primary WorkOS identity so no
  linking challenge ever occurs. Not yet decided by the user.
