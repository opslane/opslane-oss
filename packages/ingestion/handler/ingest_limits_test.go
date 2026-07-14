package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestRateLimitByProject_BlocksOverLimit(t *testing.T) {
	mw := handler.RateLimitByProjectForTest(2)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := mw(next)

	call := func() int {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		req = req.WithContext(handler.WithProjectIDForTest(req.Context(), "proj-1"))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if call() != http.StatusOK || call() != http.StatusOK {
		t.Fatal("first 2 requests should be allowed")
	}
	if got := call(); got != http.StatusTooManyRequests {
		t.Fatalf("3rd request should be 429, got %d", got)
	}
}

func TestRateLimitByProject_IsolatesProjects(t *testing.T) {
	mw := handler.RateLimitByProjectForTest(1)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := mw(next)

	call := func(project string) int {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		req = req.WithContext(handler.WithProjectIDForTest(req.Context(), project))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if call("a") != http.StatusOK || call("b") != http.StatusOK {
		t.Fatal("each project gets its own budget")
	}
	if call("a") != http.StatusTooManyRequests {
		t.Fatal("project a should be limited on its 2nd call")
	}
}

func TestEnforceOrigin_EmptyAllowlistAllowsAll(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOrigin(next)

	req := httptest.NewRequest("POST", "/api/v1/events", nil)
	req.Header.Set("Origin", "https://anything.example.com")
	req = req.WithContext(handler.WithAllowedOriginsForTest(req.Context(), nil))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty allowlist must allow all, got %d", rec.Code)
	}
}

func TestEnforceOrigin_RejectsNonAllowlistedOrigin(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOrigin(next)

	allowed := []string{"https://app.example.com"}

	mk := func(origin string) *http.Request {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return req.WithContext(handler.WithAllowedOriginsForTest(context.Background(), allowed))
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, mk("https://app.example.com"))
	if rec.Code != http.StatusOK {
		t.Fatalf("allowlisted origin must pass, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, mk("https://evil.com"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-allowlisted origin must be 403, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, mk(""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("missing origin with allowlist must be 403, got %d", rec.Code)
	}
}

func TestEnforceOrigin_MatchIsCaseInsensitive(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOrigin(next)

	// Allowlist entry with mixed-case host must still match a lowercase browser Origin.
	allowed := []string{"https://App.Example.com"}
	req := httptest.NewRequest("POST", "/api/v1/events", nil)
	req.Header.Set("Origin", "https://app.example.com")
	req = req.WithContext(handler.WithAllowedOriginsForTest(context.Background(), allowed))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("case-insensitive origin must pass, got %d", rec.Code)
	}
}
