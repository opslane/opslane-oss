package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

type recordingProvider struct {
	authorizeCalls int
	lastReq        auth.AuthRequest
}

func (*recordingProvider) Name() string { return "workos" }
func (provider *recordingProvider) AuthorizeURL(req auth.AuthRequest) (string, error) {
	provider.authorizeCalls++
	provider.lastReq = req
	return "https://auth.example/authorize?provider=" + string(req.SocialProvider), nil
}
func (*recordingProvider) ExchangeCode(context.Context, string) (auth.Identity, error) {
	return auth.Identity{}, nil
}
func (*recordingProvider) SupportsLocalPasswordForm() bool { return false }

type oauthStateStoreSpy struct{ calls int }

func (store *oauthStateStoreSpy) StoreOAuthLoginState(context.Context, string, time.Time) error {
	store.calls++
	return nil
}

func newLoginDeps(provider auth.AuthProvider, cfg auth.SocialProviderConfig, store *oauthStateStoreSpy) *Dependencies {
	return &Dependencies{
		AuthProvider:       provider,
		SocialProviders:    cfg,
		oauthStateStore:    store,
		JWTSecret:          []byte("test-secret-at-least-32-bytes-long!!"),
		AuthCallbackOrigin: "https://app.example",
	}
}

func TestOAuthLoginPassesSocialProviderThrough(t *testing.T) {
	cfg, err := auth.ParseSocialProviders("google,github")
	if err != nil {
		t.Fatal(err)
	}
	provider := &recordingProvider{}
	store := &oauthStateStoreSpy{}
	recorder := httptest.NewRecorder()
	newLoginDeps(provider, cfg, store).OAuthLoginStart(
		recorder,
		httptest.NewRequest(http.MethodGet, "/auth/login?provider=google", nil),
	)

	if recorder.Code != http.StatusFound {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if provider.lastReq.SocialProvider != auth.SocialProviderGoogle {
		t.Fatalf("provider received SocialProvider=%q, want google", provider.lastReq.SocialProvider)
	}
	if store.calls != 1 {
		t.Fatalf("want exactly one StoreOAuthLoginState call, got %d", store.calls)
	}
}

func TestOAuthLoginBareUsesEmptyProvider(t *testing.T) {
	cfg, err := auth.ParseSocialProviders("google")
	if err != nil {
		t.Fatal(err)
	}
	provider := &recordingProvider{}
	recorder := httptest.NewRecorder()
	newLoginDeps(provider, cfg, &oauthStateStoreSpy{}).OAuthLoginStart(
		recorder,
		httptest.NewRequest(http.MethodGet, "/auth/login", nil),
	)
	if recorder.Code != http.StatusFound || provider.lastReq.SocialProvider != "" {
		t.Fatalf("bare login status=%d social=%q (want 302, empty)", recorder.Code, provider.lastReq.SocialProvider)
	}
}

func TestOAuthLoginRejectsWithoutSideEffects(t *testing.T) {
	cfg, err := auth.ParseSocialProviders("google")
	if err != nil {
		t.Fatal(err)
	}
	provider := &recordingProvider{}
	store := &oauthStateStoreSpy{}
	deps := newLoginDeps(provider, cfg, store)

	for _, target := range []string{
		"/auth/login?provider=github",
		"/auth/login?provider=evil",
		"/auth/login?provider=",
		"/auth/login?provider=google&provider=github",
	} {
		recorder := httptest.NewRecorder()
		deps.OAuthLoginStart(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d, want 400", target, recorder.Code)
		}
		if recorder.Header().Get("Location") != "" || recorder.Header().Get("Set-Cookie") != "" {
			t.Fatalf("%s produced a Location/cookie side effect", target)
		}
	}
	if store.calls != 0 || provider.authorizeCalls != 0 {
		t.Fatalf("rejections must not store state (%d) or call the provider (%d)", store.calls, provider.authorizeCalls)
	}
}

func TestValidOAuthState(t *testing.T) {
	if validOAuthState("", "x") {
		t.Error("empty cookie must fail")
	}
	if validOAuthState("a", "b") {
		t.Error("mismatch must fail")
	}
	if !validOAuthState("same", "same") {
		t.Error("match must pass")
	}
}

func TestOAuthLoginCallbackDispatchesAgentUUIDState(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	session, _ := createCallbackSession(t, q, "dispatch-owner/dispatch-"+fmt.Sprint(time.Now().UnixNano()))
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM agent_sessions WHERE id = $1`, session.ID) })

	req := httptest.NewRequest(http.MethodGet,
		"/auth/callback?state="+session.ID+"&installation_id=1", nil)
	w := httptest.NewRecorder()
	(&Dependencies{Queries: q}).OAuthLoginCallback(w, req)
	if w.Code == http.StatusForbidden || strings.Contains(w.Body.String(), "invalid OAuth state") {
		t.Fatalf("request followed web OAuth branch: code=%d body=%q", w.Code, w.Body.String())
	}
}

func TestApplyCombinedGitHubInstallationBindsAuthenticatedUser(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "web-binding-"+fmt.Sprint(time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_login_states WHERE target_org_id = $1`, org.ID)
		cleanupGitHubOAuthOrg(t, pool, org.ID)
	})
	installationID := time.Now().UnixNano()%1_000_000_000 + 4_000_000_000
	visible := true
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case fmt.Sprintf("/app/installations/%d", installationID):
			fmt.Fprintf(w, `{"id":%d,"account":{"login":"web-owner","id":1}}`, installationID)
		case "/user/installations":
			if visible {
				fmt.Fprintf(w, `{"installations":[{"id":%d}]}`, installationID)
			} else {
				fmt.Fprint(w, `{"installations":[]}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	restore := gh.OverrideHTTPClientForTests(&http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "http"
		req.URL.Host = ts.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(req)
	})})
	defer restore()

	deps := &Dependencies{Queries: q, GitHubAppID: "1", GitHubAppPrivateKey: callbackTestKey(t)}
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
		"/auth/callback?setup_action=install&installation_id=%d", installationID), nil)
	identity := auth.Identity{AccessToken: "ghu_web"}
	if err := deps.applyCombinedGitHubInstallation(req, &db.User{OrgID: org.ID}, identity, ""); err != nil {
		t.Fatalf("bound install: %v", err)
	}
	got, err := q.GetOrgGitHubInstallation(ctx, org.ID)
	if err != nil || got != installationID {
		t.Fatalf("stored installation=%d err=%v", got, err)
	}

	visible = false
	if err := deps.applyCombinedGitHubInstallation(req, &db.User{OrgID: org.ID}, identity, ""); err == nil {
		t.Fatal("expected installation ownership mismatch")
	}
}

func TestGetGitHubAppStatusUsesSharedOAuthState(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	org, err := q.CreateOrg(context.Background(), "wizard-state-"+fmt.Sprint(time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_login_states WHERE target_org_id = $1`, org.ID)
		cleanupGitHubOAuthOrg(t, pool, org.ID)
	})

	deps := &Dependencies{Queries: q, GitHubAppSlug: "opslane", JWTSecret: []byte("secret")}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)
	req = req.WithContext(context.WithValue(req.Context(), ctxOrgID, org.ID))
	w := httptest.NewRecorder()
	deps.GetGitHubAppStatus(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
	var body struct {
		InstallURL string `json:"install_url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.InstallURL == "" {
		t.Fatal("missing install URL")
	}
	found := false
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == "__auth_state" {
			found = true
			if cookie.Path != "/auth" {
				t.Fatalf("cookie path=%q", cookie.Path)
			}
		}
		if cookie.Name == "__github_state" {
			t.Fatal("legacy __github_state cookie still emitted")
		}
	}
	if !found {
		t.Fatal("missing __auth_state cookie")
	}
}

func TestSetupWizardSharedCallbackPreservesActiveOrg(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	homeOrg, err := q.CreateOrg(ctx, "wizard-home-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	activeOrg, err := q.CreateOrg(ctx, "wizard-active-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	githubID := time.Now().UnixNano()
	email := "wizard-" + suffix + "@example.com"
	user, err := q.CreateUserGitHub(ctx, homeOrg.ID, email, "Wizard User", githubID, "wizard-user", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.UpsertIdentityDetails(ctx, user.ID, "github", strconv.FormatInt(githubID, 10), email, true); err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, activeOrg.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM oauth_login_states WHERE target_org_id = $1`, activeOrg.ID)
		cleanupGitHubOAuthOrg(t, pool, homeOrg.ID)
		cleanupGitHubOAuthOrg(t, pool, activeOrg.ID)
	})

	installationID := time.Now().UnixNano()%1_000_000_000 + 5_000_000_000
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/login/oauth/access_token":
			fmt.Fprint(w, `{"access_token":"ghu_wizard","token_type":"bearer"}`)
		case "/user":
			fmt.Fprintf(w, `{"id":%d,"login":"wizard-user","name":"Wizard User"}`, githubID)
		case "/user/emails":
			fmt.Fprintf(w, `[{"email":%q,"primary":true,"verified":true}]`, email)
		case "/user/installations":
			fmt.Fprintf(w, `{"installations":[{"id":%d}]}`, installationID)
		case fmt.Sprintf("/app/installations/%d", installationID):
			fmt.Fprintf(w, `{"id":%d,"account":{"login":"wizard-org","id":1}}`, installationID)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	restore := gh.OverrideHTTPClientForTests(&http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "http"
		req.URL.Host = ts.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(req)
	})})
	defer restore()

	deps := &Dependencies{
		Queries: q, JWTSecret: []byte("wizard-secret"), GitHubAppSlug: "opslane",
		GitHubAppID: "1", GitHubAppClientID: "cid", GitHubAppClientSecret: "sec",
		GitHubAppPrivateKey: callbackTestKey(t), DashboardOrigin: "https://app.example",
	}
	statusReq := httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)
	statusReq = statusReq.WithContext(context.WithValue(statusReq.Context(), ctxOrgID, activeOrg.ID))
	statusW := httptest.NewRecorder()
	deps.GetGitHubAppStatus(statusW, statusReq)
	if statusW.Code != http.StatusOK {
		t.Fatalf("status code=%d body=%q", statusW.Code, statusW.Body.String())
	}
	var statusBody struct {
		InstallURL string `json:"install_url"`
	}
	if err := json.Unmarshal(statusW.Body.Bytes(), &statusBody); err != nil {
		t.Fatal(err)
	}
	installURL, err := url.Parse(statusBody.InstallURL)
	if err != nil {
		t.Fatal(err)
	}
	state := installURL.Query().Get("state")
	var stateCookie *http.Cookie
	for _, cookie := range statusW.Result().Cookies() {
		if cookie.Name == "__auth_state" {
			stateCookie = cookie
		}
	}
	if state == "" || stateCookie == nil {
		t.Fatalf("missing state or cookie: url=%q cookies=%v", statusBody.InstallURL, statusW.Result().Cookies())
	}

	callbackReq := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
		"/auth/callback?code=x&state=%s&setup_action=install&installation_id=%d", state, installationID), nil)
	callbackReq.AddCookie(stateCookie)
	callbackW := httptest.NewRecorder()
	deps.OAuthLoginCallback(callbackW, callbackReq)
	if callbackW.Code != http.StatusFound {
		t.Fatalf("callback code=%d body=%q", callbackW.Code, callbackW.Body.String())
	}
	var accessCookie, refreshCookie *http.Cookie
	for _, cookie := range callbackW.Result().Cookies() {
		switch cookie.Name {
		case AccessCookieName:
			accessCookie = cookie
		case RefreshCookieName:
			refreshCookie = cookie
		}
	}
	if accessCookie == nil || refreshCookie == nil {
		t.Fatalf("missing auth cookies: %v", callbackW.Result().Cookies())
	}
	claims, err := auth.ValidateToken(deps.JWTSecret, accessCookie.Value)
	if err != nil || claims.OrgID != activeOrg.ID {
		t.Fatalf("access claims=%+v err=%v, want active org %s", claims, err, activeOrg.ID)
	}
	var refreshOrgID string
	if err := pool.QueryRow(ctx,
		`SELECT org_id FROM refresh_tokens WHERE token_hash = $1`, auth.HashToken(refreshCookie.Value)).Scan(&refreshOrgID); err != nil {
		t.Fatal(err)
	}
	if refreshOrgID != activeOrg.ID {
		t.Fatalf("refresh org=%s, want active org %s", refreshOrgID, activeOrg.ID)
	}
	activeInstallation, err := q.GetOrgGitHubInstallation(ctx, activeOrg.ID)
	if err != nil {
		t.Fatal(err)
	}
	homeInstallation, err := q.GetOrgGitHubInstallation(ctx, homeOrg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if activeInstallation != installationID || homeInstallation != 0 {
		t.Fatalf("active/home installations=%d/%d, want %d/0", activeInstallation, homeInstallation, installationID)
	}
}

func githubOAuthTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func cleanupGitHubOAuthOrg(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	for _, query := range []string{
		`DELETE FROM org_invitations WHERE org_id = $1 OR invited_by IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM users WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, query, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}

func TestGitHubProvisioningResolvesIdentityFirstAndWritesFreshIdentity(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "github-identity-first")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	userA, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("github-a-%d@example.com", time.Now().UnixNano()), "A", time.Now().UnixNano(), "a", "")
	if err != nil {
		t.Fatal(err)
	}
	legacyID := time.Now().UnixNano()
	if _, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("github-b-%d@example.com", time.Now().UnixNano()), "B", legacyID, "b", ""); err != nil {
		t.Fatal(err)
	}
	subject := strconv.FormatInt(legacyID, 10)
	if err := q.UpsertIdentity(ctx, userA.ID, "github", subject); err != nil {
		t.Fatal(err)
	}
	deps := &Dependencies{Queries: q}
	request := httptest.NewRequest("GET", "/auth/callback", nil)
	resolved, err := deps.provisionGitHubIdentity(request, auth.Identity{
		Provider: "github", ProviderSubject: subject, Email: userA.Email,
		EmailVerified: true, Name: "A", Username: "identity-first",
	})
	if err != nil || resolved.ID != userA.ID {
		t.Fatalf("resolved user=%+v err=%v, want %s", resolved, err, userA.ID)
	}

	freshID := time.Now().UnixNano()
	freshEmail := fmt.Sprintf("github-fresh-%d@example.com", freshID)
	fresh, err := deps.provisionGitHubIdentity(request, auth.Identity{
		Provider: "github", ProviderSubject: strconv.FormatInt(freshID, 10), Email: freshEmail,
		EmailVerified: true, Name: "Fresh", Username: "fresh",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, fresh.OrgID) })
	gotUserID, err := q.GetUserIDByIdentity(ctx, "github", strconv.FormatInt(freshID, 10))
	if err != nil || gotUserID != fresh.ID {
		t.Fatalf("fresh identity user=%q err=%v, want %s", gotUserID, err, fresh.ID)
	}
}
