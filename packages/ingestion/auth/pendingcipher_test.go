package auth

import (
	"bytes"
	"testing"
)

func TestPendingCipherRoundTrip(t *testing.T) {
	cipher, err := NewPendingCipher(bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatalf("NewPendingCipher: %v", err)
	}
	plaintext := []byte("pat_secret_bearer_token")
	aad := []byte("flow-hash-1")

	sealed, err := cipher.Seal(plaintext, aad)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if bytes.Contains(sealed, plaintext) {
		t.Fatal("sealed token contains plaintext")
	}
	opened, err := cipher.Open(sealed, aad)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !bytes.Equal(opened, plaintext) {
		t.Fatalf("Open = %q, want %q", opened, plaintext)
	}
}

func TestPendingCipherRejectsDifferentFlowAAD(t *testing.T) {
	cipher, err := NewPendingCipher(bytes.Repeat([]byte{0x23}, 32))
	if err != nil {
		t.Fatalf("NewPendingCipher: %v", err)
	}
	sealed, err := cipher.Seal([]byte("pat_secret"), []byte("flow-hash-1"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, err := cipher.Open(sealed, []byte("flow-hash-2")); err == nil {
		t.Fatal("Open accepted ciphertext bound to a different flow")
	}
}

func TestPendingCipherRejectsTampering(t *testing.T) {
	cipher, err := NewPendingCipher(bytes.Repeat([]byte{0x17}, 32))
	if err != nil {
		t.Fatalf("NewPendingCipher: %v", err)
	}
	sealed, err := cipher.Seal([]byte("pat_secret"), []byte("flow-hash"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	sealed[len(sealed)-1] ^= 0xff
	if _, err := cipher.Open(sealed, []byte("flow-hash")); err == nil {
		t.Fatal("Open accepted tampered ciphertext")
	}
}

func TestPendingCipherRejectsShortSecret(t *testing.T) {
	if _, err := NewPendingCipher(bytes.Repeat([]byte{0x42}, 31)); err == nil {
		t.Fatal("NewPendingCipher accepted a secret shorter than 32 bytes")
	}
}

func TestPendingCipherRequiresAAD(t *testing.T) {
	cipher, err := NewPendingCipher(bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatalf("NewPendingCipher: %v", err)
	}
	if _, err := cipher.Seal([]byte("pat_secret"), nil); err == nil {
		t.Fatal("Seal accepted empty AAD")
	}
	if _, err := cipher.Open(make([]byte, 64), nil); err == nil {
		t.Fatal("Open accepted empty AAD")
	}
}
