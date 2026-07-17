package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

type callbackStubProvider struct {
	name       string
	authorized auth.AuthRequest
}

func (p *callbackStubProvider) Name() string { return p.name }
func (p *callbackStubProvider) AuthorizeURL(request auth.AuthRequest) (string, error) {
	p.authorized = request
	return "https://identity.example/authorize?state=" + request.State, nil
}
func (p *callbackStubProvider) ExchangeCode(context.Context, string) (auth.Identity, error) {
	return auth.Identity{}, nil
}
func (p *callbackStubProvider) SupportsLocalPasswordForm() bool { return p.name != "workos" }

func TestOAuthLoginUsesConfiguredCallbackOriginAndAuthCookiePath(t *testing.T) {
	provider := &callbackStubProvider{name: "github"}
	deps := &Dependencies{
		JWTSecret:          []byte("callback-test-secret-at-least-32-bytes"),
		AuthProvider:       provider,
		AuthCallbackOrigin: "https://api.opslane.example",
	}
	request := httptest.NewRequest(http.MethodGet, "http://attacker.example/auth/login", nil)
	recorder := httptest.NewRecorder()
	deps.OAuthLoginStart(recorder, request)
	if recorder.Code != http.StatusFound {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if provider.authorized.RedirectURI != "https://api.opslane.example/auth/callback" {
		t.Fatalf("redirect URI=%q", provider.authorized.RedirectURI)
	}
	if strings.Contains(provider.authorized.RedirectURI, "attacker.example") {
		t.Fatal("callback origin trusted request Host")
	}
	if cookie := recorder.Header().Get("Set-Cookie"); !strings.Contains(cookie, "Path=/auth") {
		t.Fatalf("state cookie path not scoped to /auth: %s", cookie)
	}
}

func TestOAuthCallbackHandlesProviderDenial(t *testing.T) {
	deps := &Dependencies{AuthProvider: &callbackStubProvider{name: "workos"}}
	request := httptest.NewRequest(http.MethodGet, "/auth/callback?error=access_denied", nil)
	recorder := httptest.NewRecorder()
	deps.OAuthLoginCallback(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "access_denied") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestGitHubCompatibilityRouteRedirectsToLogin(t *testing.T) {
	provider := &callbackStubProvider{name: "github"}
	deps := &Dependencies{
		JWTSecret: []byte("callback-test-secret-at-least-32-bytes"), AuthProvider: provider,
		AuthCallbackOrigin: "https://api.example",
	}
	router := NewRouter(deps)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/auth/github", nil))
	if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != "/auth/login" {
		t.Fatalf("status=%d location=%q", recorder.Code, recorder.Header().Get("Location"))
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/auth/login", nil))
	if recorder.Code != http.StatusFound || !strings.HasPrefix(recorder.Header().Get("Location"), "https://identity.example/") {
		t.Fatalf("login status=%d location=%q", recorder.Code, recorder.Header().Get("Location"))
	}

	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/auth/github/callback?error=access_denied", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("callback alias status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
