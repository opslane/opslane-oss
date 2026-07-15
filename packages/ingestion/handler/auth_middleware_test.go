package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

const authTestJWTSecret = "auth-middleware-test-secret"

// authTestRouter builds the real router against the test database, skipping
// (like the db package helpers) when Postgres is unreachable.
func authTestRouter(t *testing.T) (http.Handler, *db.Queries, *pgxpool.Pool) {
	t.Helper()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("skipping auth middleware test: cannot connect to postgres: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Skipf("skipping auth middleware test: postgres not reachable: %v", err)
	}
	t.Cleanup(pool.Close)

	q := db.New(pool)
	deps := &handler.Dependencies{
		Queries:   q,
		JWTSecret: []byte(authTestJWTSecret),
	}
	return handler.NewRouter(deps), q, pool
}

func doRequest(router http.Handler, method, path string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestRoutes_HealthAndUnknownPath(t *testing.T) {
	router, _, _ := authTestRouter(t)

	if w := doRequest(router, "GET", "/health", nil); w.Code != http.StatusOK {
		t.Errorf("GET /health = %d, want 200", w.Code)
	}
	if w := doRequest(router, "GET", "/api/v1/definitely-not-a-route", nil); w.Code != http.StatusNotFound {
		t.Errorf("GET unknown route = %d, want 404", w.Code)
	}
}

func TestAuthenticateSDK_RejectsMissingAndInvalidKeys(t *testing.T) {
	router, _, _ := authTestRouter(t)

	// No key at all.
	if w := doRequest(router, "POST", "/api/v1/events", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("POST /events without key = %d, want 401", w.Code)
	}

	// A key that does not exist.
	w := doRequest(router, "POST", "/api/v1/events", map[string]string{"X-API-Key": "def_bogus"})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("POST /events with bogus key = %d, want 401", w.Code)
	}
}

func TestAuthenticateSDK_RejectsRevokedKey(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgID, projectID, _, rawKey := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	// Valid key passes the auth middleware (project mismatch would be 403,
	// anything auth-related is 401).
	path := "/api/v1/projects/" + projectID + "/event-count"
	if w := doRequest(router, "GET", path, map[string]string{"X-API-Key": rawKey}); w.Code != http.StatusOK {
		t.Fatalf("GET event-count with valid key = %d, want 200: %s", w.Code, w.Body.String())
	}

	// Revoke it: same request must now be rejected.
	if _, err := pool.Exec(context.Background(),
		`UPDATE environment_api_keys SET revoked_at = now()
		 WHERE environment_id IN (SELECT e.id FROM environments e JOIN projects p ON e.project_id = p.id WHERE p.org_id = $1)`,
		orgID); err != nil {
		t.Fatalf("revoke key: %v", err)
	}
	if w := doRequest(router, "GET", path, map[string]string{"X-API-Key": rawKey}); w.Code != http.StatusUnauthorized {
		t.Errorf("GET event-count with revoked key = %d, want 401", w.Code)
	}
}

func TestSDKAuth_CrossTenantProjectIsForbidden(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgA, _, _, keyA := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgA) })
	orgB, projectB, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgB) })

	// Tenant A's key must not read tenant B's project.
	w := doRequest(router, "GET", "/api/v1/projects/"+projectB+"/event-count",
		map[string]string{"X-API-Key": keyA})
	if w.Code != http.StatusForbidden {
		t.Errorf("cross-tenant event-count = %d, want 403: %s", w.Code, w.Body.String())
	}
}

func TestAuthenticateSession_RejectsMissingAndInvalidTokens(t *testing.T) {
	router, _, _ := authTestRouter(t)

	if w := doRequest(router, "GET", "/api/v1/projects", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("GET /projects without token = %d, want 401", w.Code)
	}
	w := doRequest(router, "GET", "/api/v1/projects", map[string]string{"Authorization": "Bearer not-a-jwt"})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("GET /projects with garbage token = %d, want 401", w.Code)
	}

	// A token signed with the wrong secret is rejected.
	forged, err := auth.SignAccessToken([]byte("some-other-secret"), "user-1", "org-1", "a@b.c")
	if err != nil {
		t.Fatalf("sign forged token: %v", err)
	}
	w = doRequest(router, "GET", "/api/v1/projects", map[string]string{"Authorization": "Bearer " + forged})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("GET /projects with wrong-secret token = %d, want 401", w.Code)
	}
}

func TestAuthenticateSession_ValidTokenAndOrgScope(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgA, projectA, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgA) })
	orgB, projectB, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgB) })

	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), "user-a", orgA, "a@example.com")
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	authz := map[string]string{"Authorization": "Bearer " + token}

	// Own-org project is accessible.
	if w := doRequest(router, "GET", "/api/v1/projects/"+projectA+"/event-count", authz); w.Code != http.StatusOK {
		t.Errorf("own-org event-count = %d, want 200: %s", w.Code, w.Body.String())
	}

	// Another org's project is forbidden even with a valid session.
	if w := doRequest(router, "GET", "/api/v1/projects/"+projectB+"/event-count", authz); w.Code != http.StatusForbidden {
		t.Errorf("cross-org event-count = %d, want 403: %s", w.Code, w.Body.String())
	}
}

// cleanupTenantHandler mirrors db_test.cleanupTenant for handler tests.
func cleanupTenantHandler(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	for _, q := range []string{
		`DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM environment_api_keys WHERE environment_id IN (SELECT e.id FROM environments e JOIN projects p ON e.project_id = p.id WHERE p.org_id = $1)`,
		`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM projects WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, q, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}
