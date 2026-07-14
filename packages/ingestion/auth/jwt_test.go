package auth

import (
	"strings"
	"testing"
	"time"
)

var testSecret = []byte("test-secret-key-that-is-at-least-32-bytes-long!")

func TestSignAndValidateRoundTrip(t *testing.T) {
	token, err := SignAccessToken(testSecret, "user-1", "org-1", "user@test.com")
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	claims, err := ValidateToken(testSecret, token)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}

	if claims.Sub != "user-1" {
		t.Errorf("sub = %q, want user-1", claims.Sub)
	}
	if claims.OrgID != "org-1" {
		t.Errorf("org_id = %q, want org-1", claims.OrgID)
	}
	if claims.Email != "user@test.com" {
		t.Errorf("email = %q, want user@test.com", claims.Email)
	}
}

func TestExpiredTokenRejected(t *testing.T) {
	token, err := SignAccessTokenWithTTL(testSecret, "user-1", "org-1", "user@test.com", -1*time.Hour)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	_, err = ValidateToken(testSecret, token)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
	if !strings.Contains(err.Error(), "expired") {
		t.Errorf("error = %q, want to contain 'expired'", err.Error())
	}
}

func TestTamperedTokenRejected(t *testing.T) {
	token, err := SignAccessToken(testSecret, "user-1", "org-1", "user@test.com")
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	// Tamper with the payload (second part)
	parts := strings.SplitN(token, ".", 3)
	parts[1] = parts[1] + "x"
	tampered := strings.Join(parts, ".")

	_, err = ValidateToken(testSecret, tampered)
	if err == nil {
		t.Fatal("expected error for tampered token")
	}
	if !strings.Contains(err.Error(), "signature") {
		t.Errorf("error = %q, want to contain 'signature'", err.Error())
	}
}

func TestWrongSecretRejected(t *testing.T) {
	token, err := SignAccessToken(testSecret, "user-1", "org-1", "user@test.com")
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	wrongSecret := []byte("wrong-secret-key-that-is-different-from-the-original")
	_, err = ValidateToken(wrongSecret, token)
	if err == nil {
		t.Fatal("expected error for wrong secret")
	}
}

func TestMalformedTokenRejected(t *testing.T) {
	cases := []string{
		"",
		"not-a-jwt",
		"only.two",
		"a.b.c.d",
	}
	for _, tc := range cases {
		_, err := ValidateToken(testSecret, tc)
		if err == nil {
			t.Errorf("expected error for token %q", tc)
		}
	}
}
