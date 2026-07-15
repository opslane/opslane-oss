package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestIncidentJSON_ReplayID(t *testing.T) {
	id := "11111111-2222-3333-4444-555555555555"
	inc := incidentJSON{ID: "g1", ReplayID: &id}
	b, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"replay_id":"`+id+`"`) {
		t.Errorf("expected replay_id in JSON, got %s", string(b))
	}

	inc2 := incidentJSON{ID: "g2"}
	b2, _ := json.Marshal(inc2)
	if strings.Contains(string(b2), "replay_id") {
		t.Errorf("expected replay_id omitted when nil, got %s", string(b2))
	}
}

func TestIncidentJSONIncludesKind(t *testing.T) {
	inc := toIncidentJSON(db.ErrorGroup{Kind: "friction"})
	b, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"kind":"friction"`) {
		t.Errorf("expected friction kind in JSON, got %s", string(b))
	}
}

func TestIncidentJSON_SessionPointer(t *testing.T) {
	inc := incidentJSON{
		ID: "g1",
		SessionPointer: &sessionPointerJSON{
			SessionID: "sess_12345678",
			ErrorAt:   "2026-07-15T10:00:00Z",
		},
	}
	body, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"session_pointer":{"session_id":"sess_12345678","error_at":"2026-07-15T10:00:00Z"}`) {
		t.Fatalf("session pointer missing from %s", body)
	}

	without, err := json.Marshal(incidentJSON{ID: "g2"})
	if err != nil {
		t.Fatalf("marshal without pointer: %v", err)
	}
	if strings.Contains(string(without), "session_pointer") {
		t.Fatalf("nil session pointer was not omitted: %s", without)
	}
}
