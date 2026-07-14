package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// newChiRouteContext builds a context with chi URL params for testing.
func newChiRouteContext(params map[string]string) context.Context {
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	return context.WithValue(context.Background(), chi.RouteCtxKey, rctx)
}

func TestAgentSetup_MissingRepoURL(t *testing.T) {
	deps := &Dependencies{}
	body, _ := json.Marshal(map[string]string{})
	req := httptest.NewRequest("POST", "/api/v1/agent/setup", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	deps.AgentSetup(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing repo_url, got %d", w.Code)
	}
}

func TestAgentSetup_InvalidRepoFormat(t *testing.T) {
	deps := &Dependencies{}
	body, _ := json.Marshal(map[string]string{"repo_url": "not-a-repo"})
	req := httptest.NewRequest("POST", "/api/v1/agent/setup", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	deps.AgentSetup(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid repo format, got %d", w.Code)
	}
}

func TestAgentSetup_ValidRepoFormat(t *testing.T) {
	// Valid owner/repo patterns that should pass validation
	validRepos := []string{
		"acme/my-app",
		"user123/repo.name",
		"org/repo_name",
		"a/b",
	}
	for _, repo := range validRepos {
		if !repoURLPattern.MatchString(repo) {
			t.Errorf("expected %q to be valid owner/repo format", repo)
		}
	}

	// Invalid patterns
	invalidRepos := []string{
		"not-a-repo",
		"",
		"a/b/c",
		"/repo",
		"owner/",
	}
	for _, repo := range invalidRepos {
		if repoURLPattern.MatchString(repo) {
			t.Errorf("expected %q to be invalid owner/repo format", repo)
		}
	}
}

func TestAgentSetup_OversizedBody(t *testing.T) {
	deps := &Dependencies{}
	big := make([]byte, 1<<16+1) // 64KB + 1
	req := httptest.NewRequest("POST", "/api/v1/agent/setup", bytes.NewReader(big))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	deps.AgentSetup(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for oversized body, got %d", w.Code)
	}
}

func TestAgentPoll_InvalidSessionID(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("GET", "/api/v1/agent/poll/not-a-uuid", nil)

	// Need chi context for URL params
	rctx := newChiRouteContext(map[string]string{"sessionID": "not-a-uuid"})
	req = req.WithContext(rctx)

	w := httptest.NewRecorder()
	deps.AgentPoll(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid session ID, got %d", w.Code)
	}
}

func TestAgentPoll_MissingSessionID(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("GET", "/api/v1/agent/poll/", nil)

	// Empty chi context
	rctx := newChiRouteContext(map[string]string{})
	req = req.WithContext(rctx)

	w := httptest.NewRecorder()
	deps.AgentPoll(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing session ID, got %d", w.Code)
	}
}

func TestAgentAuthRedirect_MissingGitHubAppSlug(t *testing.T) {
	deps := &Dependencies{GitHubAppSlug: ""}
	req := httptest.NewRequest("GET", "/agent/auth/00000000-0000-0000-0000-000000000001", nil)

	rctx := newChiRouteContext(map[string]string{"sessionID": "00000000-0000-0000-0000-000000000001"})
	req = req.WithContext(rctx)

	w := httptest.NewRecorder()
	deps.AgentAuthRedirect(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 for missing GitHub App config, got %d", w.Code)
	}
}

func TestAgentAuthRedirect_InvalidSessionID(t *testing.T) {
	deps := &Dependencies{GitHubAppSlug: "opslane"}
	req := httptest.NewRequest("GET", "/agent/auth/bad-uuid", nil)

	rctx := newChiRouteContext(map[string]string{"sessionID": "bad-uuid"})
	req = req.WithContext(rctx)

	w := httptest.NewRecorder()
	deps.AgentAuthRedirect(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid session ID, got %d", w.Code)
	}
}

func TestAgentAuthCallback_MissingParams(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("GET", "/agent/auth/callback", nil)

	w := httptest.NewRecorder()
	deps.AgentAuthCallback(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing params, got %d", w.Code)
	}
}

func TestAgentAuthCallback_InvalidSessionID(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("GET", "/agent/auth/callback?state=bad-uuid&installation_id=123", nil)

	w := httptest.NewRecorder()
	deps.AgentAuthCallback(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid session ID, got %d", w.Code)
	}
}
