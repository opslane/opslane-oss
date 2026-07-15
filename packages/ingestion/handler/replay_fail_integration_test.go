package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestReplayFail_MarksPendingReplayFailed(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, _, apiKey := seedTenant(t, deps.Queries)
	replayID := uuid.NewString()
	if err := deps.Queries.InsertReplay(context.Background(), replayID, projectID, nil, nil,
		"sess_replay_fail", "error", "", "", "", "replays/test/recording.json"); err != nil {
		t.Fatalf("insert replay: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/replays/"+replayID+"/fail",
		strings.NewReader(`{"reason":"storage upload failed"}`))
	req.Header.Set("X-API-Key", apiKey)
	w := httptest.NewRecorder()
	handler.NewRouterWithPool(deps, pool).ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("replay fail returned %d: %s", w.Code, w.Body.String())
	}

	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM session_replays WHERE id=$1 AND project_id=$2`, replayID, projectID,
	).Scan(&status); err != nil {
		t.Fatalf("read replay: %v", err)
	}
	if status != "failed" {
		t.Fatalf("replay status = %q, want failed", status)
	}
}
