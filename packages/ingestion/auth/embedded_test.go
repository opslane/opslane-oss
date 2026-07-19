package auth

import (
	"errors"
	"testing"
)

func TestPendingVerificationErrorCarriesToken(t *testing.T) {
	var target *PendingVerificationError
	err := error(&PendingVerificationError{
		PendingAuthenticationToken: "pat_1",
		EmailVerificationID:        "ev_1",
	})
	if !errors.As(err, &target) {
		t.Fatal("errors.As should match *PendingVerificationError")
	}
	if target.PendingAuthenticationToken != "pat_1" {
		t.Fatalf("token = %q", target.PendingAuthenticationToken)
	}
	if err.Error() == "" {
		t.Fatal("Error() must be non-empty")
	}
}
