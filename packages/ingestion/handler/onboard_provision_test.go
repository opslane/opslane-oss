package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func onboardProvisionRequest(body string, userID, orgID string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "https://ingest.example/api/v1/onboard/provision", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := context.WithValue(req.Context(), ctxUserID, userID)
	ctx = context.WithValue(ctx, ctxOrgID, orgID)
	return req.WithContext(ctx)
}

func TestOnboardProvisionRequiresAuthenticatedContext(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/onboard/provision", strings.NewReader(`{"repo_url":"acme/web"}`))
	w := httptest.NewRecorder()

	(&Dependencies{}).OnboardProvision(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
}

func TestOnboardProvisionValidatesRequest(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "invalid JSON", body: `{`},
		{name: "missing repo", body: `{}`},
		{name: "invalid repo", body: `{"repo_url":"https://github.com/acme/web"}`},
		{name: "too many path segments", body: `{"repo_url":"acme/platform/web"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			(&Dependencies{}).OnboardProvision(w, onboardProvisionRequest(tc.body, uuid.NewString(), uuid.NewString()))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400; body=%s", w.Code, w.Body.String())
			}
			if got := w.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
		})
	}
}

func TestOnboardProvisionRejectsOversizedBody(t *testing.T) {
	body := `{"repo_url":"acme/web","padding":"` + strings.Repeat("x", 1<<16) + `"}`
	w := httptest.NewRecorder()

	(&Dependencies{}).OnboardProvision(w, onboardProvisionRequest(body, uuid.NewString(), uuid.NewString()))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400; body=%s", w.Code, w.Body.String())
	}
}

func TestOnboardProvisionRateLimitIsPerUser(t *testing.T) {
	previous := onboardProvisionLimiter
	onboardProvisionLimiter = newRateLimiter(10)
	t.Cleanup(func() { onboardProvisionLimiter = previous })

	userID := uuid.NewString()
	orgID := uuid.NewString()
	var w *httptest.ResponseRecorder
	for range 11 {
		w = httptest.NewRecorder()
		(&Dependencies{}).OnboardProvision(w, onboardProvisionRequest(`{}`, userID, orgID))
	}
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("code = %d, want 429; body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Retry-After"); got != "60" {
		t.Fatalf("Retry-After = %q, want 60", got)
	}
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["status"] != "rate_limited" || response["retry_after"] != float64(60) {
		t.Fatalf("response = %v", response)
	}

	other := httptest.NewRecorder()
	(&Dependencies{}).OnboardProvision(other, onboardProvisionRequest(`{}`, uuid.NewString(), orgID))
	if other.Code != http.StatusBadRequest {
		t.Fatalf("different user code = %d, want 400", other.Code)
	}
}

func TestOnboardProvisionCreatesCanonicalResponseAndRotatesKey(t *testing.T) {
	pool := githubOAuthTestPool(t)
	orgID, userID := seedOnboardProvisionActor(t, pool)
	q := db.New(pool)
	deps := &Dependencies{Queries: q}
	agentName := "codex"
	body := fmt.Sprintf(`{"repo_url":"acme/%s","agent_name":%q}`, "web-"+uuid.NewString(), agentName)

	call := func() (map[string]any, *httptest.ResponseRecorder) {
		t.Helper()
		w := httptest.NewRecorder()
		deps.OnboardProvision(w, onboardProvisionRequest(body, userID, orgID))
		if w.Code != http.StatusCreated {
			t.Fatalf("code = %d, want 201; body=%s", w.Code, w.Body.String())
		}
		if got := w.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
		var response map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response, w
	}

	first, _ := call()
	for _, field := range []string{"api_key", "endpoint", "org_id", "project_id", "repo", "poll_id", "poll_token"} {
		if first[field] == nil || first[field] == "" {
			t.Fatalf("missing %s in response: %v", field, first)
		}
	}
	if first["status"] != "provisioned" || first["endpoint"] != "https://ingest.example" || first["org_id"] != orgID {
		t.Fatalf("unexpected canonical response: %v", first)
	}
	assertOnboardSessionActorAndSeal(t, pool, first, userID, agentName)

	second, _ := call()
	if second["status"] != "provisioned" || second["project_id"] != first["project_id"] {
		t.Fatalf("repeat response does not reuse project: first=%v second=%v", first, second)
	}
	if second["api_key"] == first["api_key"] {
		t.Fatalf("repeat response did not rotate API key")
	}

	assertOnboardSessionActorAndSeal(t, pool, second, userID, agentName)
	var firstStatus string
	var firstSealed *string
	if err := pool.QueryRow(context.Background(),
		`SELECT status, api_key_sealed FROM agent_sessions WHERE id = $1`, first["poll_id"],
	).Scan(&firstStatus, &firstSealed); err != nil {
		t.Fatal(err)
	}
	if firstStatus != "expired" || firstSealed != nil {
		t.Fatalf("superseded session status/sealed = %q/%v, want expired/nil", firstStatus, firstSealed)
	}
}

func TestOnboardProvisionNormalizesAgentNameLikeAgentSetup(t *testing.T) {
	pool := githubOAuthTestPool(t)
	orgID, userID := seedOnboardProvisionActor(t, pool)
	q := db.New(pool)
	deps := &Dependencies{Queries: q}
	for _, tc := range []struct {
		name      string
		agentJSON string
		want      *string
	}{
		{name: "omitted"},
		{name: "null", agentJSON: `,"agent_name":null`},
		{name: "empty", agentJSON: `,"agent_name":""`},
		{name: "present", agentJSON: `,"agent_name":"codex"`, want: stringPointer("codex")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"repo_url":"acme/agent-%s"%s}`, uuid.NewString(), tc.agentJSON)
			w := httptest.NewRecorder()
			deps.OnboardProvision(w, onboardProvisionRequest(body, userID, orgID))
			if w.Code != http.StatusCreated {
				t.Fatalf("code = %d, want 201; body=%s", w.Code, w.Body.String())
			}
			var response map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			var storedAgentName *string
			if err := pool.QueryRow(context.Background(),
				`SELECT agent_name FROM agent_sessions WHERE id = $1`, response["poll_id"],
			).Scan(&storedAgentName); err != nil {
				t.Fatal(err)
			}
			if tc.want == nil && storedAgentName != nil {
				t.Fatalf("stored agent_name = %q, want NULL", *storedAgentName)
			}
			if tc.want != nil && (storedAgentName == nil || *storedAgentName != *tc.want) {
				t.Fatalf("stored agent_name = %v, want %q", storedAgentName, *tc.want)
			}
		})
	}
}

