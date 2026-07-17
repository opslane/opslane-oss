package handler_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

type cliCloudProvider struct {
	identity auth.Identity
}

func (cliCloudProvider) Name() string { return "workos" }
func (cliCloudProvider) AuthorizeURL(request auth.AuthRequest) (string, error) {
	query := url.Values{"state": {request.State}, "redirect_uri": {request.RedirectURI}}
	return "https://auth.example/authorize?" + query.Encode(), nil
}
func (p cliCloudProvider) ExchangeCode(context.Context, string) (auth.Identity, error) {
	return p.identity, nil
}
func (cliCloudProvider) SupportsLocalPasswordForm() bool { return false }

func TestCloudCLILoginBridgesPKCEThroughProviderAndRejectsReplay(t *testing.T) {
	_, q, pool := authTestRouter(t)
	email := fmt.Sprintf("cli-cloud-%d@example.com", time.Now().UnixNano())
	provider := cliCloudProvider{identity: auth.Identity{
		Provider: "workos", ProviderSubject: "cli-" + email,
		Email: email, EmailVerified: true, Name: "CLI Cloud",
	}}
	router := handler.NewRouter(&handler.Dependencies{
		Queries: q, JWTSecret: []byte(authTestJWTSecret), AuthProvider: provider,
		AuthCallbackOrigin: "https://api.example",
	})
	verifier := "cli-verifier-that-is-long-enough-for-pkce-123456789"
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	redirectURI := "http://127.0.0.1:34567/callback"
	query := url.Values{
		"client_id": {"opslane-cli"}, "redirect_uri": {redirectURI},
		"state": {"cli-state"}, "code_challenge": {challenge},
		"code_challenge_method": {"S256"},
	}
	authorizeRequest := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil)
	authorizeResponse := httptest.NewRecorder()
	router.ServeHTTP(authorizeResponse, authorizeRequest)
	if authorizeResponse.Code != http.StatusFound {
		t.Fatalf("authorize status=%d body=%s", authorizeResponse.Code, authorizeResponse.Body.String())
	}
	if bytes.Contains(authorizeResponse.Body.Bytes(), []byte("<form")) {
		t.Fatal("cloud CLI flow rendered the local password form")
	}
	authorizeLocation, err := url.Parse(authorizeResponse.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	providerState := authorizeLocation.Query().Get("state")
	stateCookie := authCookie(t, authorizeResponse, "__auth_state")

	callbackPath := "/auth/callback?code=provider-code&state=" + url.QueryEscape(providerState)
	callbackRequest := httptest.NewRequest(http.MethodGet, callbackPath, nil)
	callbackRequest.AddCookie(stateCookie)
	callbackResponse := httptest.NewRecorder()
	router.ServeHTTP(callbackResponse, callbackRequest)
	if callbackResponse.Code != http.StatusFound {
		t.Fatalf("callback status=%d body=%s", callbackResponse.Code, callbackResponse.Body.String())
	}
	localRedirect, err := url.Parse(callbackResponse.Header().Get("Location"))
	if err != nil || localRedirect.Scheme != "http" || localRedirect.Host != "127.0.0.1:34567" {
		t.Fatalf("local redirect=%q err=%v", callbackResponse.Header().Get("Location"), err)
	}
	if localRedirect.Query().Get("state") != "cli-state" || localRedirect.Query().Get("code") == "" {
		t.Fatalf("local redirect query=%v", localRedirect.Query())
	}

	replayRequest := httptest.NewRequest(http.MethodGet, callbackPath, nil)
	replayRequest.AddCookie(stateCookie)
	replayResponse := httptest.NewRecorder()
	router.ServeHTTP(replayResponse, replayRequest)
	if replayResponse.Code != http.StatusForbidden {
		t.Fatalf("replayed callback status=%d body=%s", replayResponse.Code, replayResponse.Body.String())
	}

	tokenBody, _ := json.Marshal(map[string]string{
		"grant_type": "authorization_code", "client_id": "opslane-cli",
		"code": localRedirect.Query().Get("code"), "code_verifier": verifier,
		"redirect_uri": redirectURI,
	})
	tokenRequest := httptest.NewRequest(http.MethodPost, "/oauth/token", bytes.NewReader(tokenBody))
	tokenResponse := httptest.NewRecorder()
	router.ServeHTTP(tokenResponse, tokenRequest)
	if tokenResponse.Code != http.StatusOK {
		t.Fatalf("token status=%d body=%s", tokenResponse.Code, tokenResponse.Body.String())
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(tokenResponse.Body).Decode(&payload); err != nil || payload.AccessToken == "" {
		t.Fatalf("token payload=%+v err=%v", payload, err)
	}
	claims, err := auth.ValidateToken([]byte(authTestJWTSecret), payload.AccessToken)
	if err != nil || claims.Email != email {
		t.Fatalf("claims=%+v err=%v", claims, err)
	}
	user, err := q.GetUserByEmail(context.Background(), email)
	if err == nil && user != nil {
		t.Cleanup(func() { cleanupTenantHandler(t, pool, user.OrgID) })
	}
}
