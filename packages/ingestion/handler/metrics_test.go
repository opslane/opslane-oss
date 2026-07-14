package handler

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecordStacklessAccepted_AppearsInMetrics(t *testing.T) {
	RecordStacklessAccepted()

	req := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()
	Metrics(w, req)

	body := w.Body.String()
	if !strings.Contains(body, "opslane_stackless_events_total") {
		t.Errorf("expected opslane_stackless_events_total in /metrics output, got:\n%s", body)
	}
}
