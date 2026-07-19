# Agent Onboarding PR 1 — Server Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden the agent-first onboarding flow in the Go ingestion server per the v4 design (`docs/plans/2026-07-18-agent-first-onboarding-design.md`, PR 1): mandatory verified identity, user↔installation binding, repo-access proof, one-transaction provisioning with repo-identity locking, split poll token with sealed-box key delivery, failure states, no tenant leakage, `Retry-After`, and the shared callback dispatcher.

**Architecture:** All changes live in `packages/ingestion`. The GitHub App callback (with OAuth-during-install enabled at deploy time) delivers `code + installation_id + setup_action + state` to one URL; a dispatcher routes agent sessions (UUID state) to a hardened completion path and everything else to the existing login/web-install path. Provisioning is a single Postgres transaction guarded by a session row lock plus an advisory lock on canonical repo identity. The API key is never stored recoverably: it is sealed to an X25519 public key derived from the poll token at setup time, and only a poll presenting the raw token can open it.

**Tech Stack:** Go 1.24, chi, pgx/v5, Postgres, std-lib crypto (`crypto/ecdh`, AES-GCM). No new dependencies.

**Context you need:**
- Design doc (read first): `docs/plans/2026-07-18-agent-first-onboarding-design.md` — especially decisions 14–16 and the PR 1 section.
- Current flow: `packages/ingestion/handler/agent_setup.go` (all of it), `packages/ingestion/db/queries.go:2656-2804` (agent session queries), `packages/ingestion/handler/github_oauth.go:73-260` (login callback + `applyCombinedGitHubInstallation`), `packages/ingestion/handler/routes.go:57-61`.
- Conventions: `packages/ingestion/AGENTS.md` (append-only idempotent migrations from `002`; handlers in `handler/`, DB in `db/`; every DB helper tenant-scoped).
- DB tests connect to `postgres://opslane:opslane_dev@localhost:5434/opslane` by default (`db/testhelper_test.go`) and skip if unreachable. Start it with `docker compose up -d postgres` from the repo root. The migration test creates its own disposable database — it never mutates the dev DB.
- Failure vocabulary (poll surfaces these): `identity_unverified`, `installation_not_yours`, `repo_not_granted`, `org_exists_needs_invite`, `repo_already_configured`.
- Threat rule for the callback: **transient** problems (missing/expired `code`, GitHub API hiccup) show the human an error page and leave the session `pending` so they can retry the link — anyone who sees the auth URL knows the session ID, so cheap requests must not be able to kill a session. **Definitive** business outcomes (proven with a valid user token + installation) mark the session `failed`.

---

## Task 0: Preflight

**Step 1:** Confirm branch and clean tree: `git status` on `abhishekray07/CLI-onboarding` — only untracked `docs/plans/*.md` expected.

**Step 2:** Start Postgres and apply existing migrations:

```bash
docker compose up -d postgres
cd packages/ingestion && ./scripts/../../../scripts/run-migrations.sh 2>/dev/null || (cd ../.. && ./scripts/run-migrations.sh)
```

(Read `scripts/run-migrations.sh` for its env expectations; it applies `db/migrations/*.sql` per-statement.)

**Step 3:** Baseline: `cd packages/ingestion && go build ./... && go test ./...` — must pass before you change anything. If DB-dependent tests skip because Postgres is down, fix that first; this plan's tests need the DB.

---

## Task 1: Migration 016

**Files:**
- Create: `packages/ingestion/db/migrations/016_agent_sessions_v2.sql`

**Step 1: Write the migration — EXPAND ONLY (deploy-safe)**

Old binaries still SELECT/UPDATE `api_key_plaintext`, so this migration must not
drop or null it (expand/deploy/drain/contract — R4-1). The new binary simply
stops writing plaintext; old sessions drain within their 15-minute TTL. A
follow-up migration `017_drop_agent_plaintext.sql` (`UPDATE ... SET
api_key_plaintext = NULL; ALTER TABLE agent_sessions DROP COLUMN IF EXISTS
api_key_plaintext;`) ships in a LATER PR, merged only after this PR is deployed
everywhere and old sessions are gone. Do not write 017 now.

There is deliberately NO pending-uniqueness index: an unauthenticated endpoint
holding "one pending session per repo" lets anyone squat a public repo's slot
and block its real owner (R4-6). Multiple pending sessions are fine — the
advisory lock inside `ProvisionAgentSession` is the only serializer, and losers
fail with `repo_already_configured`.

```sql
-- 016_agent_sessions_v2.sql
-- Agent-first onboarding hardening (docs/plans/2026-07-18-agent-first-onboarding-design.md, PR 1).
-- EXPAND-ONLY: old binaries keep working; api_key_plaintext is retired by the
-- new binary (which never writes it) and dropped in a later contract migration.
--
-- poll_token_hash / agent_key_pub: the key-retrieval secret is split from the
-- session ID (which travels through browser-visible URLs). The poll token is
-- returned once at setup; only its SHA-256 hash is stored. The token also
-- seeds an X25519 keypair whose PUBLIC key is stored here so the callback can
-- seal the API key to it (decision 15) — the server at rest cannot decrypt.
-- failure_reason: machine-readable failure states (decision/F17).
-- auth_clicked_at / key_claimed_at: onboarding funnel timestamps (PR 5 reads).

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS poll_token_hash TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS agent_key_pub   TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS api_key_sealed  TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS failure_reason  TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS auth_clicked_at TIMESTAMPTZ;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS key_claimed_at  TIMESTAMPTZ;

-- 'failed' is a new terminal status; old binaries never write it, so widening
-- the CHECK is expand-safe.
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_status_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_status_check
  CHECK (status IN ('pending', 'completed', 'expired', 'failed'));
```

**Step 2: Run the migration harness (applies to a disposable DB, fresh + re-apply for idempotency)**

Run: `cd packages/ingestion && go test ./db -run TestMigrations -v`
Expected: PASS (the harness globs `migrations/*.sql`, so 016 is picked up automatically). If psql is missing it skips — install `libpq` or run where psql exists; do not merge on a skip.

**Step 3: Apply to the dev DB** (needed for later integration tests)

Run: `./scripts/run-migrations.sh` from the repo root (or apply 016 via psql to the 5434 dev DB).
Expected: `agent_sessions` has the six new columns AND still has `api_key_plaintext` (expand phase — dropped by 017 in a later PR); verify with `psql ... -c '\d agent_sessions'`.

**Step 4: Commit**

```bash
git add packages/ingestion/db/migrations/016_agent_sessions_v2.sql
git commit -m "feat(ingestion): agent_sessions v2 schema — poll token split, sealed key, failure states"
```

---

## Task 2: Sealed-box crypto helpers

**Files:**
- Create: `packages/ingestion/auth/agentkey.go`
- Create: `packages/ingestion/auth/agentkey_test.go`

**Step 1: Write the failing tests**

```go
package auth

import (
	"strings"
	"testing"
)

func TestAgentKeyRoundTrip(t *testing.T) {
	raw, hash, pub, err := NewAgentPollToken()
	if err != nil {
		t.Fatalf("NewAgentPollToken: %v", err)
	}
	if !strings.HasPrefix(raw, "opt_") || len(raw) != 4+64 {
		t.Errorf("token format: %q", raw)
	}
	if hash != HashToken(raw) {
		t.Errorf("hash mismatch")
	}

	sealed, err := SealAgentKey(pub, "session-123", "def_secret-key")
	if err != nil {
		t.Fatalf("SealAgentKey: %v", err)
	}
	opened, err := OpenAgentKey(raw, "session-123", sealed)
	if err != nil {
		t.Fatalf("OpenAgentKey: %v", err)
	}
	if opened != "def_secret-key" {
		t.Errorf("opened = %q", opened)
	}
}

func TestAgentKeyWrongTokenFails(t *testing.T) {
	_, _, pub, _ := NewAgentPollToken()
	other, _, _, _ := NewAgentPollToken()
	sealed, _ := SealAgentKey(pub, "s", "def_k")
	if _, err := OpenAgentKey(other, "s", sealed); err == nil {
		t.Error("expected open with wrong token to fail")
	}
}

func TestAgentKeyWrongSessionFails(t *testing.T) {
	raw, _, pub, _ := NewAgentPollToken()
	sealed, _ := SealAgentKey(pub, "session-A", "def_k")
	if _, err := OpenAgentKey(raw, "session-B", sealed); err == nil {
		t.Error("expected open with wrong session AAD to fail")
	}
}
```

**Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./auth -run TestAgentKey -v`
Expected: FAIL — `undefined: NewAgentPollToken` etc.

**Step 3: Implement**

```go
package auth

// Agent-session key delivery (design decision 15, v4.1 sealed-box form).
//
// The poll token is the only secret the CLI holds. The server stores the
// token's SHA-256 hash (authentication) and an X25519 PUBLIC key derived
// from the token (encryption). The GitHub callback seals the freshly minted
// API key to that public key; only a poll presenting the raw token can
// re-derive the private key and open the box. A database snapshot (hash +
// public key + ciphertext) is not decryptable.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

