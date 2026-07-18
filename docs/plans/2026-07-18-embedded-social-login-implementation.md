# Embedded Social Login Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add "Sign in with Google" and "Sign in with GitHub" buttons to the embedded login card for the WorkOS auth mode, starting the WorkOS OAuth redirect directly instead of the hosted AuthKit picker.

**Architecture:** A new `?provider=` param on the existing `/auth/login` redirect selects a WorkOS social connection. A deployment-declared allowlist (`AUTH_WORKOS_SOCIAL`) drives which buttons render and which `?provider=` values are accepted; the WorkOS dashboard remains authoritative for what actually works. The callback, `ExchangeCode`, and provisioning are unchanged — a social login returns through the same path a WorkOS login uses today.

**Tech Stack:** Go 1.24 + chi (`packages/ingestion`), Vue 3 `<script setup>` + Vitest (`packages/dashboard`), `github.com/workos/workos-go/v9 v9.6.0`.

**Design doc:** `docs/plans/2026-07-18-embedded-social-login-design.md` — read the **Trust model** section before Task 4. The allowlist is UI-capability config and input validation, NOT a security boundary.

**Branch:** `abhishekray07/embedded-social-login`, stacked on PR #97 (`abhishekray07/embedded-auth`). Rebase onto `main` after #97 merges.

---

## Design decisions (read before Task 1)

- **`auth.SocialProvider` is a typed public value** (`"google"`, `"github"`). Handlers and the frontend only ever use these public values. The public → WorkOS translation (`google` → `GoogleOAuth`) lives **only** in `auth/workos.go`.
- **Bare `/auth/login` is unchanged.** No `?provider=` → the current AuthKit redirect, byte-for-byte.
- **The allowlist is one source of truth.** The same `auth.SocialProviderConfig` both renders buttons (`/auth/config`) and validates `?provider=` (`/auth/login`), so they cannot drift.
- **Fail closed at boot.** An unknown value in `AUTH_WORKOS_SOCIAL` refuses to start, matching `SelectAuthProvider`.
- **Config serialization:** `social_providers` is always a non-nil, order-stable `[]string` so it marshals as `[]`, never `null`.
- **No new frontend state.** Social is a full-page navigation, not a `useLoginFlow` transition. The render decision is extracted to a pure helper and unit-tested; the `.vue` stays a thin renderer.

---

### Task 1: `auth.SocialProvider` type, constants, and decoder

Pure additive types in the auth package. No provider wiring yet.

**Files:**
- Create: `packages/ingestion/auth/social.go`
- Test: `packages/ingestion/auth/social_test.go`

**Step 1: Write the failing test**

`packages/ingestion/auth/social_test.go`:

```go
package auth

import "testing"

func TestDecodeSocialProvider(t *testing.T) {
	cases := []struct {
		in    string
		want  SocialProvider
		ok    bool
	}{
		{"google", SocialProviderGoogle, true},
		{"github", SocialProviderGitHub, true},
		{"GOOGLE", SocialProviderGoogle, true}, // case-insensitive
		{" github ", SocialProviderGitHub, true}, // trimmed
		{"facebook", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := DecodeSocialProvider(c.in)
		if ok != c.ok || got != c.want {
			t.Fatalf("DecodeSocialProvider(%q) = (%q, %v), want (%q, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./auth/ -run TestDecodeSocialProvider`
Expected: FAIL — undefined `SocialProvider`, `DecodeSocialProvider`.

**Step 3: Write minimal implementation**

`packages/ingestion/auth/social.go`:

```go
package auth

import "strings"

// SocialProvider is a public, provider-agnostic social login identifier used by
// handlers and the dashboard. The WorkOS-specific spelling lives in workos.go.
type SocialProvider string

const (
	SocialProviderGoogle SocialProvider = "google"
	SocialProviderGitHub SocialProvider = "github"
)

// DecodeSocialProvider maps external input to a known SocialProvider. It trims
// and lowercases, and returns ok=false for anything not in the fixed set, so raw
// request input never becomes a provider value.
func DecodeSocialProvider(raw string) (SocialProvider, bool) {
	switch SocialProvider(strings.ToLower(strings.TrimSpace(raw))) {
	case SocialProviderGoogle:
		return SocialProviderGoogle, true
	case SocialProviderGitHub:
		return SocialProviderGitHub, true
	default:
		return "", false
	}
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go test ./auth/ -run TestDecodeSocialProvider -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/auth/social.go packages/ingestion/auth/social_test.go
git commit -m "feat(auth): typed SocialProvider values and input decoder"
```

