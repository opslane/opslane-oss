package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestAdminRoutesFailClosedAndAuthMeSignalsAllowlist(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	uniq := fmt.Sprint(time.Now().UnixNano())
	org, err := q.CreateOrg(ctx, "admin-auth-"+uniq)
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	user, err := q.CreateUserGitHub(ctx, org.ID, "admin+"+uniq+"@example.com", "Admin", time.Now().UnixNano(), "admin-"+uniq, "")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, user.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, org.ID)
	})

	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, org.ID, user.Email)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	authz := map[string]string{"Authorization": "Bearer " + token}

	adminDeps := &handler.Dependencies{
		Queries:     db.New(pool),
		JWTSecret:   []byte(authTestJWTSecret),
		AdminEmails: handler.ParseAdminEmails(strings.ToUpper(user.Email)),
	}
	adminRouter := handler.NewRouter(adminDeps)
	if w := doRequest(adminRouter, http.MethodGet, "/api/v1/admin/overview", authz); w.Code != http.StatusOK {
		t.Fatalf("admin overview = %d, want 200: %s", w.Code, w.Body.String())
	}
	me := doRequest(adminRouter, http.MethodGet, "/api/v1/auth/me", authz)
	if me.Code != http.StatusOK {
		t.Fatalf("auth me = %d, want 200: %s", me.Code, me.Body.String())
	}
	var meBody map[string]any
	if err := json.Unmarshal(me.Body.Bytes(), &meBody); err != nil {
		t.Fatalf("decode auth me: %v", err)
	}
	if meBody["is_admin"] != true {
		t.Fatalf("auth me is_admin = %v, want true", meBody["is_admin"])
	}

	nonAdminDeps := &handler.Dependencies{
		Queries:     db.New(pool),
		JWTSecret:   []byte(authTestJWTSecret),
		AdminEmails: handler.ParseAdminEmails("someone-else@example.com"),
	}
	if w := doRequest(handler.NewRouter(nonAdminDeps), http.MethodGet, "/api/v1/admin/overview", authz); w.Code != http.StatusNotFound {
		t.Fatalf("non-admin overview = %d, want 404: %s", w.Code, w.Body.String())
	}

	disabledDeps := &handler.Dependencies{Queries: db.New(pool), JWTSecret: []byte(authTestJWTSecret)}
	if w := doRequest(handler.NewRouter(disabledDeps), http.MethodGet, "/api/v1/admin/jobs", authz); w.Code != http.StatusNotFound {
		t.Fatalf("disabled admin jobs = %d, want 404: %s", w.Code, w.Body.String())
	}
}