const agentKeySeedContext = "opslane-agent-key-v1:"

// NewAgentPollToken returns (raw token, sha256 hash, base64 X25519 public key).
// The raw token is shown to the CLI exactly once; only hash + pub are stored.
func NewAgentPollToken() (raw, hash, pubB64 string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", "", err
	}
	raw = "opt_" + hex.EncodeToString(buf)
	priv, err := agentKeyPrivate(raw)
	if err != nil {
		return "", "", "", err
	}
	return raw, HashToken(raw), base64.StdEncoding.EncodeToString(priv.PublicKey().Bytes()), nil
}

func agentKeyPrivate(pollToken string) (*ecdh.PrivateKey, error) {
	seed := sha256.Sum256([]byte(agentKeySeedContext + pollToken))
	return ecdh.X25519().NewPrivateKey(seed[:])
}

// SealAgentKey encrypts apiKey to the stored public key. Output layout:
// base64(ephemeralPub[32] || nonce[12] || AES-256-GCM ciphertext), with the
// session ID bound as AAD so a ciphertext cannot be replayed across sessions.
func SealAgentKey(pubB64, sessionID, apiKey string) (string, error) {
	pubBytes, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil {
		return "", fmt.Errorf("decode agent key pub: %w", err)
	}
	recipient, err := ecdh.X25519().NewPublicKey(pubBytes)
	if err != nil {
		return "", fmt.Errorf("parse agent key pub: %w", err)
	}
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	gcm, err := agentKeyAEAD(eph, recipient, eph.PublicKey().Bytes(), pubBytes)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(apiKey), []byte(sessionID))
	out := append(append(eph.PublicKey().Bytes(), nonce...), sealed...)
	return base64.StdEncoding.EncodeToString(out), nil
}

// OpenAgentKey re-derives the private key from the presented poll token and
// opens the sealed box. Fails for a wrong token, wrong session, or tampering.
func OpenAgentKey(pollToken, sessionID, sealedB64 string) (string, error) {
	blob, err := base64.StdEncoding.DecodeString(sealedB64)
	if err != nil {
		return "", fmt.Errorf("decode sealed key: %w", err)
	}
	if len(blob) < 32+12+16 {
		return "", fmt.Errorf("sealed key too short")
	}
	ephPub, err := ecdh.X25519().NewPublicKey(blob[:32])
	if err != nil {
		return "", fmt.Errorf("parse ephemeral pub: %w", err)
	}
	priv, err := agentKeyPrivate(pollToken)
	if err != nil {
		return "", err
	}
	gcm, err := agentKeyAEAD(priv, ephPub, blob[:32], priv.PublicKey().Bytes())
	if err != nil {
		return "", err
	}
	nonce, ct := blob[32:32+gcm.NonceSize()], blob[32+gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ct, []byte(sessionID))
	if err != nil {
		return "", fmt.Errorf("open sealed key: %w", err)
	}
	return string(plain), nil
}

// agentKeyAEAD derives the AES-256-GCM AEAD from the X25519 shared secret,
// binding both public keys into the KDF input.
func agentKeyAEAD(priv *ecdh.PrivateKey, peer *ecdh.PublicKey, ephPub, recipientPub []byte) (cipher.AEAD, error) {
	shared, err := priv.ECDH(peer)
	if err != nil {
		return nil, fmt.Errorf("ecdh: %w", err)
	}
	kdfInput := append(append(append([]byte(agentKeySeedContext), shared...), ephPub...), recipientPub...)
	key := sha256.Sum256(kdfInput)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
```

**Step 4: Run tests**

Run: `go test ./auth -run TestAgentKey -v`
Expected: PASS (all three).

**Step 5: Commit**

```bash
git add packages/ingestion/auth/agentkey.go packages/ingestion/auth/agentkey_test.go
git commit -m "feat(ingestion): sealed-box crypto for agent key delivery (decision 15)"
```

---

## Task 3: `github.ListUserInstallations` + test HTTP hook

**Files:**
- Modify: `packages/ingestion/github/app.go`
- Modify: `packages/ingestion/github/app_test.go`

**Step 1: Write the failing test** (append to `app_test.go`; copy the transport-redirect pattern from `TestExchangeOAuthCode` at `app_test.go:72`)

```go
func TestListUserInstallations(t *testing.T) {
	callCount := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if r.URL.Path != "/user/installations" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer ghu_tok" {
			t.Errorf("auth header = %s", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("page") == "2" {
			fmt.Fprint(w, `{"installations":[{"id":222}]}`)
			return
		}
		w.Header().Set("Link", `<https://api.github.com/user/installations?page=2>; rel="next"`)
		fmt.Fprint(w, `{"installations":[{"id":111}]}`)
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "http"
		req.URL.Host = ts.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(req)
	})}
	defer func() { httpClient = origClient }()

	ids, err := ListUserInstallations("ghu_tok")
	if err != nil {
		t.Fatalf("ListUserInstallations: %v", err)
	}
	if len(ids) != 2 || ids[0] != 111 || ids[1] != 222 {
		t.Errorf("ids = %v, want [111 222]", ids)
	}
	if callCount != 2 {
		t.Errorf("expected pagination (2 calls), got %d", callCount)
	}
}
```

**Step 2: Run to verify failure**

Run: `go test ./github -run TestListUserInstallations -v`
Expected: FAIL — `undefined: ListUserInstallations`.

**Step 3: Implement** (in `app.go`, near `ListInstallationRepos`; reuse `hasNextPage`)

```go
// ListUserInstallations returns the installation IDs visible to a user access
// token (GET /user/installations, paginated). This is the binding check from
// design decision 14: query-string installation_ids are attacker-controlled,
// and App-JWT verification only proves the installation belongs to this App —
// presence in the AUTHENTICATED USER's installation list is what proves the
// user controls it.
func ListUserInstallations(userToken string) ([]int64, error) {
	var ids []int64
	for page := 1; ; page++ {
		reqURL := fmt.Sprintf("%s/user/installations?per_page=100&page=%d", githubAPIBase, page)
		req, err := http.NewRequest("GET", reqURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+userToken)
		req.Header.Set("Accept", "application/vnd.github+json")
		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("list user installations: %w", err)
		}
		var body struct {
			Installations []struct {
				ID int64 `json:"id"`
			} `json:"installations"`
		}
		decodeErr := json.NewDecoder(resp.Body).Decode(&body)
		link := resp.Header.Get("Link")
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("list user installations: status %d", resp.StatusCode)
		}
		if decodeErr != nil {
			return nil, fmt.Errorf("list user installations decode: %w", decodeErr)
		}
		for _, inst := range body.Installations {
			ids = append(ids, inst.ID)
		}
		if !hasNextPage(link) {
			break
		}
	}
	return ids, nil
}
```

Also add an exported test hook so **handler**-package tests can stub GitHub (used in Task 9):

```go
// OverrideHTTPClientForTests swaps the package HTTP client and returns a
// restore func. Test-only; never call from production code.
func OverrideHTTPClientForTests(c *http.Client) (restore func()) {
	orig := httpClient
	httpClient = c
	return func() { httpClient = orig }
}
```

**Step 4: Run tests**

Run: `go test ./github -v`
Expected: PASS (all, including the new one).

**Step 5: Commit**

```bash
git add packages/ingestion/github/app.go packages/ingestion/github/app_test.go
git commit -m "feat(ingestion): ListUserInstallations for user-installation binding (decision 14)"
```

---

## Task 4: Session creation v2 — db + `AgentSetup` handler

**Files:**
- Modify: `packages/ingestion/db/queries.go` (agent session block, ~line 2656)
- Modify: `packages/ingestion/handler/agent_setup.go` (`AgentSetup`, ~line 28-101)
- Modify: `packages/ingestion/handler/agent_setup_test.go`
- Create: `packages/ingestion/db/agent_session_v2_test.go`

**Step 1: db changes**

In `queries.go`, update the `AgentSession` struct (add after `InstallationID`):

```go
	PollTokenHash *string
	AgentKeyPub   *string
	APIKeySealed  *string
	FailureReason *string
	AuthClickedAt *time.Time
	KeyClaimedAt  *time.Time
```

Replace `CreateAgentSession` with a params form (no uniqueness handling — multiple pending sessions per repo are allowed by design, R4-6; the provisioning advisory lock is the serializer):

```go
type CreateAgentSessionParams struct {
	RepoURL       string
	AgentName     *string
	PollTokenHash string
	AgentKeyPub   string
}

