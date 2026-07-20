package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/handler"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

func postEnvironmentEvent(t *testing.T, router http.Handler, rawKey, sessionID, environment, message string) string {
	t.Helper()
	body := fmt.Sprintf(`{"error":{"type":"Error","message":%q,"stack":"at app.js:1:1"},"session_id":%q,"environment":%q}`, message, sessionID, environment)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(body))
	req.Header.Set("X-API-Key", rawKey)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("event status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var response map[string]string
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	return response["event_id"]
}

func postEnvironmentSession(t *testing.T, router http.Handler, rawKey, sessionID, environment string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"session_id":%q,"environment":%q}`, sessionID, environment)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/init", strings.NewReader(body))
	req.Header.Set("X-API-Key", rawKey)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func TestPayloadEnvironmentAndSessionPrecedenceThroughHTTPAndPostgres(t *testing.T) {
	deps, pool := testDeps(t)
	deps.MinIO = &minioPkg.Client{}
	q := deps.Queries
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "phase5-handler-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenantHandler(t, pool, org.ID)
	})
	project, _ := q.CreateProject(ctx, org.ID, "p1", nil)
	production, _ := q.CreateEnvironment(ctx, project.ID, "production")
	staging, _ := q.CreateEnvironment(ctx, project.ID, "staging")
	key, _ := q.CreateAPIKey(ctx, production.ID)
	allow := true
	if _, err := q.UpdateProject(ctx, org.ID, project.ID, nil, nil, nil, &allow); err != nil {
		t.Fatal(err)
	}

	other, _ := q.CreateProject(ctx, org.ID, "p2", nil)
	otherEnvironment, _ := q.CreateEnvironment(ctx, other.ID, "production")
	otherKey, _ := q.CreateAPIKey(ctx, otherEnvironment.ID)
	router := handler.NewRouter(deps)

	overriddenEventID := postEnvironmentEvent(t, router, key.RawKey, "", "staging", "payload override "+uuid.NewString())
	var storedEnvironmentID string
	if err := pool.QueryRow(ctx, `SELECT environment_id FROM error_events WHERE id = $1`, overriddenEventID).Scan(&storedEnvironmentID); err != nil {
		t.Fatal(err)
	}
	if storedEnvironmentID != staging.ID {
		t.Fatalf("override environment = %s, want %s", storedEnvironmentID, staging.ID)
	}

	sessionID := "sess_" + uuid.NewString()
	if response := postEnvironmentSession(t, router, key.RawKey, sessionID, "staging"); response.Code != http.StatusOK {
		t.Fatalf("session init status = %d, body=%s", response.Code, response.Body.String())
	}
	sessionEventID := postEnvironmentEvent(t, router, key.RawKey, sessionID, "production", "session wins "+uuid.NewString())
	if err := pool.QueryRow(ctx, `SELECT environment_id FROM error_events WHERE id = $1`, sessionEventID).Scan(&storedEnvironmentID); err != nil {
		t.Fatal(err)
	}
	if storedEnvironmentID != staging.ID {
		t.Fatalf("session event environment = %s, want %s", storedEnvironmentID, staging.ID)
	}

	if response := postEnvironmentSession(t, router, otherKey.RawKey, sessionID, "production"); response.Code != http.StatusConflict {
		t.Fatalf("cross-project session status = %d, want 409; body=%s", response.Code, response.Body.String())
	}
	crossProjectEventID := postEnvironmentEvent(t, router, otherKey.RawKey, sessionID, "production", "cross-project event "+uuid.NewString())
	if err := pool.QueryRow(ctx, `SELECT environment_id FROM error_events WHERE id = $1`, crossProjectEventID).Scan(&storedEnvironmentID); err != nil {
		t.Fatal(err)
	}
	if storedEnvironmentID != otherEnvironment.ID {
		t.Fatalf("cross-project event environment = %s, want key environment %s", storedEnvironmentID, otherEnvironment.ID)
	}
}

func TestPayloadEnvironmentFallbacksRemainAcceptedAndObservable(t *testing.T) {
	deps, pool := testDeps(t)
	q := deps.Queries
	ctx := context.Background()
	orgID, projectID, productionID, rawKey := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	staging, err := q.CreateEnvironment(ctx, projectID, "staging")
	if err != nil {
		t.Fatal(err)
	}
	router := handler.NewRouter(deps)

	assertProduction := func(environment, message string) {
		eventID := postEnvironmentEvent(t, router, rawKey, "", environment, message+uuid.NewString())
		var got string
		if err := pool.QueryRow(ctx, `SELECT environment_id FROM error_events WHERE id = $1`, eventID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != productionID {
			t.Fatalf("fallback for %q stored %s, want %s", environment, got, productionID)
		}
	}
	assertProduction("staging", "disabled-")
	allow := true
	if _, err := q.UpdateProject(ctx, orgID, projectID, nil, nil, nil, &allow); err != nil {
		t.Fatal(err)
	}
	assertProduction("missing", "unknown-")
	assertProduction("bad environment", "invalid-")

	metrics := httptest.NewRecorder()
	handler.Metrics(metrics, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	for _, label := range []string{`reason="disabled"`, `reason="unknown_name"`, `reason="invalid_name"`} {
		if !strings.Contains(metrics.Body.String(), "opslane_ingest_env_override_fallback_total{"+label+"}") {
			t.Errorf("metrics missing %s: %s", label, metrics.Body.String())
		}
	}
	_ = staging
}

func TestReplayInitRejectsSessionOwnedByAnotherProject(t *testing.T) {
	deps, pool := testDeps(t)
	deps.MinIO = &minioPkg.Client{}
	q := deps.Queries
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "phase5-replay-owner-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenantHandler(t, pool, org.ID)
	})
	p1, _ := q.CreateProject(ctx, org.ID, "p1", nil)
	p2, _ := q.CreateProject(ctx, org.ID, "p2", nil)
	e1, _ := q.CreateEnvironment(ctx, p1.ID, "production")
	e2, _ := q.CreateEnvironment(ctx, p2.ID, "production")
	k1, _ := q.CreateAPIKey(ctx, e1.ID)
	k2, _ := q.CreateAPIKey(ctx, e2.ID)
	router := handler.NewRouter(deps)
	sessionID := "sess_" + uuid.NewString()
	if response := postEnvironmentSession(t, router, k1.RawKey, sessionID, ""); response.Code != http.StatusOK {
		t.Fatalf("session init status = %d, body=%s", response.Code, response.Body.String())
	}
	body := fmt.Sprintf(`{"session_id":%q,"trigger_type":"error"}`, sessionID)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/replays/init", strings.NewReader(body))
	req.Header.Set("X-API-Key", k2.RawKey)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("replay init status = %d, want 404; body=%s", recorder.Code, recorder.Body.String())
	}
}
