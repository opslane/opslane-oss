package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// GenerateRefreshToken returns a raw token and its SHA-256 hash.
// The raw token is returned to the client; only the hash is stored.
func GenerateRefreshToken() (raw string, hash string, err error) {
	return GenerateOpaqueToken()
}

// GenerateOpaqueToken returns a cryptographically random 256-bit token
// (hex-encoded) and its SHA-256 hash. Used for refresh tokens and auth codes.
func GenerateOpaqueToken() (raw string, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("generate token: %w", err)
	}
	raw = hex.EncodeToString(b)
	hash = HashToken(raw)
	return raw, hash, nil
}

// HashToken returns the hex-encoded SHA-256 hash of a token string.
func HashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}