// CreateAgentSession creates a pending agent session. Returns
// ErrAgentSessionPendingExists if the repo already has a pending session.
func (q *Queries) CreateAgentSession(ctx context.Context, p CreateAgentSessionParams) (*AgentSession, error) {
	var s AgentSession
	err := q.pool.QueryRow(ctx,
		`INSERT INTO agent_sessions (repo_url, agent_name, poll_token_hash, agent_key_pub)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, repo_url, agent_name, status, org_id, project_id,
		           installation_id, created_at, completed_at, expires_at,
		           poll_token_hash, agent_key_pub, api_key_sealed, failure_reason,
		           auth_clicked_at, key_claimed_at`,
		p.RepoURL, p.AgentName, p.PollTokenHash, p.AgentKeyPub,
	).Scan(&s.ID, &s.RepoURL, &s.AgentName, &s.Status, &s.OrgID, &s.ProjectID,
		&s.InstallationID, &s.CreatedAt, &s.CompletedAt, &s.ExpiresAt,
		&s.PollTokenHash, &s.AgentKeyPub, &s.APIKeySealed, &s.FailureReason,
		&s.AuthClickedAt, &s.KeyClaimedAt)
	if err != nil {
		return nil, fmt.Errorf("create agent session: %w", err)
	}
	return &s, nil
}
```

Also add the machine-body helper to `handler/agent_setup.go` — the agent CLI
contract needs stable `{"status": ...}` bodies, and `writeJSONError` emits
`{"error": ...}` (R4-7). All agent-endpoint non-validation responses go
through this:

```go
// agentJSON writes a machine-stable agent-contract body. Agent endpoints
// always carry a "status" field; never use writeJSONError's {"error"} shape
// for states the CLI must dispatch on.
func agentJSON(w http.ResponseWriter, code int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}
```

Update `GetAgentSession` to SELECT/scan the same column list (drop `api_key_plaintext`, add the six new fields — same order as above).

**Step 2: `AgentSetup` handler rework** (replace the body of `AgentSetup` from the rate-limit check down; add imports `"errors"` and the `auth` package):

```go
	ip := clientIP(r)
	if !agentSetupLimiter.allow(ip) {
		slog.Warn("agent setup rate limit exceeded", "ip", ip)
		w.Header().Set("Retry-After", "60")
		agentJSON(w, http.StatusTooManyRequests, map[string]any{
			"status": "rate_limited", "retry_after": 60,
			"message": "too many requests, try again later",
		})
		return
	}

	// ... body decode + repo validation unchanged ...

	// Returning user — repo already has a project. Deliberately no project or
	// org IDs: this endpoint is unauthenticated and must not leak tenant data (F4).
	existingProject, err := d.Queries.FindProjectByRepoURL(r.Context(), req.RepoURL)
	if err != nil { /* unchanged 500 */ }
	if existingProject != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"status":  "already_configured",
			"repo":    req.RepoURL,
			"message": "This repo already has an Opslane project. Run 'opslane login' then 'opslane setup --relink' to get a fresh key.",
		})
		return
	}

	pollToken, tokenHash, agentKeyPub, err := auth.NewAgentPollToken()
	if err != nil {
		slog.Error("agent setup: generate poll token", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	var agentName *string
	if req.AgentName != "" {
		agentName = &req.AgentName
	}
	session, err := d.Queries.CreateAgentSession(r.Context(), db.CreateAgentSessionParams{
		RepoURL: req.RepoURL, AgentName: agentName,
		PollTokenHash: tokenHash, AgentKeyPub: agentKeyPub,
	})
	if err != nil { /* unchanged 500 */ }
	// Note: multiple pending sessions per repo are allowed (R4-6) — an
	// unauthenticated uniqueness rule would let anyone squat a public repo's
	// slot. ProvisionAgentSession's advisory lock picks the single winner.

	// auth_url from the canonical public origin when configured (F25);
	// request-derived host only as bare self-host fallback.
	origin := d.AuthCallbackOrigin
	if origin == "" {
		origin = backendOrigin(r)
	}
	authURL := fmt.Sprintf("%s/agent/auth/%s", origin, session.ID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"status":     "auth_required",
		"auth_url":   authURL,
		"poll_id":    session.ID,
		"poll_token": pollToken,
		"message":    fmt.Sprintf("Authorize Opslane: %s", authURL),
	})
```

**Step 3: Write the failing integration test** (`db/agent_session_v2_test.go`, package `db_test` — follow `agent_session_test.go` patterns):

```go
func TestCreateAgentSession_V2FieldsRoundTrip(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	params := db.CreateAgentSessionParams{
		RepoURL: "v2-owner/v2-repo", PollTokenHash: "hash-1", AgentKeyPub: "pub-1",
	}
	s, err := q.CreateAgentSession(ctx, params)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM agent_sessions WHERE repo_url = $1`, params.RepoURL) })

	got, err := q.GetAgentSession(ctx, s.ID)
	if err != nil || got == nil {
		t.Fatalf("get: %v", err)
	}
	if got.PollTokenHash == nil || *got.PollTokenHash != "hash-1" ||
		got.AgentKeyPub == nil || *got.AgentKeyPub != "pub-1" {
		t.Errorf("v2 fields not persisted: %+v", got)
	}
	// Multiple pending sessions per repo are allowed (R4-6): no uniqueness.
	if _, err := q.CreateAgentSession(ctx, params); err != nil {
		t.Fatalf("second pending create should be allowed: %v", err)
	}
}
```

**Step 4: Run**

Run: `go build ./... && go test ./db -run TestCreateAgentSession -v && go test ./handler -run TestAgentSetup -v`
Expected: build green; new db test PASS; existing handler validation tests still PASS (they exercise pre-DB paths). Fix any compile fallout from the `CreateAgentSession` signature (the only other caller is `AgentSetup`, updated above; `db/agent_session_test.go` will fail to compile — update its `CreateAgentSession` calls to the params form now, and expect its `CompleteAgentSession`/claim tests to still pass since those queries are untouched so far).

**Step 5: Add a handler unit test for the 429 contract** (in `agent_setup_test.go`): construct `deps := &Dependencies{}` and call `AgentSetup` in a loop >5 times from the same IP; assert the 429 response carries `Retry-After: 60` AND the exact body `{"status":"rate_limited",...}` (decode JSON and check the `status` field — not just the code; R4-7).

**Step 6: Commit**

```bash
git add packages/ingestion/db packages/ingestion/handler
git commit -m "feat(ingestion): agent setup v2 — poll token split, no tenant leakage, machine-contract bodies"
```

---

## Task 5: Poll delivery v2 — db + `AgentPoll` handler

**Files:**
- Modify: `packages/ingestion/db/queries.go`
- Modify: `packages/ingestion/handler/agent_setup.go` (`AgentPoll`)
- Modify: `packages/ingestion/db/agent_session_v2_test.go`, `packages/ingestion/handler/agent_setup_test.go`

**Step 1: db — add delivery + purge queries**

```go
// MarkAgentKeyDelivered stamps first key delivery (funnel: key_claimed).
// COALESCE keeps it exactly-once; deliveries are otherwise idempotent.
func (q *Queries) MarkAgentKeyDelivered(ctx context.Context, sessionID string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET key_claimed_at = COALESCE(key_claimed_at, now())
		 WHERE id = $1 AND status = 'completed'`, sessionID)
	if err != nil {
		return fmt.Errorf("mark agent key delivered: %w", err)
	}
	return nil
}
```

Extend `ExpireAgentSessions` with a second Exec in the same function (keep the first unchanged):

```go
	// Purge sealed keys from completed sessions past their delivery window.
	// The ciphertext is not decryptable server-side, but there is no reason
	// to retain it after the session expires.
	if _, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET api_key_sealed = NULL
		 WHERE status = 'completed' AND expires_at <= now() AND api_key_sealed IS NOT NULL`,
	); err != nil {
		return 0, fmt.Errorf("purge sealed agent keys: %w", err)
	}
```

**Step 2: `AgentPoll` rework** — replace the handler body after UUID validation (imports: `crypto/hmac`, `auth`):