func stringPointer(value string) *string { return &value }

func seedOnboardProvisionActor(t *testing.T, pool *pgxpool.Pool) (orgID, userID string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, "onboard-handler-"+uuid.NewString()).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_sessions WHERE org_id = $1`, orgID)
		cleanupCallbackTenant(t, pool, "", 0, orgID)
	})
	email := fmt.Sprintf("onboard-handler-%s@example.com", uuid.NewString())
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (org_id, email, password_hash, name) VALUES ($1, $2, 'test', 'Onboard Actor') RETURNING id`,
		orgID, email,
	).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	return orgID, userID
}

func assertOnboardSessionActorAndSeal(t *testing.T, pool *pgxpool.Pool, response map[string]any, userID, agentName string) {
	t.Helper()
	pollID, _ := response["poll_id"].(string)
	pollToken, _ := response["poll_token"].(string)
	wantKey, _ := response["api_key"].(string)
	var actorID, sealed, storedAgentName string
	var createdAt, expiresAt time.Time
	if err := pool.QueryRow(context.Background(), `
		SELECT provisioned_by_user_id, api_key_sealed, agent_name, created_at, expires_at
		FROM agent_sessions WHERE id = $1`, pollID,
	).Scan(&actorID, &sealed, &storedAgentName, &createdAt, &expiresAt); err != nil {
		t.Fatal(err)
	}
	if actorID != userID || storedAgentName != agentName {
		t.Fatalf("session actor/agent = %q/%q, want %q/%q", actorID, storedAgentName, userID, agentName)
	}
	opened, err := auth.OpenAgentKey(pollToken, pollID, sealed)
	if err != nil {
		t.Fatalf("open sealed key: %v", err)
	}
	if opened != wantKey {
		t.Fatalf("opened key does not match response key")
	}
	if ttl := expiresAt.Sub(createdAt); ttl < 23*time.Hour || ttl > 25*time.Hour {
		t.Fatalf("session TTL = %v, want about 24h", ttl)
	}
}
