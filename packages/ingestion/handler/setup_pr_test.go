package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSetupPR_RequiresProjectAccess(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("POST", "/api/v1/projects/p1/setup-pr", nil)
	req = req.WithContext(newChiRouteContext(map[string]string{"projectID": "p1"}))
	w := httptest.NewRecorder()

	deps.SetupPR(w, req)

	if w.Code == http.StatusOK || w.Code == http.StatusAccepted {
		t.Fatalf("expected rejection without project access, got %d", w.Code)
	}
}
