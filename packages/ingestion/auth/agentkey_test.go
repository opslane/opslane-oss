package auth

import (
	"strings"
	"testing"
)

func TestAgentKeyRoundTrip(t *testing.T) {
	raw, hash, pub, err := NewAgentPollToken()
	if err != nil {
		t.Fatalf("NewAgentPollToken: %v", err)
	}
	if !strings.HasPrefix(raw, "opt_") || len(raw) != 4+64 {
		t.Errorf("token format: %q", raw)
	}
	if hash != HashToken(raw) {
		t.Errorf("hash mismatch")
	}

	sealed, err := SealAgentKey(pub, "session-123", "def_secret-key")
	if err != nil {
		t.Fatalf("SealAgentKey: %v", err)
	}
	opened, err := OpenAgentKey(raw, "session-123", sealed)
	if err != nil {
		t.Fatalf("OpenAgentKey: %v", err)
	}
	if opened != "def_secret-key" {
		t.Errorf("opened = %q", opened)
	}
}

func TestAgentKeyWrongTokenFails(t *testing.T) {
	_, _, pub, _ := NewAgentPollToken()
	other, _, _, _ := NewAgentPollToken()
	sealed, _ := SealAgentKey(pub, "s", "def_k")
	if _, err := OpenAgentKey(other, "s", sealed); err == nil {
		t.Error("expected open with wrong token to fail")
	}
}

func TestAgentKeyWrongSessionFails(t *testing.T) {
	raw, _, pub, _ := NewAgentPollToken()
	sealed, _ := SealAgentKey(pub, "session-A", "def_k")
	if _, err := OpenAgentKey(raw, "session-B", sealed); err == nil {
		t.Error("expected open with wrong session AAD to fail")
	}
}