---

### Task 2: `SocialProviderConfig` allowlist (ordered slice + set)

The single source of truth for "which social logins are enabled."

**Files:**
- Modify: `packages/ingestion/auth/social.go`
- Test: `packages/ingestion/auth/social_test.go`

**Step 1: Write the failing test**

Append to `social_test.go`:

```go
import "reflect" // add to existing imports

func TestParseSocialProviders(t *testing.T) {
	cfg, err := ParseSocialProviders("google, github ,GOOGLE")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// deduped, lowercased, order preserved by first appearance
	if got := cfg.Ordered(); !reflect.DeepEqual(got, []string{"google", "github"}) {
		t.Fatalf("Ordered() = %v", got)
	}
	if !cfg.Allows(SocialProviderGoogle) || !cfg.Allows(SocialProviderGitHub) {
		t.Fatal("expected google and github allowed")
	}
}

func TestParseSocialProvidersEmptyIsNonNil(t *testing.T) {
	cfg, err := ParseSocialProviders("   ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := cfg.Ordered()
	if got == nil || len(got) != 0 {
		t.Fatalf("Ordered() = %#v, want non-nil empty slice", got)
	}
	if cfg.Allows(SocialProviderGoogle) {
		t.Fatal("empty config must allow nothing")
	}
}

func TestParseSocialProvidersRejectsUnknown(t *testing.T) {
	if _, err := ParseSocialProviders("google,facebook"); err == nil {
		t.Fatal("expected error for unknown provider")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./auth/ -run TestParseSocialProviders`
Expected: FAIL — undefined `ParseSocialProviders`, `SocialProviderConfig`.

**Step 3: Write minimal implementation**

Append to `social.go`:

```go
import "fmt" // add to existing imports (keep "strings")

// SocialProviderConfig is the deployment's enabled social logins. It holds an
// order-stable slice for API responses and a set for O(1) validation, so the
// buttons rendered and the ?provider= values accepted can never drift.
type SocialProviderConfig struct {
	ordered []SocialProvider
	set     map[SocialProvider]struct{}
}

// ParseSocialProviders parses AUTH_WORKOS_SOCIAL ("google,github"). It trims,
// lowercases, and dedupes, preserving first-appearance order. An unrecognized
// value is an error so a typo fails the process at boot instead of silently
// disabling a button.
func ParseSocialProviders(raw string) (SocialProviderConfig, error) {
	cfg := SocialProviderConfig{
		ordered: []SocialProvider{}, // non-nil so callers/JSON see [] not null
		set:     map[SocialProvider]struct{}{},
	}
	for _, part := range strings.Split(raw, ",") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		p, ok := DecodeSocialProvider(part)
		if !ok {
			return SocialProviderConfig{}, fmt.Errorf("unknown social provider %q in AUTH_WORKOS_SOCIAL", strings.TrimSpace(part))
		}
		if _, seen := cfg.set[p]; seen {
			continue
		}
		cfg.set[p] = struct{}{}
		cfg.ordered = append(cfg.ordered, p)
	}
	return cfg, nil
}

// Allows reports whether p is enabled.
func (c SocialProviderConfig) Allows(p SocialProvider) bool {
	_, ok := c.set[p]
	return ok
}

// Ordered returns the enabled providers as public strings for API responses,
// always a non-nil slice.
func (c SocialProviderConfig) Ordered() []string {
	out := make([]string, 0, len(c.ordered))
	for _, p := range c.ordered {
		out = append(out, string(p))
	}
	return out
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go test ./auth/ -v`
Expected: PASS (all auth tests).

**Step 5: Commit**

