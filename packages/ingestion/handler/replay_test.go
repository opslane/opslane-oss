package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// withProjectCtx is a helper that sets project_id in context for tests.
func withProjectCtx(ctx context.Context, projectID string) context.Context {
	return context.WithValue(ctx, ctxProjectID, projectID)
}

func TestReplayInit_MissingSessionID(t *testing.T) {
	deps := &Dependencies{}
	body := `{"trigger_type":"error"}`
	req := httptest.NewRequest("POST", "/api/v1/replays", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

	w := httptest.NewRecorder()
	deps.ReplayInit(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing session_id, got %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if !strings.Contains(resp["error"], "session_id") {
		t.Errorf("expected error message about session_id, got %q", resp["error"])
	}
}

func TestReplayInit_OversizedBody(t *testing.T) {
	deps := &Dependencies{}
	big := make([]byte, 1<<20+1) // 1MB + 1 byte
	req := httptest.NewRequest("POST", "/api/v1/replays", bytes.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

	w := httptest.NewRecorder()
	deps.ReplayInit(w, req)

	if w.Code != http.StatusRequestEntityTooLarge && w.Code != http.StatusBadRequest {
		t.Errorf("expected 413 or 400 for oversized body, got %d", w.Code)
	}
}

func TestReplayInit_MissingProjectContext(t *testing.T) {
	deps := &Dependencies{}
	body := `{"session_id":"sess-1"}`
	req := httptest.NewRequest("POST", "/api/v1/replays", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// No project context set

	w := httptest.NewRecorder()
	deps.ReplayInit(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing project context, got %d", w.Code)
	}
}

func TestGetReplay_MissingProjectAccessIsRejected(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("GET", "/api/v1/projects/p1/replays/r1", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("projectID", "p1")
	rctx.URLParams.Add("replayID", "r1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

	w := httptest.NewRecorder()
	deps.GetReplay(w, req)

	if w.Code == http.StatusOK {
		t.Errorf("expected non-200 when project access is not verified, got 200")
	}
}

func TestReplayComplete_MissingReplayID(t *testing.T) {
	// Without chi URL params, replayID is empty -> 400.
	deps := &Dependencies{}

	smallImg := base64.StdEncoding.EncodeToString([]byte("fakepng"))
	body := map[string]interface{}{
		"signals": map[string]string{"click": "button"},
		"artifacts": []map[string]interface{}{
			{"kind": "screenshot", "content_type": "image/png", "data_base64": smallImg, "width": 100, "height": 100},
		},
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/api/v1/replays//complete", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	ctx := withProjectCtx(req.Context(), "proj-123")
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	deps.ReplayComplete(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing replay ID, got %d", w.Code)
	}
}

func TestReplayComplete_InvalidContentType(t *testing.T) {
	// This test verifies the content_type validation logic.
	// Since the handler checks ownership first (requires DB), we test the
	// validation indirectly by checking the allowed content types map.
	allowed := map[string]bool{
		"image/webp": true,
		"image/png":  true,
		"image/jpeg": false,
		"text/plain": false,
		"":           false,
	}

	for ct, shouldAllow := range allowed {
		_, ok := allowedArtifactContentTypes[ct]
		if ok != shouldAllow {
			t.Errorf("content_type %q: expected allowed=%v, got %v", ct, shouldAllow, ok)
		}
	}
}

func TestReplayComplete_MissingProjectContext(t *testing.T) {
	deps := &Dependencies{}
	body := `{"signals":{},"artifacts":[]}`
	req := httptest.NewRequest("POST", "/api/v1/replays/replay-123/complete", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// No project context

	w := httptest.NewRecorder()
	deps.ReplayComplete(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing project context, got %d", w.Code)
	}
}

func TestReplayComplete_MissingReplayIDFromEmptyParam(t *testing.T) {
	// Without chi routing context, URLParam returns "" -> handler returns 400.
	deps := &Dependencies{}
	big := make([]byte, 5<<20+1) // 5MB + 1 byte
	req := httptest.NewRequest("POST", "/api/v1/replays/replay-123/complete", bytes.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

	w := httptest.NewRecorder()
	deps.ReplayComplete(w, req)

	// chi.URLParam returns "" without routing context -> 400 missing replay ID
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing replay ID (no chi context), got %d", w.Code)
	}
}