```go
	if !agentPollLimiter.allow(ip) {
		w.Header().Set("Retry-After", "60")
		agentJSON(w, http.StatusTooManyRequests, map[string]any{
			"status": "rate_limited", "retry_after": 60,
			"message": "too many requests, try again later",
		})
		return
	}
	// ... sessionID extraction + uuid validation unchanged ...

	// The poll token is the key-delivery secret (decision 10/15). A missing or
	// wrong token gets the same 404 body as an unknown session — no existence
	// oracle, and a machine-stable body (R4-7).
	pollToken := r.Header.Get("X-Opslane-Poll-Token")
	if pollToken == "" {
		agentJSON(w, http.StatusNotFound, map[string]any{"status": "not_found"})
		return
	}

	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil { /* 500 unchanged */ }
	if session == nil || session.PollTokenHash == nil ||
		!hmac.Equal([]byte(auth.HashToken(pollToken)), []byte(*session.PollTokenHash)) {
		agentJSON(w, http.StatusNotFound, map[string]any{"status": "not_found"})
		return
	}

	switch session.Status {
	case "completed":
		resp := map[string]any{"status": "completed", "repo": session.RepoURL}
		if session.OrgID != nil {
			resp["org_id"] = *session.OrgID
		}
		if session.ProjectID != nil {
			resp["project_id"] = *session.ProjectID
		}
		// The 15-minute delivery window is enforced HERE, not just by the
		// hourly purge sweep — otherwise a key stays retrievable for up to
		// ~75 minutes (R4-2). The sweep is only belt-and-suspenders.
		if session.APIKeySealed == nil || time.Now().After(session.ExpiresAt) {
			resp["message"] = "key delivery window closed; re-run setup to mint a new key"
		} else {
			apiKey, openErr := auth.OpenAgentKey(pollToken, session.ID, *session.APIKeySealed)
			if openErr != nil {
				slog.Error("agent poll: open sealed key", "error", openErr, "session_id", session.ID)
				writeJSONError(w, http.StatusInternalServerError, "internal error")
				return
			}
			resp["api_key"] = apiKey
			if err := d.Queries.MarkAgentKeyDelivered(r.Context(), session.ID); err != nil {
				slog.Warn("agent poll: mark delivered", "error", err)
			}
		}
		agentJSON(w, http.StatusOK, resp)

	case "failed":
		reason := ""
		if session.FailureReason != nil {
			reason = *session.FailureReason
		}
		agentJSON(w, http.StatusOK, map[string]any{
			"status":         "failed",
			"failure_reason": reason,
			"message":        agentFailureMessage(reason),
		})

	case "expired":
		agentJSON(w, http.StatusGone, map[string]any{
			"status": "expired", "message": "session expired; re-run setup",
		})

	default: // pending
		agentJSON(w, http.StatusOK, map[string]any{"status": "pending"})
	}
```

Add the shared remediation text helper (used again by the callback pages in Task 9):

```go
// agentFailureMessage maps machine failure reasons to human/agent remediation.
func agentFailureMessage(reason string) string {
	switch reason {
	case "identity_unverified":
		return "Your GitHub account has no verified email. Verify an email on GitHub, then re-run setup."
	case "installation_not_yours":
		return "The GitHub App installation could not be verified as yours. Re-run setup and complete the authorization yourself."
	case "repo_not_granted":
		return "The GitHub App installation does not include this repository. Add the repo to the installation on GitHub, then re-run setup."
	case "org_exists_needs_invite":
		return "This GitHub org already has an Opslane organization. Ask an Opslane admin of that org to invite you, then use the dashboard for a key."
	case "repo_already_configured":
		return "This repo already has an Opslane project. Run 'opslane login' then 'opslane setup --relink'."
	default:
		return "Setup failed. Re-run setup to try again."
	}
}
```

**Step 3: Tests**

Handler unit (no DB), in `agent_setup_test.go` — assert the exact machine body, not just the code (R4-7):

```go
func TestAgentPoll_MissingTokenIs404NotFoundBody(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("GET", "/api/v1/agent/poll/00000000-0000-0000-0000-000000000001", nil)
	req = req.WithContext(newChiRouteContext(map[string]string{"sessionID": "00000000-0000-0000-0000-000000000001"}))
	w := httptest.NewRecorder()
	deps.AgentPoll(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 without poll token (no oracle), got %d", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body["status"] != "not_found" {
		t.Errorf(`body = %v, want {"status":"not_found"} (agent contract, not writeJSONError's {"error"})`, body)
	}
}
```

DB integration (`agent_session_v2_test.go`): create session via `CreateAgentSession`, manually complete it with a sealed key (`UPDATE agent_sessions SET status='completed', api_key_sealed=$2 WHERE id=$1` after `auth.SealAgentKey(pub, id, "def_k")`), then assert:
- `auth.OpenAgentKey(raw, id, sealed)` round-trips; `MarkAgentKeyDelivered` sets `key_claimed_at` once (second call does not change the timestamp);
- **poll-time expiry (R4-2):** backdate `expires_at` to the past WITHOUT running the sweep, call `deps.AgentPoll` (pool-backed `Dependencies`) with the correct token → 200 `status:"completed"` but NO `api_key` field and the window-closed message — proves expiry is enforced at poll time, not only by the hourly sweep;
- backdating `expires_at` + `ExpireAgentSessions` nulls `api_key_sealed`;
- an `expired` session polls as 410 with body `{"status":"expired",...}` (exact body).

**Step 4: Run**

Run: `go build ./... && go test ./db -run 'AgentSession|AgentKey' -v && go test ./handler -run TestAgentPoll -v`
Expected: PASS. (Old `TestAgentPoll_*` validation tests unchanged and green.)

**Step 5: Commit**

```bash
git add packages/ingestion/db packages/ingestion/handler
git commit -m "feat(ingestion): poll v2 — X-Opslane-Poll-Token gate, sealed-key delivery, failed status, purge sweep"
```

---

## Task 6: Failure marking + funnel click stamp

**Files:**
- Modify: `packages/ingestion/db/queries.go`
- Modify: `packages/ingestion/handler/agent_setup.go` (`AgentAuthRedirect`)

**Step 1: db queries**

```go
// MarkAgentSessionFailed records a definitive business failure. Only pending
// sessions transition; reasons are the agent-flow vocabulary (identity_unverified,
// installation_not_yours, repo_not_granted, org_exists_needs_invite, ...).
func (q *Queries) MarkAgentSessionFailed(ctx context.Context, sessionID, reason string) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET status = 'failed', failure_reason = $2
		 WHERE id = $1 AND status = 'pending'`, sessionID, reason)
	if err != nil {
		return false, fmt.Errorf("mark agent session failed: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// MarkAgentSessionAuthClicked stamps the first human click on the auth URL
// (funnel: auth_clicked). Idempotent via COALESCE.
func (q *Queries) MarkAgentSessionAuthClicked(ctx context.Context, sessionID string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET auth_clicked_at = COALESCE(auth_clicked_at, now())
		 WHERE id = $1`, sessionID)
	if err != nil {
		return fmt.Errorf("mark agent session auth clicked: %w", err)
	}
	return nil
}
```

**Step 2:** In `AgentAuthRedirect`, after the session status/expiry checks pass and before the redirect, add:

```go
	if err := d.Queries.MarkAgentSessionAuthClicked(r.Context(), sessionID); err != nil {
		slog.Warn("agent auth redirect: stamp click", "error", err)
	}
```

**Step 3:** Integration tests in `agent_session_v2_test.go`: `MarkAgentSessionFailed` flips pending→failed with reason and returns false on a second call; `MarkAgentSessionAuthClicked` is idempotent (timestamp unchanged on second call).

**Step 4:** Run: `go build ./... && go test ./db -run AgentSession -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/db packages/ingestion/handler
git commit -m "feat(ingestion): agent session failure states + auth-click funnel stamp"
```

---

## Task 7: `ProvisionAgentSession` — the one transaction (happy paths)

**Files:**
- Create: `packages/ingestion/db/agent_provision.go`
- Create: `packages/ingestion/db/agent_provision_test.go`

**Step 1: Write the failing happy-path test**

```go
package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func provisionInput(sessionID string) db.AgentProvisionInput {
	return db.AgentProvisionInput{
		SessionID:      sessionID,
		InstallationID: 424242,
		CanonicalRepo:  "Prov-Owner/Prov-Repo", // canonical case from GitHub
		GitHubOrgName:  "prov-owner",
		GitHubOrgID:    987654,
		GitHubUserID:   13371337,
		GitHubLogin:    "prov-user",
		DisplayName:    "Prov User",
		Email:          "prov-user@example.com",
		EmailVerified:  true,
		AvatarURL:      "https://example.com/a.png",
		SealKey:        func(raw string) (string, error) { return "sealed:" + raw, nil },
	}
}

func TestProvisionAgentSession_NewOrgUserProjectKey(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	s, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		RepoURL: "prov-owner/prov-repo", PollTokenHash: "h", AgentKeyPub: "p"})
	if err != nil {
		t.Fatal(err)
	}
	res, err := q.ProvisionAgentSession(ctx, provisionInput(s.ID))
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	t.Cleanup(func() {
		cleanupTenant(t, pool, res.OrgID)
		pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, s.ID)
		pool.Exec(ctx, `DELETE FROM github_app_installations WHERE installation_id = 424242`)
	})

	after, _ := q.GetAgentSession(ctx, s.ID)
	if after.Status != "completed" || after.APIKeySealed == nil {
		t.Fatalf("session not completed with sealed key: %+v", after)
	}
	// The project stores GitHub's canonical full_name, not the request casing.
	var repo string
	pool.QueryRow(ctx, `SELECT github_repo FROM projects WHERE id = $1`, res.ProjectID).Scan(&repo)
	if repo != "Prov-Owner/Prov-Repo" {
		t.Errorf("github_repo = %q, want canonical", repo)
	}
	// The user exists, is in the org, and the identity is recorded as verified.
	var verified bool
	pool.QueryRow(ctx,
		`SELECT ai.email_verified FROM auth_identities ai
		 JOIN users u ON u.id = ai.user_id
		 WHERE u.org_id = $1 AND ai.provider = 'github' AND ai.provider_subject = '13371337'`,
		res.OrgID).Scan(&verified)
	if !verified {
		t.Error("expected verified github identity")
	}
}
```

**Step 2:** Run: `go test ./db -run TestProvisionAgentSession_New -v`
Expected: FAIL — `undefined: db.ProvisionAgentSession`.

**Step 3: Implement `agent_provision.go`**

```go
package db

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Sentinel errors — definitive business failures. ProvisionAgentSession has
// already marked the session failed (and committed that) when returning one.
var (
	ErrAgentSessionNotPending     = errors.New("agent session is not pending")
	ErrAgentIdentityUnverified    = errors.New("github identity has no verified email")
	ErrAgentOrgExistsNeedsInvite  = errors.New("installation org already exists; user needs an invite")
	ErrAgentRepoAlreadyConfigured = errors.New("repo already has a project")
)