```bash
git add packages/ingestion/auth/social.go packages/ingestion/auth/social_test.go
git commit -m "feat(auth): SocialProviderConfig allowlist parsing"
```

---

### Task 3: `AuthRequest.SocialProvider` + WorkOS authorize-URL translation

Thread the selected provider into the WorkOS authorization URL. The WorkOS spelling stays in `workos.go`.

**Files:**
- Modify: `packages/ingestion/auth/provider.go:7-10` (add field to `AuthRequest`)
- Modify: `packages/ingestion/auth/workos.go:26-36` (`AuthorizationURL`)
- Test: `packages/ingestion/auth/workos_test.go`

**Step 1: Write the failing test**

Append to `workos_test.go` (it already builds the URL via the real client in `TestWorkOSAuthorizeURLIncludesProvider`-style tests — mirror that). Add:

```go
func TestWorkOSAuthorizeURLUsesSocialProvider(t *testing.T) {
	provider, err := NewWorkOSProvider("sk_test", "client_test")
	if err != nil {
		t.Fatalf("NewWorkOSProvider: %v", err)
	}
	url, err := provider.AuthorizeURL(AuthRequest{
		State: "s", RedirectURI: "https://app.example/auth/callback",
		SocialProvider: SocialProviderGoogle,
	})
	if err != nil {
		t.Fatalf("AuthorizeURL: %v", err)
	}
	if !strings.Contains(url, "provider=GoogleOAuth") {
		t.Fatalf("want provider=GoogleOAuth, got %s", url)
	}

	url, _ = provider.AuthorizeURL(AuthRequest{State: "s", RedirectURI: "https://app.example/auth/callback"})
	if !strings.Contains(url, "provider=authkit") {
		t.Fatalf("empty SocialProvider must default to authkit, got %s", url)
	}
}
```

Ensure `"strings"` is imported in the test file.

**Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./auth/ -run TestWorkOSAuthorizeURLUsesSocialProvider`
Expected: FAIL — `AuthRequest` has no field `SocialProvider`.

**Step 3: Write minimal implementation**

In `provider.go`, extend `AuthRequest`:

```go
type AuthRequest struct {
	State       string
	RedirectURI string
	// SocialProvider, when set, selects a specific WorkOS social connection
	// (e.g. google) and skips the hosted AuthKit picker. Empty uses AuthKit.
	SocialProvider SocialProvider
}
```

In `workos.go`, replace `AuthorizationURL`:

```go
// workOSProviderParam maps our public SocialProvider to WorkOS's provider value.
// This is the ONLY place WorkOS's vocabulary appears for social login.
func workOSProviderParam(p SocialProvider) (string, bool) {
	switch p {
	case SocialProviderGoogle:
		return "GoogleOAuth", true
	case SocialProviderGitHub:
		return "GitHubOAuth", true
	default:
		return "", false
	}
}

func (c workOSSDKClient) AuthorizationURL(req AuthRequest) (string, error) {
	state := req.State
	// Default to the AuthKit hosted picker. Without a provider WorkOS cannot
	// pick a connection and redirects to invalid-connection-selector.
	provider := "authkit"
	if req.SocialProvider != "" {
		if mapped, ok := workOSProviderParam(req.SocialProvider); ok {
			provider = mapped
		}
	}
	return c.client.GetAuthKitAuthorizationURL(workos.AuthKitAuthorizationURLParams{
		RedirectURI: req.RedirectURI,
		Provider:    &provider,
		State:       &state,
	})
}
```

Note: `GitHubProvider.AuthorizeURL` ignores `SocialProvider` — no change needed there.

**Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go test ./auth/ -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/auth/provider.go packages/ingestion/auth/workos.go packages/ingestion/auth/workos_test.go
git commit -m "feat(auth): select WorkOS social provider in the authorization URL"
```

---

### Task 4: `/auth/login?provider=` validation with a side-effect-free 400

The provider param is validated **before** any state is minted. Read the design's Trust model + Section 3 first.

**Files:**
- Modify: `packages/ingestion/handler/auth.go:66-85` (add `SocialProviders auth.SocialProviderConfig` to `Dependencies`)
- Modify: `packages/ingestion/handler/github_oauth.go:23-33` (`OAuthLoginStart`), `:41-49` (`redirectToProvider` signature)
- Test: `packages/ingestion/handler/github_oauth_test.go` (create if absent, else append)

