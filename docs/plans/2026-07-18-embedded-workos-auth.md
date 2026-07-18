# Embedded WorkOS Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the redirect to WorkOS's hosted AuthKit page with a native login/sign-up form in the Opslane dashboard, with the Go backend calling the WorkOS User Management API server-side.

**Architecture:** The browser never talks to WorkOS. The dashboard posts JSON to new `/auth/*` endpoints on the ingestion service. Those handlers call WorkOS server-to-server (password auth, sign-up, email verification, password reset), then reuse the existing local provisioning (`ProvisionFromIdentity`) and session code (`issueTokenPairCookie`). Opslane sessions stay local JWTs + refresh cookies, exactly as today — we do NOT adopt WorkOS sealed sessions. The old redirect flow (`/auth/login` → hosted AuthKit → `/auth/callback`) stays untouched for the CLI PKCE bridge and WorkOS impersonation.

**Tech Stack:** Go 1.24 + `github.com/workos/workos-go/v9 v9.6.0` (already in go.mod), Vue 3 `<script setup>`, existing chi routes.

**Modeled on:** [workos/workos-custom-ui-authkit-example](https://github.com/workos/workos-custom-ui-authkit-example) — we borrow its route shapes (`POST /api/auth/password`, error taxonomy with `pending_authentication_token`, single-page login state machine). We deliberately diverge in two ways: (1) no sealed sessions — Opslane already mints its own tokens; (2) we add sign-up/email-verification/password-reset, which the example omits but the Go SDK supports.

---

## Prerequisites (manual, WorkOS dashboard — do first)

1. In the WorkOS dashboard → Authentication, enable **Password** and **Email verification** auth methods for the environment.
2. Set the **Password reset URL** to `<dashboard-origin>/reset-password` (per environment: localhost for dev, app domain for prod).
3. Keep the existing redirect URI registered — the legacy callback still serves the CLI and impersonation.
4. Confirm `WORKOS_API_KEY` + `WORKOS_CLIENT_ID` env vars are set (unchanged; no new env vars needed).

Note from prior testing: hosted AuthKit blocked headless browsers. The embedded form is our own page, so headless E2E becomes possible after this work.

---

## Design decisions (read before Task 1)

- **Capability interfaces, not a fatter `AuthProvider`.** `AuthProvider` (`auth/provider.go:25`) stays as-is so `GitHubProvider` is untouched. New optional interfaces (`PasswordAuthenticator`, `UserRegistrar`, `EmailVerifier`, `PasswordResetter`) live in `auth/`; handlers type-assert. Self-hosted GitHub installs return the current behavior automatically.
- **Typed errors at the package boundary.** Handlers must not import the workos SDK. `WorkOSProvider` translates `*workos.APIError` into `auth`-package errors: `ErrInvalidCredentials`, `*PendingVerificationError` (carries `PendingAuthenticationToken`), `ErrUnsupportedChallenge` (MFA/SSO/org-selection — defensive, we don't enable those). SDK error-code constants: `workos.EmailVerificationRequiredCode`, `workos.MFAChallengeCode`, `workos.MFAEnrollmentCode`, `workos.OrganizationSelectionRequiredCode`, `workos.SSORequiredCode`.
- **Sign-up flow shape:** `Create` user with password → immediately `AuthenticateWithPassword` → WorkOS returns `email_verification_required` + pending token and emails a 6-digit code → frontend shows code entry → `AuthenticateWithEmailVerification(code, pendingToken)` → identity → provision + cookies. Email verification is effectively **required**, not optional: `ProvisionFromIdentity` refuses unverified identities (verified-email gate, see `db/provisioning_test.go:71`), so do not build a "verification disabled" branch — if an authenticate ever succeeds with `EmailVerified: false`, provisioning correctly rejects it and the handler returns the provisioning error.
- **Signup is two non-atomic WorkOS calls** (`Create`, then authenticate). If `Create` succeeded but the client retried (network blip), a naive handler would say "email already exists" to the account's own creator. Healing rule: when `RegisterUser` returns `ErrEmailTaken`, still attempt `AuthenticateWithPassword` with the submitted credentials — if it succeeds or returns pending-verification, continue; only surface 409 when that attempt fails with invalid credentials.
- **WorkOS access/refresh tokens from `AuthenticateResponse` are discarded.** We only use `response.User` for identity, same as `ExchangeCode` today.
- **Frontend discovery:** new unauthenticated `GET /auth/config` returns per-capability flags — `{"provider":"workos","supports_password":true,"supports_signup":true,"supports_reset":true}` — one flag per type-asserted capability interface, so a future provider that supports login but not sign-up doesn't render dead buttons. `Login.vue` renders the embedded form when `supports_password`, else the current redirect button.
- **Every new POST handler:** `r.Body = http.MaxBytesReader(w, r.Body, 1<<16)` before decoding (matches `auth_handlers.go:251`) and the shared `loginLimiter` (`auth_handlers.go:124`) check first — these endpoints are unauthenticated and take credentials; there is NO route-group middleware providing either (the existing limiter is called inside `oauthAuthorizePOST`, not as middleware).
- **Password reset revokes local sessions.** WorkOS changing the password does nothing to Opslane's own 30-day refresh tokens — a stolen session would survive the reset. After `CompletePasswordReset` succeeds, look up the local user by email and call `Queries.RevokeAllUserRefreshTokens` (`db/queries.go:2110`). Use the existing user-by-email query if one exists; add a scoped one if not.
- **Handler test strategy (decided, don't re-litigate in execution):** `Dependencies.Queries` is a concrete `*db.Queries`, and existing handler tests (`callback_test.go`) build `Dependencies` with stub providers and nil/omitted Queries. Follow that: handler unit tests cover request validation, capability-negotiation 404s, error mapping, and the pending-verification passthrough — everything up to provisioning. The provisioning happy path is already covered by `db/provisioning_test.go` and gets end-to-end coverage in the Task 9 live smoke. Do not introduce a provisioner seam.

New endpoint summary (all JSON, all on ingestion):

| Route | Purpose | Success | Notable non-200s |
|---|---|---|---|
| `GET /auth/config` | which login UI to render | `{provider, supports_password}` | — |
| `POST /auth/password` | sign in | cookie session + `{expires_in, user}` | 401 bad creds; 403 `{status:"email_verification_required", pending_authentication_token}` |
| `POST /auth/signup` | create account | 403 verification-pending (verification is required; see design decisions) | 409 email exists (only after the healing re-auth attempt fails) |
| `POST /auth/verify-email` | finish sign-up | cookie session + `{expires_in, user}` | 401 bad/expired code |
| `POST /auth/password/forgot` | start reset | 202 `{status:"sent"}` (always, anti-enumeration) | — |
| `POST /auth/password/reset` | finish reset | 200 `{status:"reset"}` | 401 bad/expired token |

---

### Task 1: Extract shared identity mapping in `auth/workos.go`

Pure refactor — the user→Identity mapping in `ExchangeCode` will be needed by three new methods.

**Files:**
- Modify: `packages/ingestion/auth/workos.go:60-94`
- Test: existing `packages/ingestion/auth/workos_test.go` (no new tests; behavior unchanged)

**Step 1: Refactor**

Replace the body of `ExchangeCode` so mapping lives in a helper:

```go
func identityFromWorkOSUser(user *workos.User) Identity {
	name := ""
	if user.Name != nil {
		name = *user.Name
	} else {
		parts := make([]string, 0, 2)
		if user.FirstName != nil {
			parts = append(parts, *user.FirstName)
		}
		if user.LastName != nil {
			parts = append(parts, *user.LastName)
		}
		name = strings.Join(parts, " ")
	}
	avatarURL := ""
	if user.ProfilePictureURL != nil {
		avatarURL = *user.ProfilePictureURL
	}
	return Identity{
		Provider:        "workos",
		ProviderSubject: user.ID,
		Email:           user.Email,
		EmailVerified:   user.EmailVerified,
		Name:            name,
		AvatarURL:       avatarURL,
	}
}

func (p *WorkOSProvider) ExchangeCode(ctx context.Context, code string) (Identity, error) {
	response, err := p.client.AuthenticateCode(ctx, code)
	if err != nil {
		return Identity{}, err
	}
	if response == nil || response.User == nil {
		return Identity{}, fmt.Errorf("WorkOS authentication response did not include a user")
	}
	return identityFromWorkOSUser(response.User), nil
}
```

**Step 2: Verify green**

Run: `cd packages/ingestion && go test ./auth/`
Expected: PASS (existing `TestWorkOSProviderMapsIdentity` still covers the mapping).

**Step 3: Commit**

```bash
git add packages/ingestion/auth/workos.go
git commit -m "refactor(auth): extract identityFromWorkOSUser for reuse by embedded flows"
```

---

### Task 2: Capability interfaces and typed errors in `auth` package

**Files:**
- Create: `packages/ingestion/auth/embedded.go`
- Test: `packages/ingestion/auth/embedded_test.go`

**Step 1: Write the failing test**

```go
package auth

import (
	"errors"
	"testing"
)

func TestPendingVerificationErrorCarriesToken(t *testing.T) {
	var target *PendingVerificationError
	err := error(&PendingVerificationError{PendingAuthenticationToken: "pat_1", EmailVerificationID: "ev_1"})
	if !errors.As(err, &target) {
		t.Fatal("errors.As should match *PendingVerificationError")
	}
	if target.PendingAuthenticationToken != "pat_1" {
		t.Fatalf("token = %q", target.PendingAuthenticationToken)
	}
	if err.Error() == "" {
		t.Fatal("Error() must be non-empty")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./auth/ -run TestPendingVerification -v`
Expected: FAIL — `undefined: PendingVerificationError`

**Step 3: Write minimal implementation**

`packages/ingestion/auth/embedded.go`:

```go
package auth

import (
	"context"
	"errors"
)

// Optional capabilities an AuthProvider may support for embedded (no-redirect)
// login. Handlers type-assert; providers without a capability keep the
// redirect flow.

type PasswordAuthenticator interface {
	AuthenticateWithPassword(ctx context.Context, email, password string) (Identity, error)
}

type UserRegistrar interface {
	// RegisterUser creates the user at the identity provider. It does not log
	// the user in; callers follow with AuthenticateWithPassword.
	RegisterUser(ctx context.Context, email, password string) error
}

type EmailVerifier interface {
	VerifyEmail(ctx context.Context, pendingAuthenticationToken, code string) (Identity, error)
}

type PasswordResetter interface {
	StartPasswordReset(ctx context.Context, email string) error
	CompletePasswordReset(ctx context.Context, token, newPassword string) error
}

// ErrInvalidCredentials means the email/password (or code/token) was rejected.
var ErrInvalidCredentials = errors.New("invalid credentials")

// ErrEmailTaken means registration failed because the email already has an account.
var ErrEmailTaken = errors.New("email already registered")

// ErrWeakPassword means the identity provider rejected the password against its
// strength policy.
var ErrWeakPassword = errors.New("password does not meet strength requirements")

// ErrUnsupportedChallenge means the provider demanded a step (MFA, SSO,
// organization selection) that the embedded flow does not implement.
var ErrUnsupportedChallenge = errors.New("authentication requires an unsupported additional step")

// PendingVerificationError means authentication is valid but the email is not
// verified yet; the provider has emailed a code and the flow continues with
// EmailVerifier.VerifyEmail.
type PendingVerificationError struct {
	PendingAuthenticationToken string
	EmailVerificationID        string
}

func (e *PendingVerificationError) Error() string {
	return "email verification required"
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go test ./auth/ -run TestPendingVerification -v`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ingestion/auth/embedded.go packages/ingestion/auth/embedded_test.go
git commit -m "feat(auth): capability interfaces and typed errors for embedded login"
```

---

### Task 3: `WorkOSProvider.AuthenticateWithPassword` + error translation

**Files:**
- Modify: `packages/ingestion/auth/workos.go` (interface `workOSClient`, sdk client, provider method, `translateWorkOSError`)
- Test: `packages/ingestion/auth/workos_test.go` (extend `fakeWorkOSClient`)

**Step 1: Write the failing tests**

Extend the fake and add cases (append to `workos_test.go`):

```go
// extend fakeWorkOSClient
type fakeWorkOSClient struct {
	response *workos.AuthenticateResponse
	err      error
}

func (f fakeWorkOSClient) AuthenticatePassword(context.Context, string, string) (*workos.AuthenticateResponse, error) {
	return f.response, f.err
}

func TestAuthenticateWithPasswordMapsIdentity(t *testing.T) {
	provider := newWorkOSProviderWithClient(fakeWorkOSClient{response: &workos.AuthenticateResponse{
		User: &workos.User{ID: "user_9", Email: "a@b.co", EmailVerified: true},
	}})
	identity, err := provider.AuthenticateWithPassword(context.Background(), "a@b.co", "hunter22")
	if err != nil {
		t.Fatalf("AuthenticateWithPassword: %v", err)
	}
	if identity.ProviderSubject != "user_9" || identity.Provider != "workos" {
		t.Fatalf("unexpected identity: %+v", identity)
	}
}

func TestAuthenticateWithPasswordTranslatesErrors(t *testing.T) {
	cases := []struct {
		name    string
		sdkErr  error
		check   func(t *testing.T, err error)
	}{
		{
			name:   "email verification pending",
			sdkErr: &workos.APIError{ErrorCode: workos.EmailVerificationRequiredCode, PendingAuthenticationToken: "pat_1", EmailVerificationID: "ev_1"},
			check: func(t *testing.T, err error) {
				var pending *PendingVerificationError
				if !errors.As(err, &pending) || pending.PendingAuthenticationToken != "pat_1" {
					t.Fatalf("want PendingVerificationError with token, got %v", err)
				}
			},
		},
		{
			name:   "bad password",
			sdkErr: &workos.AuthenticationError{APIError: &workos.APIError{StatusCode: 401, ErrorCode: "invalid_credentials"}},
			check: func(t *testing.T, err error) {
				if !errors.Is(err, ErrInvalidCredentials) {
					t.Fatalf("want ErrInvalidCredentials, got %v", err)
				}
			},
		},
		{
			name:   "mfa challenge unsupported",
			sdkErr: &workos.APIError{ErrorCode: workos.MFAChallengeCode, PendingAuthenticationToken: "pat_2"},
			check: func(t *testing.T, err error) {
				if !errors.Is(err, ErrUnsupportedChallenge) {
					t.Fatalf("want ErrUnsupportedChallenge, got %v", err)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			provider := newWorkOSProviderWithClient(fakeWorkOSClient{err: tc.sdkErr})
			_, err := provider.AuthenticateWithPassword(context.Background(), "a@b.co", "x")
			tc.check(t, err)
		})
	}
}
```

Add `"errors"` to the test imports.

**Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && go test ./auth/ -run "TestAuthenticateWithPassword" -v`
Expected: FAIL — compile error, `AuthenticatePassword` not in interface / method undefined.

**Step 3: Write minimal implementation**

In `workos.go`:

```go
type workOSClient interface {
	AuthorizationURL(AuthRequest) (string, error)
	AuthenticateCode(context.Context, string) (*workos.AuthenticateResponse, error)
	AuthenticatePassword(ctx context.Context, email, password string) (*workos.AuthenticateResponse, error)
}

func (c workOSSDKClient) AuthenticatePassword(ctx context.Context, email, password string) (*workos.AuthenticateResponse, error) {
	return c.client.UserManagement().AuthenticateWithPassword(ctx, &workos.UserManagementAuthenticateWithPasswordParams{
		Email:    email,
		Password: password,
	})
}

// translateWorkOSError converts SDK errors into auth-package errors so handlers
// never import the workos SDK. Unknown errors pass through for logging.
func translateWorkOSError(err error) error {
	var apiErr *workos.APIError
	if !errors.As(err, &apiErr) {
		return err
	}
	code := apiErr.Code
	if code == "" {
		code = apiErr.ErrorCode
	}
	switch code {
	case workos.EmailVerificationRequiredCode:
		return &PendingVerificationError{
			PendingAuthenticationToken: apiErr.PendingAuthenticationToken,
			EmailVerificationID:        apiErr.EmailVerificationID,
		}
	case workos.MFAChallengeCode, workos.MFAEnrollmentCode,
		workos.OrganizationSelectionRequiredCode, workos.SSORequiredCode,
		workos.OrganizationAuthenticationMethodsRequiredCode:
		return fmt.Errorf("%w: %s", ErrUnsupportedChallenge, code)
	}
	if apiErr.StatusCode == 401 || apiErr.StatusCode == 403 {
		return ErrInvalidCredentials
	}
	return err
}

func (p *WorkOSProvider) AuthenticateWithPassword(ctx context.Context, email, password string) (Identity, error) {
	response, err := p.client.AuthenticatePassword(ctx, email, password)
	if err != nil {
		return Identity{}, translateWorkOSError(err)
	}
	if response == nil || response.User == nil {
		return Identity{}, fmt.Errorf("WorkOS authentication response did not include a user")
	}
	return identityFromWorkOSUser(response.User), nil
}
```

Add `"errors"` to imports. Note `errors.As(&workos.AuthenticationError{...})` unwraps to `*APIError` via its `Unwrap`, so the single `errors.As` handles both wrapped and bare shapes.

**Step 4: Run tests to verify they pass**

Run: `cd packages/ingestion && go test ./auth/ -v`
Expected: all PASS (including pre-existing tests — the fake grew a method, nothing else changed).

**Step 5: Commit**

```bash
git add packages/ingestion/auth/workos.go packages/ingestion/auth/workos_test.go
git commit -m "feat(auth): WorkOS embedded password authentication with typed error translation"
```

---

### Task 4: `RegisterUser`, `VerifyEmail`, password reset on `WorkOSProvider`

Same TDD rhythm as Task 3; these four methods complete the capability set.

**Files:**
- Modify: `packages/ingestion/auth/workos.go`
- Test: `packages/ingestion/auth/workos_test.go`

**Step 1: Write the failing tests**

Extend `fakeWorkOSClient` with the new interface methods and record-args fields:

```go
type fakeWorkOSClient struct {
	response      *workos.AuthenticateResponse
	err           error
	createErr     error
	createdEmail  string // recorded by pointer receiver? use *fakeWorkOSClient in these tests
}
```

Use a pointer-receiver fake for recording (keep the value-receiver methods compiling by converting the existing fake usages to `&fakeWorkOSClient{...}`), and add:

```go
func (f *fakeWorkOSClient) CreateUser(_ context.Context, email, _ string) error {
	f.createdEmail = email
	return f.createErr
}
func (f *fakeWorkOSClient) AuthenticateEmailVerification(context.Context, string, string) (*workos.AuthenticateResponse, error) {
	return f.response, f.err
}
func (f *fakeWorkOSClient) StartPasswordReset(context.Context, string) error { return f.err }
func (f *fakeWorkOSClient) ConfirmPasswordReset(context.Context, string, string) error {
	return f.err
}
```

Tests:

```go
func TestRegisterUserTranslatesEmailTaken(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{
		createErr: &workos.UnprocessableEntityError{APIError: &workos.APIError{StatusCode: 422, Code: "email_not_available"}},
	})
	err := provider.RegisterUser(context.Background(), "a@b.co", "hunter22")
	if !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("want ErrEmailTaken, got %v", err)
	}
}

func TestRegisterUserTranslatesWeakPassword(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{
		createErr: &workos.UnprocessableEntityError{APIError: &workos.APIError{StatusCode: 422, Code: "password_strength_error"}},
	})
	err := provider.RegisterUser(context.Background(), "a@b.co", "123")
	if !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("want ErrWeakPassword, got %v", err)
	}
}

func TestVerifyEmailMapsIdentity(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{response: &workos.AuthenticateResponse{
		User: &workos.User{ID: "user_7", Email: "a@b.co", EmailVerified: true},
	}})
	identity, err := provider.VerifyEmail(context.Background(), "pat_1", "123456")
	if err != nil || identity.ProviderSubject != "user_7" {
		t.Fatalf("identity=%+v err=%v", identity, err)
	}
}

func TestCompletePasswordResetTranslatesBadToken(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{
		err: &workos.APIError{StatusCode: 403, Code: "password_reset_token_expired"},
	})
	err := provider.CompletePasswordReset(context.Background(), "tok", "NewPassw0rd!")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("want ErrInvalidCredentials, got %v", err)
	}
}
```

**Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./auth/ -run "TestRegisterUser|TestVerifyEmail|TestCompletePasswordReset" -v`
Expected: FAIL (compile — interface methods missing).

**Step 3: Implement**

In `workos.go`, extend the interface and SDK client:

```go
type workOSClient interface {
	AuthorizationURL(AuthRequest) (string, error)
	AuthenticateCode(context.Context, string) (*workos.AuthenticateResponse, error)
	AuthenticatePassword(ctx context.Context, email, password string) (*workos.AuthenticateResponse, error)
	CreateUser(ctx context.Context, email, password string) error
	AuthenticateEmailVerification(ctx context.Context, pendingToken, code string) (*workos.AuthenticateResponse, error)
	StartPasswordReset(ctx context.Context, email string) error
	ConfirmPasswordReset(ctx context.Context, token, newPassword string) error
}

func (c workOSSDKClient) CreateUser(ctx context.Context, email, password string) error {
	_, err := c.client.UserManagement().Create(ctx, &workos.UserManagementCreateParams{
		Email:    email,
		Password: workos.UserManagementPasswordPlaintext{Password: password},
	})
	return err
}

func (c workOSSDKClient) AuthenticateEmailVerification(ctx context.Context, pendingToken, code string) (*workos.AuthenticateResponse, error) {
	return c.client.UserManagement().AuthenticateWithEmailVerification(ctx, &workos.UserManagementAuthenticateWithEmailVerificationParams{
		Code:                       code,
		PendingAuthenticationToken: pendingToken,
	})
}

func (c workOSSDKClient) StartPasswordReset(ctx context.Context, email string) error {
	_, err := c.client.UserManagement().ResetPassword(ctx, &workos.UserManagementResetPasswordParams{Email: email})
	return err
}

func (c workOSSDKClient) ConfirmPasswordReset(ctx context.Context, token, newPassword string) error {
	_, err := c.client.UserManagement().ConfirmPasswordReset(ctx, &workos.UserManagementConfirmPasswordResetParams{
		Token:       token,
		NewPassword: newPassword,
	})
	return err
}
```

Provider methods:

```go
func (p *WorkOSProvider) RegisterUser(ctx context.Context, email, password string) error {
	if err := p.client.CreateUser(ctx, email, password); err != nil {
		var apiErr *workos.APIError
		if errors.As(err, &apiErr) {
			// Map by exact code, not blanket 422 — a password-policy failure is
			// also a 422 and must NOT read as "email already registered".
			if apiErr.Code == "email_not_available" {
				return ErrEmailTaken
			}
			if apiErr.Code == "password_strength_error" {
				return ErrWeakPassword
			}
			for _, fieldErr := range apiErr.FieldErrors {
				if fieldErr.Field == "email" {
					return ErrEmailTaken
				}
				if fieldErr.Field == "password" {
					return ErrWeakPassword
				}
			}
		}
		return err
	}
	return nil
}

func (p *WorkOSProvider) VerifyEmail(ctx context.Context, pendingToken, code string) (Identity, error) {
	response, err := p.client.AuthenticateEmailVerification(ctx, pendingToken, code)
	if err != nil {
		return Identity{}, translateWorkOSError(err)
	}
	if response == nil || response.User == nil {
		return Identity{}, fmt.Errorf("WorkOS authentication response did not include a user")
	}
	return identityFromWorkOSUser(response.User), nil
}

func (p *WorkOSProvider) StartPasswordReset(ctx context.Context, email string) error {
	return p.client.StartPasswordReset(ctx, email)
}

func (p *WorkOSProvider) CompletePasswordReset(ctx context.Context, token, newPassword string) error {
	if err := p.client.ConfirmPasswordReset(ctx, token, newPassword); err != nil {
		return translateWorkOSError(err)
	}
	return nil
}
```

Note: `translateWorkOSError` maps 403 to `ErrInvalidCredentials`, which covers expired/invalid reset tokens.

**Step 4: Run full auth package**

Run: `cd packages/ingestion && go test ./auth/ -v`
Expected: PASS. Also add compile-time assertions at the bottom of `workos.go`:

```go
var (
	_ PasswordAuthenticator = (*WorkOSProvider)(nil)
	_ UserRegistrar         = (*WorkOSProvider)(nil)
	_ EmailVerifier         = (*WorkOSProvider)(nil)
	_ PasswordResetter      = (*WorkOSProvider)(nil)
)
```

**Step 5: Commit**

```bash
git add packages/ingestion/auth/workos.go packages/ingestion/auth/workos_test.go
git commit -m "feat(auth): WorkOS sign-up, email verification, and password reset"
```

---

### Task 5: Embedded auth HTTP handlers

**Files:**
- Create: `packages/ingestion/handler/embedded_auth.go`
- Test: `packages/ingestion/handler/embedded_auth_test.go`
- Reference for test setup style: `packages/ingestion/handler/auth_handlers.go`, existing handler tests (e.g. `cors_test.go`, `invitations_test.go`) — mirror how they build `Dependencies` with fakes.

**Step 1: Write the failing tests**

Cover, via `httptest` against a `Dependencies` whose `AuthProvider` is a test double implementing the capability interfaces (define the double in the test file):

1. `GET /auth/config` with WorkOS provider → `{"provider":"workos","supports_password":true,"supports_signup":true,"supports_reset":true}`; with GitHub provider (`AuthProvider: nil`) → all capability flags false.
2. `POST /auth/password` with provider returning `auth.ErrInvalidCredentials` → 401, message "invalid email or password", no cookie.
3. `POST /auth/password` with provider returning `*auth.PendingVerificationError{PendingAuthenticationToken:"pat_1"}` → 403 body `{"status":"email_verification_required","pending_authentication_token":"pat_1"}`.
4. `POST /auth/password` when provider does NOT implement `PasswordAuthenticator` → 404.
5. `POST /auth/signup` when `RegisterUser` returns `auth.ErrEmailTaken` AND the healing `AuthenticateWithPassword` attempt returns `ErrInvalidCredentials` → 409; when the healing attempt returns pending-verification → 403 verification-pending (not 409).
6. `POST /auth/signup` when `RegisterUser` returns `auth.ErrWeakPassword` → 400 with a password-strength message.
7. `POST /auth/verify-email` with `ErrInvalidCredentials` → 401 with a code-specific message ("invalid or expired verification code"), NOT "invalid email or password".
8. `POST /auth/password/forgot` → always 202 even when provider errors (anti-enumeration; error only logged).
9. `POST /auth/password/reset` with `ErrInvalidCredentials` → 401 with a token-specific message; on success → local refresh tokens for that user revoked (stub the queries seam used by the test suite or assert via the revocation call).
10. Malformed JSON on any POST → 400; a body over 64KB → 4xx (MaxBytesReader).
11. Rate limiting: requests over the `loginLimiter` threshold → 429.

Test setup: follow `callback_test.go` — build `Dependencies` directly with a stub provider implementing the capability interfaces; no DB. Cookie-issuing happy paths that require provisioning are covered by `db/provisioning_test.go` plus the Task 9 live smoke (see the design-decisions section). This means tests 2–11 are the unit surface; do not add a provisioner seam.

**Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./handler/ -run TestEmbeddedAuth -v`
Expected: FAIL — handlers undefined.

**Step 3: Implement `embedded_auth.go`**

```go
package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/opslane/opslane/packages/ingestion/auth" // match the module path used by auth_handlers.go imports
)

// completeEmbeddedLogin provisions the identity locally and issues the cookie
// session. Mirrors the tail of OAuthLoginCallback for the JSON (no-redirect) flow.
func (d *Dependencies) completeEmbeddedLogin(w http.ResponseWriter, r *http.Request, identity auth.Identity) {
	userID, _, err := d.Queries.ProvisionFromIdentity(r.Context(), identity)
	if err != nil {
		slog.Error("embedded login provisioning failed", "error", err)
		writeJSONError(w, http.StatusConflict, "could not provision identity")
		return
	}
	user, err := d.Queries.GetUserByID(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONError(w, http.StatusInternalServerError, "could not load provisioned user")
		return
	}
	d.issueTokenPairCookie(w, r, user.ID, user.OrgID, user.Email, user.Name, uuid.NewString())
}

// writeAuthFlowError maps auth-package errors onto the JSON contract shared
// with the dashboard login state machine. invalidMessage is the
// ErrInvalidCredentials text for THIS flow — a bad verification code or reset
// token must not read as "invalid email or password".
func writeAuthFlowError(w http.ResponseWriter, err error, invalidMessage string) {
	var pending *auth.PendingVerificationError
	switch {
	case errors.As(err, &pending):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{
			"status":                       "email_verification_required",
			"pending_authentication_token": pending.PendingAuthenticationToken,
		})
	case errors.Is(err, auth.ErrInvalidCredentials):
		writeJSONError(w, http.StatusUnauthorized, invalidMessage)
	case errors.Is(err, auth.ErrUnsupportedChallenge):
		writeJSONError(w, http.StatusForbidden, "this account requires a sign-in method Opslane does not support yet")
	default:
		slog.Warn("embedded auth provider error", "error", err)
		writeJSONError(w, http.StatusBadGateway, "authentication failed")
	}
}

// decodeAuthBody applies the shared unauthenticated-endpoint guards (64KB body
// cap, matching auth_handlers.go:251) then decodes JSON into dst.
func decodeAuthBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16) // 64KB
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

// AuthConfig tells the dashboard which login UI to render, one flag per
// capability so a partial provider doesn't render dead buttons.
func (d *Dependencies) AuthConfig(w http.ResponseWriter, r *http.Request) {
	provider := d.provider()
	_, supportsPassword := provider.(auth.PasswordAuthenticator)
	_, supportsSignup := provider.(auth.UserRegistrar)
	_, supportsReset := provider.(auth.PasswordResetter)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"provider":          provider.Name(),
		"supports_password": supportsPassword,
		"supports_signup":   supportsSignup,
		"supports_reset":    supportsReset,
	})
}

type passwordLoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// rateLimitAuth applies the shared loginLimiter (auth_handlers.go:124) keyed
// the same way oauthAuthorizePOST keys it. Returns false after writing a 429.
// (Reuse the existing limiter key/extraction logic verbatim — read
// oauthAuthorizePOST before implementing.)
func (d *Dependencies) rateLimitAuth(w http.ResponseWriter, r *http.Request) bool

func (d *Dependencies) PasswordLogin(w http.ResponseWriter, r *http.Request) {
	if !d.rateLimitAuth(w, r) {
		return
	}
	authenticator, ok := d.provider().(auth.PasswordAuthenticator)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "password login is not enabled")
		return
	}
	var req passwordLoginRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if req.Email == "" || req.Password == "" {
		writeJSONError(w, http.StatusBadRequest, "email and password are required")
		return
	}
	identity, err := authenticator.AuthenticateWithPassword(r.Context(), strings.TrimSpace(req.Email), req.Password)
	if err != nil {
		writeAuthFlowError(w, err, "invalid email or password")
		return
	}
	d.completeEmbeddedLogin(w, r, identity)
}

func (d *Dependencies) Signup(w http.ResponseWriter, r *http.Request) {
	if !d.rateLimitAuth(w, r) {
		return
	}
	registrar, okRegistrar := d.provider().(auth.UserRegistrar)
	authenticator, okAuth := d.provider().(auth.PasswordAuthenticator)
	if !okRegistrar || !okAuth {
		writeJSONError(w, http.StatusNotFound, "sign-up is not enabled")
		return
	}
	var req passwordLoginRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if req.Email == "" || req.Password == "" {
		writeJSONError(w, http.StatusBadRequest, "email and password are required")
		return
	}
	email := strings.TrimSpace(req.Email)
	emailTaken := false
	if err := registrar.RegisterUser(r.Context(), email, req.Password); err != nil {
		switch {
		case errors.Is(err, auth.ErrEmailTaken):
			// Signup is two non-atomic calls; a retry after a half-completed
			// signup lands here. Fall through and try authenticating — only
			// report 409 if the credentials don't match the existing account.
			emailTaken = true
		case errors.Is(err, auth.ErrWeakPassword):
			writeJSONError(w, http.StatusBadRequest, "password does not meet strength requirements")
			return
		default:
			slog.Warn("embedded signup failed", "error", err)
			writeJSONError(w, http.StatusBadGateway, "could not create account")
			return
		}
	}
	// With email verification enabled (required for provisioning) this yields
	// the pending-verification response the frontend expects.
	identity, err := authenticator.AuthenticateWithPassword(r.Context(), email, req.Password)
	if err != nil {
		if emailTaken && errors.Is(err, auth.ErrInvalidCredentials) {
			writeJSONError(w, http.StatusConflict, "an account with this email already exists")
			return
		}
		writeAuthFlowError(w, err, "invalid email or password")
		return
	}
	d.completeEmbeddedLogin(w, r, identity)
}

type verifyEmailRequest struct {
	PendingAuthenticationToken string `json:"pending_authentication_token"`
	Code                       string `json:"code"`
}

func (d *Dependencies) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	if !d.rateLimitAuth(w, r) {
		return
	}
	verifier, ok := d.provider().(auth.EmailVerifier)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "email verification is not enabled")
		return
	}
	var req verifyEmailRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if req.Code == "" || req.PendingAuthenticationToken == "" {
		writeJSONError(w, http.StatusBadRequest, "code and pending_authentication_token are required")
		return
	}
	identity, err := verifier.VerifyEmail(r.Context(), req.PendingAuthenticationToken, req.Code)
	if err != nil {
		writeAuthFlowError(w, err, "invalid or expired verification code")
		return
	}
	d.completeEmbeddedLogin(w, r, identity)
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

func (d *Dependencies) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	if !d.rateLimitAuth(w, r) {
		return
	}
	resetter, ok := d.provider().(auth.PasswordResetter)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "password reset is not enabled")
		return
	}
	var req forgotPasswordRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if req.Email == "" {
		writeJSONError(w, http.StatusBadRequest, "email is required")
		return
	}
	if err := resetter.StartPasswordReset(r.Context(), strings.TrimSpace(req.Email)); err != nil {
		// Always report success so responses cannot be used to probe which
		// emails have accounts.
		slog.Warn("password reset start failed", "error", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "sent"})
}

type resetPasswordRequest struct {
	Email       string `json:"email"`
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

func (d *Dependencies) ResetPassword(w http.ResponseWriter, r *http.Request) {
	if !d.rateLimitAuth(w, r) {
		return
	}
	resetter, ok := d.provider().(auth.PasswordResetter)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "password reset is not enabled")
		return
	}
	var req resetPasswordRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if req.Token == "" || req.NewPassword == "" {
		writeJSONError(w, http.StatusBadRequest, "token and new_password are required")
		return
	}
	if err := resetter.CompletePasswordReset(r.Context(), req.Token, req.NewPassword); err != nil {
		writeAuthFlowError(w, err, "invalid or expired reset link")
		return
	}
	// WorkOS changed the password, but Opslane's own refresh tokens (30-day)
	// would keep a stolen session alive. Revoke them all for this user.
	if req.Email != "" && d.Queries != nil {
		if user, err := d.Queries.GetUserByEmail(r.Context(), strings.ToLower(strings.TrimSpace(req.Email))); err == nil && user != nil {
			if _, err := d.Queries.RevokeAllUserRefreshTokens(r.Context(), user.ID); err != nil {
				slog.Warn("failed to revoke sessions after password reset", "error", err)
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "reset"})
}
```

Adjust imports to match the module path and helpers actually present (`uuid`, `writeJSONError` — copy from `auth_handlers.go`/`github_oauth.go`). If handler tests use fakes rather than a test DB, introduce a small `provisioner` interface seam on `Dependencies` mirroring how `Queries` is already injected — follow whatever pattern the existing handler tests use; do not invent a new one.

**Step 4: Run tests**

Run: `cd packages/ingestion && go test ./handler/ -run TestEmbeddedAuth -v` then `go test ./handler/`
Expected: PASS, no regressions.

**Step 5: Commit**

```bash
git add packages/ingestion/handler/embedded_auth.go packages/ingestion/handler/embedded_auth_test.go
git commit -m "feat(ingestion): embedded auth endpoints (password, signup, verify, reset)"
```

---

### Task 6: Register routes

**Files:**
- Modify: `packages/ingestion/handler/routes.go` (near line 46, next to the existing `/auth/*` routes)
- Test: extend `packages/ingestion/handler/embedded_auth_test.go` with one routing smoke test through the real router if a router-level test helper exists; otherwise rely on Task 5 handler tests.

**Step 1: Add routes**

```go
r.Get("/auth/config", deps.AuthConfig)
r.Post("/auth/password", deps.PasswordLogin)
r.Post("/auth/signup", deps.Signup)
r.Post("/auth/verify-email", deps.VerifyEmail)
r.Post("/auth/password/forgot", deps.ForgotPassword)
r.Post("/auth/password/reset", deps.ResetPassword)
```

Note: there is no auth route-group middleware to inherit — CORS is global and rate limiting is done inside handlers (the shared `loginLimiter` at `auth_handlers.go:124`). That's why every new handler calls `d.rateLimitAuth` itself (Task 5); the routes here need no extra wrapping.

**Step 2: Verify**

Run: `cd packages/ingestion && go build ./... && go test ./...`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/ingestion/handler/routes.go
git commit -m "feat(ingestion): route embedded auth endpoints"
```

---

### Task 7: Dashboard API client + types

**Files:**
- Modify: `packages/dashboard/src/api.ts` (all API calls live here per package conventions)
- Modify: `packages/dashboard/src/types/api.ts`
- Test: `packages/dashboard/src/__tests__/` (colocated Vitest, follow existing test file naming)

**Step 1: Types** (`types/api.ts`):

`AuthUser` ALREADY EXISTS in this file (with `memberships`, `active_org_id`, etc.) — reuse it, do not redeclare. Add only:

```ts
export interface AuthConfig {
  provider: string;
  supports_password: boolean;
  supports_signup: boolean;
  supports_reset: boolean;
}

export type PasswordAuthResult =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'email_verification_required'; pending_authentication_token: string }
  | { status: 'error'; code: number; message: string };

export type ResetPasswordResult =
  | { status: 'reset' }
  | { status: 'error'; code: number; message: string };
```

**Step 2: Write failing tests** for the api helpers (mock `fetch`): 200 → `authenticated`, 403 verification body → `email_verification_required`, 401 → `error` with message.

Run: `pnpm --filter @opslane/dashboard test`
Expected: FAIL — functions undefined.

**Step 3: Implement in `api.ts`** (match the file's existing fetch wrapper/style — reuse its base helper if one exists):

```ts
export async function fetchAuthConfig(): Promise<AuthConfig> { /* GET /auth/config */ }

async function postAuthFlow(path: string, body: unknown): Promise<PasswordAuthResult> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (res.ok) {
    return { status: 'authenticated', user: (data as { user: AuthUser }).user };
  }
  const record = data as Record<string, unknown>;
  if (res.status === 403 && record.status === 'email_verification_required') {
    return {
      status: 'email_verification_required',
      pending_authentication_token: String(record.pending_authentication_token ?? ''),
    };
  }
  return { status: 'error', code: res.status, message: String(record.error ?? 'Something went wrong') };
}

export const passwordLogin = (email: string, password: string) =>
  postAuthFlow('/auth/password', { email, password });
export const signup = (email: string, password: string) =>
  postAuthFlow('/auth/signup', { email, password });
export const verifyEmail = (pendingToken: string, code: string) =>
  postAuthFlow('/auth/verify-email', { pending_authentication_token: pendingToken, code });
export const forgotPassword = (email: string) =>
  fetch('/auth/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });

// Own narrow return type — the 200 body is {status:"reset"}, not a user session.
export async function resetPassword(email: string, token: string, newPassword: string): Promise<ResetPasswordResult> {
  const res = await fetch('/auth/password/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token, new_password: newPassword }),
  });
  if (res.ok) return { status: 'reset' };
  const data: unknown = await res.json().catch(() => ({}));
  const record = data as Record<string, unknown>;
  return { status: 'error', code: res.status, message: String(record.error ?? 'Something went wrong') };
}
```

All submit helpers must also catch network-level rejections (`fetch` throwing) and return the `error` variant — the login page must never sit on an unhandled rejection.

**Step 3b: Vite dev proxy.** The proxy in `packages/dashboard/vite.config.ts` enumerates specific `/auth/*` paths — the new endpoints will 404 against Vite in dev without entries. Add proxy entries for `/auth/config`, `/auth/password` (covers `/auth/password/forgot` and `/auth/password/reset` via prefix), `/auth/signup`, and `/auth/verify-email`, same target/changeOrigin shape as the existing `/auth/login` entry. Do NOT add a blanket `/auth` — `/auth/complete` is an SPA route and must stay unproxied.

**Step 4: Run tests** — `pnpm --filter @opslane/dashboard test` → PASS.

**Step 5: Commit**

```bash
git add packages/dashboard/src/api.ts packages/dashboard/src/types/api.ts packages/dashboard/vite.config.ts packages/dashboard/src/__tests__/
git commit -m "feat(dashboard): embedded auth API client"
```

---

### Task 8: Login state machine UI

**Files:**
- Rewrite: `packages/dashboard/src/views/Login.vue`
- Create: `packages/dashboard/src/views/ResetPassword.vue`
- Modify: `packages/dashboard/src/router.ts` (add `{ path: '/reset-password', component: ResetPassword, meta: { public: true } }`)
- Test: colocated `__tests__` for the state transitions (mount with mocked api module)

**State machine lives in a composable, not the component.** Create `packages/dashboard/src/composables/useLoginFlow.ts` holding all states and transitions as plain reactive logic; `Login.vue` only renders it. This is not optional style — the dashboard's Vitest runs in a Node environment with no `@vue/test-utils` and no jsdom, and `api.ts` touches `localStorage` at module load, so mounting components is not testable today. A pure composable (api functions injected as parameters) tests fine in Node.

**States:** `loading` (fetching `/auth/config`; on fetch failure → `config-error` with a retry button, never stuck on a spinner) → either `redirect` mode (current button markup unchanged — when `supports_password` is false) or the form flow: `signin` ⇄ `signup` (signup tab only when `supports_signup`) → `verify-code` (entered when any call returns `email_verification_required`; keeps `pending_authentication_token` in component state) → success. Also a `forgot` sub-state (only when `supports_reset`) that calls `forgotPassword` and shows "check your email".

**Success path — must match the redirect flow's completion, not `router.push('/')`.** The router guard checks the `opslane_authed` marker and `AuthCallback.vue` runs post-login setup (marker via `markAuthed()`, stored return path, project/setup bootstrap). Read `AuthCallback.vue`, extract its post-auth logic into a shared helper, and call that same helper on embedded-login success. Otherwise the guard treats a logged-in user as logged out.

**Verify-code recovery:** the pending token lives only in component memory. If the user refreshes and loses it, the recovery path is simply signing in again — an unverified-email login returns a fresh pending token and WorkOS emails a new code. Show "Lost the code? Sign in again to get a new one." No resend endpoint needed.

Keep the existing Tailwind card look from the current `Login.vue` (bg-surface, border-border, teal accent). One card, swapping inner content per state. Inline field errors from the `error` result variant; never render raw HTML from responses.

**ResetPassword.vue:** reads `token` and `email` from the query string (WorkOS appends both to the reset URL), one form (new password + confirm), calls `resetPassword(email, token, newPassword)`, on success shows "password updated" with a link to `/login`. Handles the `error` variant inline (expired link → suggest requesting a new one).

**TDD:** write composable tests first in plain Vitest (Node env, api functions mocked via injection): config failure → `config-error`; `supports_password:false` → `redirect` mode; login error → message set; `email_verification_required` → `verify-code` with token retained; verify success → completion callback invoked. Watch them fail, implement, re-run.

Run: `pnpm --filter @opslane/dashboard test` and `pnpm --filter @opslane/dashboard build`
Expected: PASS.

**Commit:**

```bash
git add packages/dashboard/src/views/Login.vue packages/dashboard/src/views/ResetPassword.vue packages/dashboard/src/composables/useLoginFlow.ts packages/dashboard/src/router.ts packages/dashboard/src/__tests__/
git commit -m "feat(dashboard): native login, sign-up, verification, and reset UI"
```

---

### Task 9: Full gate + live smoke

**Step 1: Full repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

All must pass.

**Step 2: Live smoke against WorkOS staging** (WorkOS staging env is free; use its API key/client ID)

1. Ensure the WorkOS staging environment has Password + Email verification enabled and reset URL `http://localhost:<dashboard-port>/reset-password`.
2. Start the stack (compose with `WORKOS_API_KEY`/`WORKOS_CLIENT_ID` staging values).
3. Sign-up flow: create a fresh account with a real inbox you control → expect 403 verification-pending → enter emailed code → expect logged-in dashboard with cookies set.
4. Sign-in flow: log out, sign back in with the password → straight to dashboard, no WorkOS-owned page ever shown.
5. Wrong password → inline "invalid email or password", stays on page.
6. Forgot flow: request reset → follow emailed link to `/reset-password?token=…` → set new password → sign in with it.
7. Regression: run the CLI login (PKCE path) once to confirm the legacy hosted redirect still completes.

The embedded form is Opslane's own page, so headless browser automation works for steps 3–6 (the old hosted-AuthKit headless block no longer applies); email-code retrieval is the only manual step unless a test inbox API is available.

**Step 3: Commit any smoke-revealed fixes, then hand off for PR.** Note: pushing is blocked by a repo hook — ask the user to run `! git push`, then create the PR with `gh pr create` from the repo root.

---

## Explicitly out of scope (follow-ups, do not build now)

- **MFA/TOTP** — mapped to a clear "unsupported" error; add `AuthenticateWithTOTP` later if customers need it.
- **Magic-link/code sign-in** — SDK supports it (`CreateMagicAuth`/`AuthenticateWithMagicAuth`); easy add once the form exists.
- **Social login buttons (Google) via embedded flow** — the existing `/auth/login` redirect already covers social through AuthKit; a direct `provider: "GoogleOAuth"` authorize URL can replace it later.
- **CLI PKCE via embedded form** — CLI keeps the hosted redirect.
- **Branded reset/verification emails** — those still send from WorkOS's domain; fixing that is the $99/mo custom-domain add-on, a business decision.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found → fixed | 16 findings (9 P1, 7 P2), 16/16 applied to plan |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** All 9 P1s applied: Vite proxy entries for new `/auth/*` endpoints; `loginLimiter` + 64KB `MaxBytesReader` on every new handler; local session revocation after password reset (`RevokeAllUserRefreshTokens`); login success routed through the shared `AuthCallback` completion helper (`markAuthed` + return path); dedicated `ResetPasswordResult` type; reuse of the existing `AuthUser` type; testable composable-based frontend strategy (no jsdom/test-utils dependency); exact-code error translation (`email_not_available` / `password_strength_error`) with context-specific messages. All 7 P2s applied: verification required (provisioning's verified-email gate), per-capability config flags, flow-specific invalid-credential messages, network-failure states, signup retry healing, verify-code refresh recovery, and a decided handler test strategy (stub providers, no provisioner seam).

**VERDICT:** CODEX CLEARED after fixes — eng review not yet run.

NO UNRESOLVED DECISIONS