type AgentProvisionInput struct {
	SessionID      string
	InstallationID int64
	// CanonicalRepo is GitHub's full_name for the requested repo from the
	// installation's repo list (rename/case canonical — decision 16).
	CanonicalRepo string
	GitHubOrgName string
	GitHubOrgID   int64
	GitHubUserID  int64
	GitHubLogin   string
	DisplayName   string
	Email         string
	EmailVerified bool
	AvatarURL     string
	// SealKey encrypts the raw API key for poll delivery (decision 15).
	SealKey func(rawKey string) (string, error)
}

type AgentProvisionResult struct {
	OrgID     string
	ProjectID string
}

// ProvisionAgentSession performs the entire agent onboarding write set in ONE
// transaction (F5/R2): session row lock, advisory lock on canonical repo
// identity (R3-3), org/user/identity/installation resolution under D-A rules,
// project + environment + API key creation, and session completion.
//
// Business failures mark the session failed IN THE SAME TRANSACTION, commit,
// and return a sentinel. Unexpected errors roll back (session stays pending).
func (q *Queries) ProvisionAgentSession(ctx context.Context, in AgentProvisionInput) (*AgentProvisionResult, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin agent provision: %w", err)
	}
	defer tx.Rollback(ctx)

	// 1. Lock the session row; only a pending, unexpired session proceeds.
	var status string
	var expiresAt time.Time
	err = tx.QueryRow(ctx,
		`SELECT status, expires_at FROM agent_sessions WHERE id = $1 FOR UPDATE`,
		in.SessionID).Scan(&status, &expiresAt)
	if err == pgx.ErrNoRows {
		return nil, ErrAgentSessionNotPending
	}
	if err != nil {
		return nil, fmt.Errorf("lock agent session: %w", err)
	}
	if status != "pending" || time.Now().After(expiresAt) {
		return nil, ErrAgentSessionNotPending
	}

	fail := func(reason string, sentinel error) (*AgentProvisionResult, error) {
		if _, err := tx.Exec(ctx,
			`UPDATE agent_sessions SET status = 'failed', failure_reason = $2 WHERE id = $1`,
			in.SessionID, reason); err != nil {
			return nil, fmt.Errorf("mark failed (%s): %w", reason, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit failure (%s): %w", reason, err)
		}
		return nil, sentinel
	}

	// 2. Serialize on canonical repo identity, then re-check for an existing
	// project under the lock — a session-row lock alone cannot stop two
	// DIFFERENT sessions racing the same repo (R3-3).
	repoKey := strings.ToLower(in.CanonicalRepo)
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended('agent_repo:' || $1, 0))`, repoKey); err != nil {
		return nil, fmt.Errorf("advisory lock: %w", err)
	}
	var existingProjectID string
	err = tx.QueryRow(ctx,
		`SELECT id FROM projects WHERE lower(github_repo) = $1 LIMIT 1`, repoKey).Scan(&existingProjectID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("recheck project: %w", err)
	}
	if err == nil {
		return fail("repo_already_configured", ErrAgentRepoAlreadyConfigured)
	}

	// 3. Resolve the user: provider-neutral identity first, then legacy
	// github_id, then verified email (same precedence as provisionGitHubIdentity).
	//
	// Identity resolution must itself be serialized (R4-4): two sessions for
	// DIFFERENT repos by the same new GitHub user would otherwise both reach
	// user creation and one would die on the users.github_id unique
	// constraint — an unexpected rollback that strands a pending session
	// whose OAuth code is already consumed. Take the SAME advisory-lock keys
	// ProvisionFromIdentityTx uses (read queries.go:1644ff and extract its
	// identity/email lock derivation into a shared helper — do NOT invent a
	// second key scheme, or agent and web-login provisioning of the same
	// human will not serialize against each other). Lock order everywhere:
	// repo → identity → email.
	subject := strconv.FormatInt(in.GitHubUserID, 10)
	if err := lockIdentityTx(ctx, tx, "github", subject); err != nil {
		return nil, err
	}
	if in.EmailVerified && in.Email != "" {
		if err := lockEmailTx(ctx, tx, NormalizeEmail(in.Email)); err != nil {
			return nil, err
		}
	}
	var userID, userOrgID string
	err = tx.QueryRow(ctx,
		`SELECT u.id, u.org_id FROM auth_identities ai JOIN users u ON u.id = ai.user_id
		 WHERE ai.provider = 'github' AND ai.provider_subject = $1`, subject).Scan(&userID, &userOrgID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("identity lookup: %w", err)
	}
	if userID == "" {
		err = tx.QueryRow(ctx,
			`SELECT id, org_id FROM users WHERE github_id = $1`, in.GitHubUserID).Scan(&userID, &userOrgID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, fmt.Errorf("github_id lookup: %w", err)
		}
	}
	if userID == "" && in.EmailVerified && in.Email != "" {
		err = tx.QueryRow(ctx,
			`SELECT id, org_id FROM users WHERE email = $1`, NormalizeEmail(in.Email)).Scan(&userID, &userOrgID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, fmt.Errorf("email lookup: %w", err)
		}
		if userID != "" {
			// Link the GitHub identity to the verified-email user.
			if _, err := tx.Exec(ctx,
				`UPDATE users SET github_id = $2, github_username = $3, avatar_url = $4, updated_at = now()
				 WHERE id = $1 AND github_id IS NULL`,
				userID, in.GitHubUserID, in.GitHubLogin, in.AvatarURL); err != nil {
				return nil, fmt.Errorf("link github: %w", err)
			}
		}
	}

	// 4. Resolve the org. An existing installation binds to its org; D-A says
	// an unaffiliated installer FAILS (org_exists_needs_invite) — never a
	// silent membership grant.
	var orgID string
	err = tx.QueryRow(ctx,
		`SELECT org_id FROM github_app_installations WHERE installation_id = $1`,
		in.InstallationID).Scan(&orgID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("installation lookup: %w", err)
	}
	if orgID == "" {
		// Legacy mapping (R4-5): web installs recorded before the rich table
		// only set orgs.github_installation_id. Without this check a legacy
		// installation would look "new" and get bound to a second org,
		// bypassing the D-A invite rule. Backfilled into the rich table by
		// step 6 below once resolved.
		err = tx.QueryRow(ctx,
			`SELECT id FROM orgs WHERE github_installation_id = $1
			 ORDER BY created_at ASC LIMIT 1`, in.InstallationID).Scan(&orgID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, fmt.Errorf("legacy installation lookup: %w", err)
		}
	}
	if orgID != "" {
		if userID == "" {
			return fail("org_exists_needs_invite", ErrAgentOrgExistsNeedsInvite)
		}
		affiliated := userOrgID == orgID
		if !affiliated {
			var n int
			if err := tx.QueryRow(ctx,
				`SELECT count(*) FROM memberships WHERE user_id = $1 AND org_id = $2`,
				userID, orgID).Scan(&n); err != nil {
				return nil, fmt.Errorf("membership check: %w", err)
			}
			affiliated = n > 0
		}
		if !affiliated {
			return fail("org_exists_needs_invite", ErrAgentOrgExistsNeedsInvite)
		}
	} else if userID != "" {
		orgID = userOrgID
	} else {
		// Truly new human. Fail closed on unverified email (same rule as
		// provisionGitHubIdentity — no synthesized noreply addresses).
		if !in.EmailVerified || in.Email == "" {
			return fail("identity_unverified", ErrAgentIdentityUnverified)
		}
		orgName := in.GitHubOrgName
		if orgName == "" {
			orgName = in.GitHubLogin
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO orgs (name) VALUES ($1) RETURNING id`, orgName).Scan(&orgID); err != nil {
			return nil, fmt.Errorf("create org: %w", err)
		}
		name := in.DisplayName
		if name == "" {
			name = in.GitHubLogin
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO users (org_id, email, name, github_id, github_username, avatar_url)
			 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			orgID, NormalizeEmail(in.Email), name, in.GitHubUserID, in.GitHubLogin, in.AvatarURL,
		).Scan(&userID); err != nil {
			return nil, fmt.Errorf("create user: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')
			 ON CONFLICT (user_id, org_id) DO NOTHING`, userID, orgID); err != nil {
			return nil, fmt.Errorf("create membership: %w", err)
		}
	}

	// 5. Record the identity with its REAL verification state.
	if userID != "" {
		if _, err := tx.Exec(ctx,
			`INSERT INTO auth_identities (user_id, provider, provider_subject, provider_email, email_verified)
			 VALUES ($1, 'github', $2, $3, $4)
			 ON CONFLICT (provider, provider_subject)
			 DO UPDATE SET provider_email = EXCLUDED.provider_email, email_verified = EXCLUDED.email_verified`,
			userID, subject, NormalizeEmail(in.Email), in.EmailVerified); err != nil {
			return nil, fmt.Errorf("upsert identity: %w", err)
		}
	}

	// 6. Record the installation (both the rich table and the legacy org column).
	if _, err := tx.Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (installation_id) DO UPDATE SET updated_at = now()`,
		in.InstallationID, in.GitHubOrgName, in.GitHubOrgID, orgID,
		[]byte(`["`+in.CanonicalRepo+`"]`)); err != nil {
		return nil, fmt.Errorf("upsert installation: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE orgs SET github_installation_id = $2 WHERE id = $1`, orgID, in.InstallationID); err != nil {
		return nil, fmt.Errorf("set org installation: %w", err)
	}

	// 7. Project + production environment + API key (existing Tx helpers).
	projectName := in.CanonicalRepo
	if idx := strings.LastIndex(in.CanonicalRepo, "/"); idx >= 0 {
		projectName = in.CanonicalRepo[idx+1:]
	}
	canonicalRepo := in.CanonicalRepo
	project, err := q.CreateProjectTx(ctx, tx, orgID, projectName, &canonicalRepo)
	if err != nil {
		return nil, err
	}
	env, err := q.CreateEnvironmentTx(ctx, tx, project.ID, "production")
	if err != nil {
		return nil, err
	}
	key, err := q.CreateAPIKeyTx(ctx, tx, env.ID)
	if err != nil {
		return nil, err
	}
	sealed, err := in.SealKey(key.RawKey)
	if err != nil {
		return nil, fmt.Errorf("seal api key: %w", err)
	}

	// 8. Complete the session in the SAME transaction (R2).
	tag, err := tx.Exec(ctx,
		`UPDATE agent_sessions
		 SET status = 'completed', org_id = $2, project_id = $3,
		     api_key_sealed = $4, installation_id = $5, completed_at = now()
		 WHERE id = $1 AND status = 'pending'`,
		in.SessionID, orgID, project.ID, sealed, in.InstallationID)
	if err != nil {
		return nil, fmt.Errorf("complete agent session: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, ErrAgentSessionNotPending
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit agent provision: %w", err)
	}
	return &AgentProvisionResult{OrgID: orgID, ProjectID: project.ID}, nil
}
```

**Step 3b: Shared identity-lock helpers.** Read `ProvisionFromIdentityTx` (`queries.go:1644ff`) and extract its identity/email advisory-lock key derivation into two package-level helpers used by BOTH paths:

```go
// lockIdentityTx / lockEmailTx take the provisioning advisory locks. One key
// scheme for all provisioning paths (web login + agent) — the locks only
// serialize if everyone derives them identically.
func lockIdentityTx(ctx context.Context, tx pgx.Tx, provider, subject string) error { /* extracted */ }
func lockEmailTx(ctx context.Context, tx pgx.Tx, email string) error               { /* extracted */ }
```

Refactor `ProvisionFromIdentityTx` to call the same helpers (behavior identical; its existing tests in `provisioning_test.go` must stay green).

**Step 4:** Run: `go test ./db -run 'TestProvisionAgentSession_New|Provision' -v`
Expected: PASS, including the pre-existing `provisioning_test.go` suite. If `memberships` has no unique constraint on `(user_id, org_id)` the `ON CONFLICT` errors — check `011_multi_org.sql` (it declares `UNIQUE(user_id, org_id)`; if named differently, target it).

**Step 5:** Add a second happy-path test: **returning user** — pre-create org+user+identity (use `q.CreateOrg`, `q.CreateUserGitHub`, `q.UpsertIdentityDetails`), then provision a session for a new repo with the same `GitHubUserID`; assert the project lands in the existing org and no new org row was created.

**Step 6:** Run both; commit:

```bash
git add packages/ingestion/db/agent_provision.go packages/ingestion/db/agent_provision_test.go
git commit -m "feat(ingestion): single-transaction agent provisioning with repo advisory lock"
```

---

## Task 8: `ProvisionAgentSession` failure paths + concurrency

**Files:**
- Modify: `packages/ingestion/db/agent_provision_test.go`

**Step 1: Failure-path tests** (each asserts the sentinel error AND that the session row is `failed` with the right `failure_reason`):

1. `identity_unverified`: input with `EmailVerified: false` and unknown GitHub user → `ErrAgentIdentityUnverified`.
2. `org_exists_needs_invite` (unknown user): pre-create an org + `UpsertGitHubAppInstallation` for installation 555; provision with an unknown GitHub user against installation 555 → `ErrAgentOrgExistsNeedsInvite`.
3. `org_exists_needs_invite` (known, unaffiliated user): pre-create org A (installation) and org B (user in B); provision the org-B user against org A's installation → same sentinel.
4. `repo_already_configured`: pre-create a project with `github_repo` differing only by case from `CanonicalRepo` → `ErrAgentRepoAlreadyConfigured` (proves case-insensitive re-check).
5. Not pending: complete a session first, provision again → `ErrAgentSessionNotPending`, and the session's status/reason are untouched.
6. **Legacy installation mapping (R4-5):** create an org with ONLY `orgs.github_installation_id = 888` set (no `github_app_installations` row), then provision an unaffiliated user against installation 888 → `ErrAgentOrgExistsNeedsInvite`, and NO second org row exists afterward.

**Step 2: Concurrency tests**

```go
func TestProvisionAgentSession_ConcurrentCallbacksOneWinner(t *testing.T) {
	// Same session, two goroutines: exactly one *AgentProvisionResult,
	// exactly one ErrAgentSessionNotPending, exactly one project row.
}

func TestProvisionAgentSession_ConcurrentSameRepoSessionsOneProject(t *testing.T) {
	// Two DIFFERENT sessions for the same repo (create the second after
	// expiring the first's pending status is NOT possible here since the
	// partial index blocks dual-pending — so simulate the residual race:
	// create session1, create session2 for a DIFFERENT casing of the repo
	// ("Owner/Repo" vs "owner/repo" both canonicalize to the same
	// CanonicalRepo), run both provisions concurrently. Exactly one
	// succeeds; the other returns ErrAgentRepoAlreadyConfigured. Exactly
	// one project row exists for lower(github_repo).
}
```

Add a third (R4-4):

```go
func TestProvisionAgentSession_ConcurrentSameIdentityDifferentRepos(t *testing.T) {
	// Two sessions for DIFFERENT repos, same new GitHubUserID/Email, provisioned
	// concurrently. Both must SUCCEED (no unique-violation rollback): the
	// identity advisory lock serializes them, the first creates the user+org,
	// the second resolves the existing user and lands its project in the SAME
	// org. Assert: exactly one users row for the github_id, exactly one org,
	// two projects, both sessions completed.
}
```

Write all three with `sync.WaitGroup` + channels collecting `(res, err)`; assert counts. Clean up both orgs/sessions.

**Step 3:** Run: `go test ./db -run TestProvisionAgentSession -v -race`
Expected: PASS with `-race`.

**Step 4: Commit**

```bash
git add packages/ingestion/db/agent_provision_test.go
git commit -m "test(ingestion): agent provisioning failure paths + concurrency guarantees"
```

---

## Task 9: Callback handler rework (`completeAgentInstall`)

**Files:**
- Modify: `packages/ingestion/handler/agent_setup.go` (replace `AgentAuthCallback` + `autoProvision`)
- Create: `packages/ingestion/handler/agent_callback_integration_test.go`

**Step 1: Replace `AgentAuthCallback` and DELETE `autoProvision`** (the db transaction owns provisioning now):

```go
// AgentAuthCallback completes an agent session after the human authorizes the
// GitHub App. With OAuth-during-install (design D-B) GitHub delivers
// code + installation_id + setup_action + state here.
//
// Trust chain (decisions 14/16, D-A):
//  1. code exchange → user token → identity (verified email required)
//  2. user token's /user/installations must contain installation_id
//  3. app JWT verifies the installation; installation token proves the repo grant
//  4. ProvisionAgentSession does all writes in one transaction
//
// Transient problems (missing/expired code, GitHub errors) leave the session
// pending and tell the human to reopen the auth link — the session ID is
// visible in URLs, so cheap unauthenticated requests must not kill sessions.
// Only outcomes proven with a live user token mark the session failed.
func (d *Dependencies) AgentAuthCallback(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("state")
	installationIDStr := r.URL.Query().Get("installation_id")
	if sessionID == "" || installationIDStr == "" {
		http.Error(w, "Missing required parameters", http.StatusBadRequest)
		return
	}
	if _, err := uuid.Parse(sessionID); err != nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}
	var installationID int64
	if _, err := fmt.Sscanf(installationIDStr, "%d", &installationID); err != nil || installationID <= 0 {
		agentResultPage(w, http.StatusBadRequest, "Invalid installation",
			"GitHub sent an invalid installation reference. Reopen the authorization link to retry.")
		return
	}

	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent callback: get session", "error", err)
		agentResultPage(w, http.StatusInternalServerError, "Something went wrong", "Reopen the authorization link to retry.")
		return
	}
	if session == nil || session.Status != "pending" || time.Now().After(session.ExpiresAt) {
		agentResultPage(w, http.StatusGone, "Session expired",
			"This setup session is no longer active. Ask your agent to run setup again.")
		return
	}

	if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 || d.GitHubAppClientID == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
		return
	}

	// 1. Mandatory identity (F1/F3): no code, no completion.
	code := r.URL.Query().Get("code")
	if code == "" {
		agentResultPage(w, http.StatusBadRequest, "Authorization incomplete",
			"GitHub did not return an authorization code. Reopen the authorization link and approve access.")
		return
	}
	token, err := gh.ExchangeOAuthCode(d.GitHubAppClientID, d.GitHubAppClientSecret, code)
	if err != nil {
		slog.Warn("agent callback: code exchange failed", "error", err)
		agentResultPage(w, http.StatusBadGateway, "GitHub authorization failed",
			"Could not confirm your GitHub identity. Reopen the authorization link to retry.")
		return
	}
	ghUser, err := gh.GetUser(token.AccessToken)
	if err != nil || ghUser == nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub authorization failed",
			"Could not load your GitHub profile. Reopen the authorization link to retry.")
		return
	}
	// A GitHub API failure here is TRANSIENT — it must not become a
	// definitive identity_unverified failure (R4-3). Only a successfully
	// fetched email list with no verified address is definitive.
	email, emailVerified, err := pickVerifiedEmail(token.AccessToken)
	if err != nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub check failed",
			"Could not load your GitHub email addresses. Reopen the authorization link to retry.")
		return
	}

	// 2. User↔installation binding (decision 14): the installation must appear
	// in the AUTHENTICATED user's own installation list.
	userInstalls, err := gh.ListUserInstallations(token.AccessToken)
	if err != nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub check failed",
			"Could not verify the installation. Reopen the authorization link to retry.")
		return
	}
	if !containsInstallation(userInstalls, installationID) {
		d.failAgentSession(r.Context(), sessionID, "installation_not_yours")
		agentResultPage(w, http.StatusForbidden, "Installation mismatch",
			agentFailureMessage("installation_not_yours"))
		return
	}

	// 3. App-side verification + repo grant proof (F2 / decision 16).
	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		slog.Error("agent callback: app jwt", "error", err)
		agentResultPage(w, http.StatusInternalServerError, "Something went wrong", "Reopen the authorization link to retry.")
		return
	}
	installInfo, err := gh.VerifyInstallation(appJWT, installationID)
	if err != nil {
		agentResultPage(w, http.StatusBadRequest, "Installation not recognized",
			"This installation does not belong to the Opslane app. Reopen the authorization link to retry.")
		return
	}
	instToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub check failed", "Reopen the authorization link to retry.")
		return
	}
	repos, err := gh.ListInstallationRepos(instToken.Token)
	if err != nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub check failed", "Reopen the authorization link to retry.")
		return
	}
	canonical := ""
	for _, repo := range repos {
		if strings.EqualFold(repo.FullName, session.RepoURL) {
			canonical = repo.FullName
			break
		}
	}
	if canonical == "" {
		d.failAgentSession(r.Context(), sessionID, "repo_not_granted")
		agentResultPage(w, http.StatusForbidden, "Repository not granted",
			agentFailureMessage("repo_not_granted"))
		return
	}

	// 4. One-transaction provisioning; the sealed key is only openable with
	// the poll token the CLI holds (decision 15).
	agentKeyPub := ""
	if session.AgentKeyPub != nil {
		agentKeyPub = *session.AgentKeyPub
	}
	res, err := d.Queries.ProvisionAgentSession(r.Context(), db.AgentProvisionInput{
		SessionID:      sessionID,
		InstallationID: installationID,
		CanonicalRepo:  canonical,
		GitHubOrgName:  installInfo.Account.Login,
		GitHubOrgID:    installInfo.Account.ID,
		GitHubUserID:   ghUser.ID,
		GitHubLogin:    ghUser.Login,
		DisplayName:    ghUser.Name,
		Email:          email,
		EmailVerified:  emailVerified,
		AvatarURL:      ghUser.AvatarURL,
		SealKey: func(rawKey string) (string, error) {
			return auth.SealAgentKey(agentKeyPub, sessionID, rawKey)
		},
	})
	switch {
	case err == nil:
		slog.Info("agent session completed", "session_id", sessionID,
			"org_id", res.OrgID, "project_id", res.ProjectID, "repo", canonical)
		agentResultPage(w, http.StatusOK, "Done!",
			fmt.Sprintf("Opslane is set up for <strong>%s</strong>. Your agent is finishing the integration — you can close this tab.",
				template.HTMLEscapeString(canonical)))
	case errors.Is(err, db.ErrAgentIdentityUnverified),
		errors.Is(err, db.ErrAgentOrgExistsNeedsInvite),
		errors.Is(err, db.ErrAgentRepoAlreadyConfigured):
		reason := agentReasonForErr(err)
		agentResultPage(w, http.StatusForbidden, "Setup could not finish", agentFailureMessage(reason))
	case errors.Is(err, db.ErrAgentSessionNotPending):
		agentResultPage(w, http.StatusGone, "Session already handled",
			"This setup session was already completed or expired. Check back with your agent.")
	default:
		slog.Error("agent callback: provision failed", "error", err)
		agentResultPage(w, http.StatusInternalServerError, "Something went wrong", "Reopen the authorization link to retry.")
	}
}
```

Plus the small helpers in the same file:

```go
func (d *Dependencies) failAgentSession(ctx context.Context, sessionID, reason string) {
	if _, err := d.Queries.MarkAgentSessionFailed(ctx, sessionID, reason); err != nil {
		slog.Error("agent callback: mark failed", "error", err, "reason", reason)
	}
}

