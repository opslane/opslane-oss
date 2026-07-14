package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
)

// GenerateAuthCode returns a raw authorization code and its SHA-256 hash.
func GenerateAuthCode() (raw string, hash string, err error) {
	return GenerateOpaqueToken()
}

// VerifyPKCE checks that the code_verifier matches the stored code_challenge using S256.
// Matches the CLI's generatePKCE() in cli/src/auth.ts.
func VerifyPKCE(codeVerifier, codeChallenge string) bool {
	h := sha256.Sum256([]byte(codeVerifier))
	computed := base64.RawURLEncoding.EncodeToString(h[:])
	return hmac.Equal([]byte(computed), []byte(codeChallenge))
}
