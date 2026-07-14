package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestVerifyPKCERoundTrip(t *testing.T) {
	// Simulate what the CLI does: generate a verifier, compute the challenge
	codeVerifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	h := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(h[:])

	if !VerifyPKCE(codeVerifier, codeChallenge) {
		t.Fatal("expected PKCE verification to pass")
	}
}

func TestVerifyPKCEWrongVerifier(t *testing.T) {
	codeVerifier := "correct-verifier-value-here-12345678901234567"
	h := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(h[:])

	if VerifyPKCE("wrong-verifier-value-here-12345678901234567", codeChallenge) {
		t.Fatal("expected PKCE verification to fail with wrong verifier")
	}
}

func TestGenerateAuthCodeUniqueness(t *testing.T) {
	raw1, hash1, err := GenerateAuthCode()
	if err != nil {
		t.Fatalf("generate 1: %v", err)
	}
	raw2, hash2, err := GenerateAuthCode()
	if err != nil {
		t.Fatalf("generate 2: %v", err)
	}

	if raw1 == raw2 {
		t.Fatal("expected unique raw codes")
	}
	if hash1 == hash2 {
		t.Fatal("expected unique hashes")
	}
}
