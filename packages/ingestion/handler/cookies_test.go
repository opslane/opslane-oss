package handler_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

var testSecret = []byte("test-secret-at-least-32-bytes-long!!")

func findCookie(resp *http.Response, name string) *http.Cookie {
	for _, c := range resp.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestSetAuthCookies_AttributesAreHardened(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "https://app.opslane.com/x", nil)
	handler.SetAuthCookiesForTest(rec, req, "access-tok", "refresh-tok")

	resp := rec.Result()
	at := findCookie(resp, handler.AccessCookieName)
	rt := findCookie(resp, handler.RefreshCookieName)
	if at == nil || rt == nil {
		t.Fatal("expected both auth cookies to be set")
	}
	for _, c := range []*http.Cookie{at, rt} {
		if !c.HttpOnly {
			t.Errorf("%s must be HttpOnly", c.Name)
		}
		if !c.Secure {
			t.Errorf("%s must be Secure over TLS", c.Name)
		}
		if c.SameSite != http.SameSiteLaxMode {
			t.Errorf("%s must be SameSite=Lax", c.Name)
		}
	}
	if at.Value != "access-tok" || rt.Value != "refresh-tok" {
		t.Error("cookie values not set correctly")
	}
}

func TestAuthenticateSession_PrefersCookieThenBearer(t *testing.T) {
	deps := &handler.Dependencies{JWTSecret: testSecret}
	token, err := auth.SignAccessToken(testSecret, "user-1", "org-1", "u@example.com")
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	probe := deps.AuthenticateSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if handler.UserIDFromCtx(r.Context()) != "user-1" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: handler.AccessCookieName, Value: token})
	probe.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cookie auth should succeed, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	probe.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer auth should succeed, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	probe.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no creds should 401, got %d", rec.Code)
	}
}

func TestRefresh_CookieModeRotates(t *testing.T) {
	deps, _ := testDeps(t)
	deps.JWTSecret = testSecret

	ctx := context.Background()
	uniq := fmt.Sprintf("%d", time.Now().UnixNano())
	org, err := deps.Queries.CreateOrg(ctx, "cookie-refresh-org-"+uniq)
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	githubID := time.Now().UnixNano()
	user, err := deps.Queries.CreateUserGitHub(ctx, org.ID, "cookie+"+uniq+"@example.com", "Cookie User", githubID, "cookieuser-"+uniq, "")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}

	rawRefresh, hashRefresh, err := auth.GenerateRefreshToken()
	if err != nil {
		t.Fatalf("gen refresh: %v", err)
	}
	if err := deps.Queries.StoreRefreshToken(ctx, user.ID, hashRefresh, uuid.NewString(), user.OrgID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("store refresh: %v", err)
	}

	router := handler.NewRouterWithPool(deps, nil)
	srv := httptest.NewServer(router)
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: handler.RefreshCookieName, Value: rawRefresh})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("refresh request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if findCookie(resp, handler.AccessCookieName) == nil || findCookie(resp, handler.RefreshCookieName) == nil {
		t.Fatal("expected new auth cookies on refresh")
	}
}
