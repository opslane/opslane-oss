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

func TestToIncidentJSON_Platform(t *testing.T) {
	platform := "python"
	inc := toIncidentJSON(db.ErrorGroup{Platform: &platform})
	if inc.Platform == nil || *inc.Platform != "python" {
		t.Fatalf("platform = %v, want python", inc.Platform)
	}
	if got := toIncidentJSON(db.ErrorGroup{}); got.Platform != nil {
		t.Fatalf("friction incident platform should marshal as absent, got %v", got.Platform)
	}
}

func TestIncidentJSON_IncludesVerificationEvidenceAndCandidateDiff(t *testing.T) {
	diff := "diff --git a/src/a.ts b/src/a.ts"
	inc := toIncidentJSON(db.ErrorGroup{
		VerificationEvidence: []byte(`{"version":1,"tier":"E0","checks":[]}`),
		CandidateDiff:        &diff,
	})
	body, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	evidence, ok := got["verification_evidence"].(map[string]any)
	if !ok || evidence["tier"] != "E0" {
		t.Fatalf("verification_evidence = %#v, want tier E0", got["verification_evidence"])
	}
	if got["candidate_diff"] != diff {
		t.Fatalf("candidate_diff = %#v, want %q", got["candidate_diff"], diff)
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

func TestIncidentJSON_AdjudicationFields(t *testing.T) {
	envID := "env-123"
	status := "unchecked"
	inc := toIncidentJSON(db.ErrorGroup{
		Kind:               "friction",
		EnvironmentID:      &envID,
		AdjudicationStatus: &status,
	})
	data, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"environment_id":"env-123"`) {
		t.Errorf("expected environment_id in %s", data)
	}
	if !strings.Contains(string(data), `"adjudication_status":"unchecked"`) {
		t.Errorf("expected adjudication_status in %s", data)
	}
}

func TestIncidentJSON_AdjudicationFieldsOmittedForErrors(t *testing.T) {
	inc := toIncidentJSON(db.ErrorGroup{Kind: "error"})
	data, err := json.Marshal(inc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), "environment_id") ||
		strings.Contains(string(data), "adjudication_status") {
		t.Errorf("error incidents must omit adjudication fields, got %s", data)
	}
}