**Step 1: Write the failing test**

Append/create `packages/ingestion/handler/github_oauth_test.go`:

```go
func TestOAuthLoginRejectsDisabledProviderWithoutSideEffects(t *testing.T) {
	cfg, _ := auth.ParseSocialProviders("google") // github NOT enabled
	deps := &Dependencies{
		AuthProvider:    &embeddedAuthProvider{},
		SocialProviders: cfg,
		JWTSecret:       []byte("test-secret-at-least-32-bytes-long!!"),
	}
	recorder := httptest.NewRecorder()
	deps.OAuthLoginStart(recorder, httptest.NewRequest(http.MethodGet, "/auth/login?provider=github", nil))

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Location") != "" {
		t.Fatal("rejection must not set Location")
	}
	if recorder.Header().Get("Set-Cookie") != "" {
		t.Fatal("rejection must not set the __auth_state cookie")
	}
}

func TestOAuthLoginRejectsUnknownProvider(t *testing.T) {
	cfg, _ := auth.ParseSocialProviders("google,github")
	deps := &Dependencies{AuthProvider: &embeddedAuthProvider{}, SocialProviders: cfg,
		JWTSecret: []byte("test-secret-at-least-32-bytes-long!!")}
	recorder := httptest.NewRecorder()
	deps.OAuthLoginStart(recorder, httptest.NewRequest(http.MethodGet, "/auth/login?provider=evil", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status=%d", recorder.Code)
	}
}
```

(`embeddedAuthProvider` already exists in `embedded_auth_test.go` in the same package.)

**Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./handler/ -run TestOAuthLoginRejects`
Expected: FAIL — `Dependencies` has no `SocialProviders`; login builds a URL/redirect instead of 400.

**Step 3: Write minimal implementation**

Add to `Dependencies` (`auth.go`, near `AuthProvider`):

```go
	// SocialProviders is the deployment's enabled embedded social logins. Empty
	// for non-WorkOS providers.
	SocialProviders auth.SocialProviderConfig
