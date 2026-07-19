package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
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
