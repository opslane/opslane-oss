package handler

import (
	"encoding/json"
	"strings"
	"testing"
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
