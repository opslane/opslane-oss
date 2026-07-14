package auth

import "testing"

func TestHashAndCheckRoundTrip(t *testing.T) {
	hash, err := HashPassword("mypassword123")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}

	if err := CheckPassword(hash, "mypassword123"); err != nil {
		t.Fatalf("check correct password: %v", err)
	}
}

func TestCheckWrongPassword(t *testing.T) {
	hash, err := HashPassword("correctpassword")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}

	if err := CheckPassword(hash, "wrongpassword"); err == nil {
		t.Fatal("expected error for wrong password")
	}
}

func TestHashPasswordRejectsTooLong(t *testing.T) {
	long := make([]byte, 73)
	for i := range long {
		long[i] = 'a'
	}
	_, err := HashPassword(string(long))
	if err == nil {
		t.Fatal("expected error for password >72 bytes")
	}
}
