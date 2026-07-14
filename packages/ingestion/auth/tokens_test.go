package auth

import "testing"

func TestGenerateRefreshTokenRoundTrip(t *testing.T) {
	raw, hash, err := GenerateRefreshToken()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	if len(raw) != 64 {
		t.Errorf("raw token length = %d, want 64 hex chars (32 bytes)", len(raw))
	}

	if HashToken(raw) != hash {
		t.Error("HashToken(raw) does not match returned hash")
	}
}

func TestGenerateRefreshTokenUniqueness(t *testing.T) {
	raw1, _, err := GenerateRefreshToken()
	if err != nil {
		t.Fatalf("generate 1: %v", err)
	}
	raw2, _, err := GenerateRefreshToken()
	if err != nil {
		t.Fatalf("generate 2: %v", err)
	}

	if raw1 == raw2 {
		t.Fatal("expected unique tokens")
	}
}