```

Rewrite the top of `OAuthLoginStart` (`github_oauth.go`) to validate first:

```go
func (d *Dependencies) OAuthLoginStart(w http.ResponseWriter, r *http.Request) {
	var social auth.SocialProvider
	if raw := r.URL.Query().Get("provider"); raw != "" {
		p, ok := auth.DecodeSocialProvider(raw)
		if !ok || !d.SocialProviders.Allows(p) {
			// UI-capability + input validation only (see design Trust model).
			// Reject BEFORE minting any state: no cookie, no stored state, no redirect.
			writeJSONError(w, http.StatusBadRequest, "unsupported sign-in provider")
			return
		}
		social = p
	}
	state, err := generateOAuthState(d.JWTSecret)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if err := d.redirectToProvider(w, r, state, social); err != nil {
		slog.Error("build provider authorization URL failed", "provider", d.provider().Name(), "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "authentication provider is not configured")
	}
}
```

Thread `social` through `redirectToProvider` (`github_oauth.go:41`):

```go
func (d *Dependencies) redirectToProvider(w http.ResponseWriter, r *http.Request, state string, social auth.SocialProvider) error {
	callbackOrigin := d.AuthCallbackOrigin
	if callbackOrigin == "" {
		callbackOrigin = "http://localhost:8080"
	}
	redirectURL, err := d.provider().AuthorizeURL(auth.AuthRequest{
		State:          state,
		RedirectURI:    callbackOrigin + "/auth/callback",
		SocialProvider: social,
	})
	// ... rest unchanged
```

**Update the other caller.** `redirectToProvider` is also called at `packages/ingestion/handler/auth_handlers.go:593` (the CLI/PKCE authorize path). Change that call to pass an empty `SocialProvider` — it must keep using the AuthKit picker:

```go
if err := d.redirectToProvider(w, r, providerState, ""); err != nil {
```

`GitHubOAuthStart` delegates to `OAuthLoginStart` and needs no change. Grep `redirectToProvider(` to confirm both call sites now pass the new arity.

**Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go build ./... && go test ./handler/ -run TestOAuthLogin -v`
Expected: PASS. Also run the full `go test ./...` to catch arity breaks.

**Step 5: Commit**

```bash
git add packages/ingestion/handler/auth.go packages/ingestion/handler/github_oauth.go packages/ingestion/handler/github_oauth_test.go
git commit -m "feat(ingestion): validate ?provider= on /auth/login with a side-effect-free 400"
```

---

### Task 5: `/auth/config` reports `social_providers`

**Files:**
- Modify: `packages/ingestion/handler/embedded_auth.go` (`AuthConfig`)
- Test: `packages/ingestion/handler/embedded_auth_test.go`

**Step 1: Write the failing test**

Append to `embedded_auth_test.go`:

```go
func TestAuthConfigReportsSocialProviders(t *testing.T) {
	cfg, _ := auth.ParseSocialProviders("google,github")
	recorder := httptest.NewRecorder()
	(&Dependencies{AuthProvider: &embeddedAuthProvider{}, SocialProviders: cfg}).
		AuthConfig(recorder, embeddedRequest(http.MethodGet, "/auth/config", ""))
	if !strings.Contains(recorder.Body.String(), `"social_providers":["google","github"]`) {
		t.Fatalf("body=%s", recorder.Body.String())
	}
}

func TestAuthConfigSocialProvidersEmptyIsArrayNotNull(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Dependencies{AuthProvider: &embeddedAuthProvider{}}).
		AuthConfig(recorder, embeddedRequest(http.MethodGet, "/auth/config", ""))
	if !strings.Contains(recorder.Body.String(), `"social_providers":[]`) {
		t.Fatalf("empty must serialize as [], body=%s", recorder.Body.String())
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./handler/ -run TestAuthConfig`
Expected: FAIL — no `social_providers` key.

**Step 3: Write minimal implementation**

In `AuthConfig`, add to the encoded map:

```go
	_ = json.NewEncoder(w).Encode(map[string]any{
		"provider":          provider.Name(),
		"supports_password": supportsPassword,
		"supports_signup":   supportsSignup,
		"supports_reset":    supportsReset,
		"social_providers":  d.SocialProviders.Ordered(), // non-nil slice → [] not null
	})
```

**Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go test ./handler/ -run TestAuthConfig -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/handler/embedded_auth.go packages/ingestion/handler/embedded_auth_test.go
git commit -m "feat(ingestion): advertise social_providers in /auth/config"
```

---

### Task 6: Boot wiring, Compose, and env docs (drift-gated)

`main.go` reads the env var; Compose forwards it; the env doc row is mandatory or `pnpm test` fails.

**Files:**
- Modify: `packages/ingestion/main.go:90-124`
- Modify: `docker-compose.yml` (ingestion `environment:` block, near `WORKOS_CLIENT_ID`)
- Modify: `docs/reference/environment-variables.md` (Ingestion API table)

**Step 1: Wire `main.go`**

After `authProvider` is selected and before building `deps`:

```go
	socialProviders, err := auth.ParseSocialProviders(os.Getenv("AUTH_WORKOS_SOCIAL"))
	if err != nil {
		slog.Error("invalid AUTH_WORKOS_SOCIAL", "error", err)
		os.Exit(1)
	}
	if len(socialProviders.Ordered()) > 0 && authProvider.Name() != "workos" {
		slog.Warn("AUTH_WORKOS_SOCIAL is set but AUTH_PROVIDER is not workos; ignoring social buttons",
			"provider", authProvider.Name())
		socialProviders, _ = auth.ParseSocialProviders("")
	}
```

Add to the `Dependencies` literal:

```go
		SocialProviders:       socialProviders,
```

**Step 2: Forward in `docker-compose.yml`**

Add under the ingestion `environment:` block, next to `WORKOS_CLIENT_ID`:

```yaml
      AUTH_WORKOS_SOCIAL: ${AUTH_WORKOS_SOCIAL:-}
```

**Step 3: Document in `environment-variables.md`**

Add a row to the Ingestion API table (below `WORKOS_CLIENT_ID`):

```markdown
| `AUTH_WORKOS_SOCIAL` | no | Comma-separated social login buttons to show under `AUTH_PROVIDER=workos` (e.g. `google,github`). UI capability only; the WorkOS dashboard governs which methods actually work. |
```

**Step 4: Verify (build + drift gate)**

Run:
```bash
cd packages/ingestion && go build ./... && go test ./...
```
Then from repo root, run the docs drift check the way CI does:
```bash
node scripts/check-docs-drift.mjs
```
Expected: build/tests PASS; drift check PASS (fails if the env var lacks a doc row).

**Step 5: Commit**

```bash
git add packages/ingestion/main.go docker-compose.yml docs/reference/environment-variables.md
git commit -m "feat(ingestion): wire AUTH_WORKOS_SOCIAL through boot, compose, and env docs"
```

---

### Task 7: Dashboard types + pure `socialProviderButtons` helper

The render decision is a pure function, unit-tested in Node (no jsdom). The `.vue` stays a thin renderer.

**Files:**
- Modify: `packages/dashboard/src/types/api.ts` (`AuthConfig`)
- Create: `packages/dashboard/src/composables/socialProviders.ts`
- Test: `packages/dashboard/src/composables/socialProviders.test.ts`
- Modify: any existing `AuthConfig` fixtures in `packages/dashboard/src/**/__tests__` and `useLoginFlow.test.ts` / `embedded-auth-api.test.ts` to include `social_providers: []`.

**Step 1: Types**

In `types/api.ts`, extend `AuthConfig`:

```ts
export type SocialProviderId = 'google' | 'github';

export interface AuthConfig {
  provider: string;
  supports_password: boolean;
  supports_signup: boolean;
  supports_reset: boolean;
  social_providers: SocialProviderId[];
}
```

Update the `embeddedConfig` fixture in `useLoginFlow.test.ts` and any other `AuthConfig` literal to add `social_providers: []` (TypeScript build will point out each).

**Step 2: Write the failing test**

`packages/dashboard/src/composables/socialProviders.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { socialProviderButtons } from './socialProviders';

describe('socialProviderButtons', () => {
  it('returns a button per configured provider, in order', () => {
    expect(socialProviderButtons(['github', 'google'])).toEqual([
      { id: 'github', label: 'Continue with GitHub', href: '/auth/login?provider=github' },
      { id: 'google', label: 'Continue with Google', href: '/auth/login?provider=google' },
    ]);
  });

  it('returns an empty array when nothing is configured', () => {
    expect(socialProviderButtons([])).toEqual([]);
  });

  it('ignores unknown ids defensively', () => {
    // @ts-expect-error exercising a malformed config value
    expect(socialProviderButtons(['myspace'])).toEqual([]);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm --filter @opslane/dashboard test -- socialProviders`
Expected: FAIL — module not found.

**Step 4: Implement**

`packages/dashboard/src/composables/socialProviders.ts`:

```ts
import type { SocialProviderId } from '../types/api';

export interface SocialButton {
  id: SocialProviderId;
  label: string;
  href: string;
}

const LABELS: Record<SocialProviderId, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

export function socialProviderButtons(providers: SocialProviderId[]): SocialButton[] {
  return providers
    .filter((id): id is SocialProviderId => id in LABELS)
    .map((id) => ({ id, label: LABELS[id], href: `/auth/login?provider=${id}` }));
}
```

**Step 5: Run tests, then commit**

Run: `pnpm --filter @opslane/dashboard test` and `pnpm --filter @opslane/dashboard build`
Expected: PASS (all dashboard tests, including updated fixtures) and a clean build.

```bash
git add packages/dashboard/src/types/api.ts packages/dashboard/src/composables/socialProviders.ts packages/dashboard/src/composables/socialProviders.test.ts packages/dashboard/src/composables/useLoginFlow.test.ts packages/dashboard/src/__tests__/embedded-auth-api.test.ts
git commit -m "feat(dashboard): typed social_providers config and pure button helper"
```

---

### Task 8: Render social buttons in `Login.vue`

Thin rendering only — no logic beyond calling the helper and navigating.

**Files:**
- Modify: `packages/dashboard/src/views/Login.vue`

**Step 1: Script — derive buttons from config**

In `<script setup>`, after `useLoginFlow(...)` returns `config`:

```ts
import { computed } from 'vue';
import { socialProviderButtons } from '../composables/socialProviders';

const socialButtons = computed(() => socialProviderButtons(config.value?.social_providers ?? []));

function startSocial(href: string): void {
  window.location.href = href;
}
```

**Step 2: Template — buttons + divider above the email form**

Inside the signin/signup card block (the `v-else` branch that renders the email form), directly above the `<form>`:

```html
<div v-if="socialButtons.length" class="mb-6 space-y-2">
  <button
    v-for="btn in socialButtons"
    :key="btn.id"
    type="button"
    class="w-full flex items-center justify-center gap-3 rounded-md bg-surface-2 border border-border px-4 py-3 text-sm font-medium text-text hover:bg-border focus:outline-none focus:ring-2 focus:ring-teal focus:ring-offset-2 focus:ring-offset-background transition-colors"
    @click="startSocial(btn.href)"
  >
    {{ btn.label }}
  </button>
  <div class="flex items-center gap-3 pt-2 text-xs text-text-muted">
    <span class="h-px flex-1 bg-border"></span>
    or continue with email
    <span class="h-px flex-1 bg-border"></span>
  </div>
</div>
```

Optionally add the same block to the `redirect`-mode card so a password-less WorkOS setup still gets social buttons. Reuse the existing GitHub SVG for the GitHub button if you want icons (label-only is acceptable for v1).

**Step 3: Verify build + existing tests**

Run: `pnpm --filter @opslane/dashboard build` and `pnpm --filter @opslane/dashboard test`
Expected: build succeeds; all tests still PASS (no new component test — see Task 9 for coverage rationale).

**Step 4: Commit**

```bash
git add packages/dashboard/src/views/Login.vue
git commit -m "feat(dashboard): render social login buttons on the login card"
```

---

### Task 9: Full gate, coverage note, and live smoke

**Step 1: Full repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

All must pass. `pnpm test` includes the docs drift check from Task 6.

**Step 2: Frontend coverage rationale (record, don't skip)**

The config→buttons decision is covered by `socialProviders.test.ts` (Task 7). The `.vue` only renders that output and calls `window.location`. A route-mocked Playwright test against the dashboard SPA is deferred: `test-e2e` currently serves the SDK fixture apps, not the dashboard build, so wiring it to serve and intercept `/auth/config` is its own task. Note this explicitly in the PR description rather than implying full DOM coverage. Real DOM + navigation is covered by the live smoke below.

**Step 3: Live smoke (WorkOS staging with Google enabled)**

1. In WorkOS staging, enable the Google OAuth auth method; set `AUTH_WORKOS_SOCIAL=google`.
2. Start the stack with WorkOS staging creds.
3. Load `/login` → the Google button and the "or continue with email" divider render above the password form.
4. Click Google → WorkOS → Google consent → back through `/auth/callback` → dashboard with cookies set.
5. Manually request `/auth/login?provider=github` (GitHub not in the list) → 400, no redirect.
6. Regression: bare `/auth/login` still reaches the AuthKit page; password sign-in still works.

**Step 4: Hand off for PR**

Pushing is blocked by a repo hook — ask the user to run `! git push -u origin abhishekray07/embedded-social-login`, then open the PR with `gh pr create`. Base the PR on `abhishekray07/embedded-auth` (stacked on #97) until #97 merges, then retarget to `main`.

---

## Explicitly out of scope (do not build now)

- **Microsoft/other WorkOS social providers** — one decoder case + one env value + one adapter map entry each.
- **Server-side method-binding enforcement** — the WorkOS dashboard is authoritative; see design Trust model. Only add if strict enforcement is required.
- **SSO/SAML enterprise connections.**
- **Self-hosted native Google** — the OSS GitHub build has no Google provider.
- **Dashboard-serving Playwright harness** — deferred per Task 9 rationale.
