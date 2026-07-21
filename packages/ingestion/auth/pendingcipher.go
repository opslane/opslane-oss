package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

const pendingKeyInfo = "opslane/oauth-pending-verification/v1"

// PendingCipher seals OAuth pending-verification bearer tokens at rest. Every
// operation requires AAD so the ciphertext is bound to its continuation flow.
type PendingCipher struct {
	aead cipher.AEAD
}

func NewPendingCipher(jwtSecret []byte) (*PendingCipher, error) {
	if len(jwtSecret) < 32 {
		return nil, fmt.Errorf("jwt secret too short for pending-verification key derivation")
	}

	key := make([]byte, 32)
	reader := hkdf.New(sha256.New, jwtSecret, nil, []byte(pendingKeyInfo))
	if _, err := io.ReadFull(reader, key); err != nil {
		return nil, fmt.Errorf("derive pending-verification key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create pending-verification cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create pending-verification AEAD: %w", err)
	}
	return &PendingCipher{aead: aead}, nil
}

// Seal returns nonce || ciphertext. The AAD must identify the owning flow.
func (c *PendingCipher) Seal(plaintext, aad []byte) ([]byte, error) {
	if len(aad) == 0 {
		return nil, fmt.Errorf("pending-verification AAD is required")
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate pending-verification nonce: %w", err)
	}
	return c.aead.Seal(nonce, nonce, plaintext, aad), nil
}

// Open authenticates and decrypts a nonce-prefixed ciphertext for its flow.
func (c *PendingCipher) Open(blob, aad []byte) ([]byte, error) {
	if len(aad) == 0 {
		return nil, fmt.Errorf("pending-verification AAD is required")
	}
	nonceSize := c.aead.NonceSize()
	if len(blob) < nonceSize+c.aead.Overhead() {
		return nil, fmt.Errorf("pending-verification ciphertext too short")
	}
	plaintext, err := c.aead.Open(nil, blob[:nonceSize], blob[nonceSize:], aad)
	if err != nil {
		return nil, fmt.Errorf("open pending-verification token: %w", err)
	}
	return plaintext, nil
}