func agentReasonForErr(err error) string {
	switch {
	case errors.Is(err, db.ErrAgentIdentityUnverified):
		return "identity_unverified"
	case errors.Is(err, db.ErrAgentOrgExistsNeedsInvite):
		return "org_exists_needs_invite"
	case errors.Is(err, db.ErrAgentRepoAlreadyConfigured):
		return "repo_already_configured"
	default:
		return ""
	}
}

// pickVerifiedEmail returns a verified email for the user (primary preferred)
// and whether one exists. The bare /user email field is NOT trusted as
// verified. An API error is returned as an error — callers must treat it as
// transient (retry), never as "unverified" (R4-3).
func pickVerifiedEmail(userToken string) (string, bool, error) {
	emails, err := gh.GetUserEmails(userToken)
	if err != nil {
		return "", false, fmt.Errorf("fetch user emails: %w", err)
	}
	for _, e := range emails {
		if e.Primary && e.Verified {
			return e.Email, true, nil
		}
	}
	for _, e := range emails {
		if e.Verified {
			return e.Email, true, nil
		}
	}
	return "", false, nil
}

func containsInstallation(ids []int64, id int64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// agentResultPage renders the human-facing outcome page for the browser leg.
func agentResultPage(w http.ResponseWriter, status int, title, bodyHTML string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>Opslane Setup</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 100px auto; text-align: center;">
<h1>%s</h1><p>%s</p>
</body></html>`, template.HTMLEscapeString(title), bodyHTML)
}
```

Note: `GetUserEmails` needs a `user:email`-capable token; the GitHub App must have **Account permissions → Email addresses: Read-only** — add this to the deploy notes in Task 12 (the dev App from the spike may need the permission added under its Settings → Permissions & events).

**Step 2: Integration test** (`agent_callback_integration_test.go`, package `handler`). Skip-if-no-DB like the db tests (connect a `pgxpool` to `postgres://opslane:opslane_dev@localhost:5434/opslane` or `DATABASE_URL`, `t.Skipf` on failure). Build:

1. A `httptest.Server` faking GitHub: `POST /login/oauth/access_token` → user token; `GET /user` → `{id: 999001, login: "cb-user"}`; `GET /user/emails` → one primary verified; `GET /user/installations` → `{installations:[{id: 777001}]}`; `GET /app/installations/777001` → account info; `POST /app/installations/777001/access_tokens` → token; `GET /installation/repositories` → `{repositories:[{full_name:"CB-Owner/CB-Repo"}]}`.
2. `restore := gh.OverrideHTTPClientForTests(...)` with the redirecting transport (same pattern as `github/app_test.go:72`); `defer restore()`.
3. `deps := &Dependencies{Queries: db.New(pool), GitHubAppID: "1", GitHubAppClientID: "cid", GitHubAppClientSecret: "sec", GitHubAppPrivateKey: <test RSA PEM — generate with crypto/rsa like github/app_test.go generateTestKey>}`.
4. Create a session via `AgentSetup`-equivalent: call `auth.NewAgentPollToken()`, `deps.Queries.CreateAgentSession(...)` with repo `cb-owner/cb-repo` (lowercase — proves canonicalization).
5. `GET /agent/auth/callback?state=<id>&installation_id=777001&setup_action=install&code=x` → expect 200 page containing "Done!".
6. Poll path: call `deps.AgentPoll` with the `X-Opslane-Poll-Token` header set to the raw token → expect `status=completed` and an `api_key` starting `def_` (proves seal→open end-to-end); a second poll returns the same key (idempotent).
7. Negative: repeat with `/user/installations` returning `{installations:[]}` → session becomes `failed/installation_not_yours` and poll reports it.
8. Transient-email negative (R4-3): stub `/user/emails` to return 500 → callback renders the retry page, session stays `pending` (assert status unchanged); stub it to return `[]` (success, no verified email) → provisioning fails `identity_unverified` (definitive).

**Step 3:** Run: `go build ./... && go test ./handler -run 'AgentAuth|AgentCallback' -v`
Expected: PASS, including the old `TestAgentAuthCallback_MissingParams`/`_InvalidSessionID` (behavior unchanged for those paths).

**Step 4: Commit**

```bash
git add packages/ingestion/handler
git commit -m "feat(ingestion): hardened agent callback — mandatory identity, installation binding, repo proof, tx provisioning"
```

---

## Task 10: Shared dispatcher + web-branch binding + SetupWizard state migration

**Files:**
- Modify: `packages/ingestion/handler/github_oauth.go`
- Modify: `packages/ingestion/auth/provider.go` (Identity struct) and `packages/ingestion/auth/github_provider.go`
- Modify: `packages/ingestion/handler/github_oauth_test.go` (expectations)

**Step 1: Dispatcher.** At the very top of `OAuthLoginCallback` (`github_oauth.go:73`), before the provider-error check:

```go
	// Agent-first install dispatch (design D-B): with OAuth-during-install
	// enabled, GitHub delivers EVERY install of the App to this callback URL.
	// Agent sessions carry their session UUID in state; browser-login and
	// SetupWizard-install states are HMAC hex and never parse as UUIDs.
	if state := r.URL.Query().Get("state"); state != "" && r.URL.Query().Get("installation_id") != "" {
		if _, err := uuid.Parse(state); err == nil {
			d.AgentAuthCallback(w, r)
			return
		}
	}
```

**Step 2: Identity carries the provider access token.** In `auth/provider.go`, add to `Identity`:

```go
	// AccessToken is the provider's user access token from the code exchange.
	// GitHub-only today; used to verify installation ownership (decision 14).
	// Never persisted.
	AccessToken string
```

In `github_provider.go`'s `ExchangeCode`, populate `AccessToken` with the exchanged token when building the Identity. (Read the function first; it already holds the token to fetch the user/emails.)

**Step 3: Bind the web branch.** Change `applyCombinedGitHubInstallation(r, user)` to `applyCombinedGitHubInstallation(r, user, identity)` (update the call site in `OAuthLoginCallback`), and after `VerifyInstallation` add:

```go
	// Decision 14: the query-string installation_id is attacker-controlled.
	// It must appear in the AUTHENTICATED user's own installation list.
	if identity.AccessToken == "" {
		return fmt.Errorf("cannot verify installation ownership")
	}
	userInstalls, err := gh.ListUserInstallations(identity.AccessToken)
	if err != nil {
		return fmt.Errorf("verify installation ownership: %w", err)
	}
	if !containsInstallation(userInstalls, installationID) {
		return fmt.Errorf("installation does not belong to the authenticated user")
	}
```

**Step 4: SetupWizard install-state migration.** In `GetGitHubAppStatus` (`github_oauth.go:~370`), replace the `__github_state` cookie block: keep `generateOAuthState`, then mirror `redirectToProvider`'s persistence — `StoreOAuthLoginState(auth.HashToken(state), time.Now().Add(5*time.Minute))` and set the cookie as `__auth_state` with `Path: "/auth"` (exact attributes from `redirectToProvider`, `github_oauth.go:58-68`). With OAuth-during-install ON, the SetupWizard install redirect now lands on `/auth/callback`, passes state validation, provisions the (already-existing) user via identity, stores the installation through the **bound** `applyCombinedGitHubInstallation`, and redirects to `/auth/complete` — the wizard's status polling picks it up. The legacy `GET /api/v1/github/setup` path stays for Apps not yet flipped.

**Step 5: Tests.**

- Unit: a dispatcher test in `handler` — request to `OAuthLoginCallback` with `state=<uuid>&installation_id=1` and `Dependencies{Queries: db.New(pool)}` (or nil-safe fake) routes into agent handling (assert it does NOT return "invalid OAuth state", which the login path would). With no DB, use the integration pool.
- Run the whole handler suite: `go test ./handler -v` — fix `github_oauth_test.go` assertions that reference the old `__github_state` cookie.

**Step 6:** Run: `go build ./... && go test ./auth ./handler -v`
Expected: PASS.

**Step 7: Commit**

```bash
git add packages/ingestion/auth packages/ingestion/handler
git commit -m "feat(ingestion): shared install dispatcher; bind web installs to the authenticated user"
```

---

## Task 11: Delete dead code + full gate

**Files:**
- Modify: `packages/ingestion/db/queries.go` — DELETE `CompleteAgentSession` and `ClaimAgentSessionKey` (provisioning tx owns completion; sealed delivery replaced claims).
- Modify: `packages/ingestion/db/agent_session_test.go` — delete the two `ClaimAgentSessionKey` tests (superseded by Task 5/9 coverage); keep/port anything still meaningful into `agent_session_v2_test.go`.

**Step 1:** Delete; `grep -rn "CompleteAgentSession\|ClaimAgentSessionKey" packages/ingestion` must return nothing, and `grep -rn "api_key_plaintext" packages/ingestion --include='*.go'` must return nothing (the COLUMN still exists — expand phase, dropped by 017 later — but no Go code may reference it).

**Step 2: Full package gate**

Run: `cd packages/ingestion && go build ./... && go test ./... -count=1`
Expected: ALL PASS (with Postgres up; nothing newly skipped).

**Step 3: Repo gate** (shared types untouched, but be safe): `docker compose config --quiet` from the root.

**Step 4: Commit**

```bash
git add packages/ingestion
git commit -m "chore(ingestion): remove superseded agent session claim/complete paths"
```

---

## Task 12: Docs + deploy notes

**Files:**
- Modify: `docs/reference/http-routes.md:20-23`
- Modify: `docs/plans/2026-07-18-agent-first-onboarding-design.md` (status only)

**Step 1:** Update the routes table: `/api/v1/agent/poll/{sessionID}` auth column `none` → `poll token (X-Opslane-Poll-Token header)`; add a sentence under the table noting the agent callback contract (`code`, `installation_id`, `state` required; sessions fail with machine-readable reasons) and that `/auth/callback` dispatches agent installs. Run `pnpm docs:check` if it exists at root (see root `package.json`); otherwise ensure `go test ./...` and the docs-sync workflow have nothing referencing the removed plaintext column.

**Step 2:** Design doc: flip the PR 1 line in `## Work plan` to note implementation landed (one line, e.g. "**Status: implemented** — see `2026-07-18-agent-onboarding-pr1-server-plan.md`").

**Step 3:** Add deploy notes to the design doc's Launch blockers section (append two bullets):
- Production GitHub App needs: "Request user authorization (OAuth) during installation" ON, callback URL = `<AUTH_CALLBACK_ORIGIN>/auth/callback`, and Account permission **Email addresses: Read-only** (for verified-email checks).
- `AUTH_CALLBACK_ORIGIN` must be set in hosted deploys (agent auth URLs and the dispatcher depend on it); proxy must forward `X-Forwarded-Proto: https`.

**Step 4:** Final gate: `go build ./... && go test ./... -count=1` once more, then commit:

```bash
git add docs
git commit -m "docs: agent onboarding PR 1 route contract + deploy notes"
```

**Step 5:** STOP — do not push (repo hook blocks agent pushes). Tell the user PR 1 is ready for `! git push` + `gh pr create`.

---

## Out of scope for this plan (later PRs)

CLI changes (`--start`/`--poll`, credentials keying, contract doc), quickstart content, dashboard cards, funnel query/readout (`OnboardingFunnel` — the columns exist after Task 1), live smoke, activation. Each gets its own plan per the design doc.
