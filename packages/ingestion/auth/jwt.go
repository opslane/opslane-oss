package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const DefaultAccessTokenTTL = 1 * time.Hour

// Claims represents the payload of a JWT access token.
type Claims struct {
	Sub   string `json:"sub"`   // user ID
	OrgID string `json:"org_id"`
	Email string `json:"email"`
	Exp   int64  `json:"exp"`
	Iat   int64  `json:"iat"`
}

// SignAccessToken creates an HS256 JWT with the given claims.
func SignAccessToken(secret []byte, userID, orgID, email string) (string, error) {
	return SignAccessTokenWithTTL(secret, userID, orgID, email, DefaultAccessTokenTTL)
}

// SignAccessTokenWithTTL creates an HS256 JWT with a custom TTL.
func SignAccessTokenWithTTL(secret []byte, userID, orgID, email string, ttl time.Duration) (string, error) {
	now := time.Now()
	claims := Claims{
		Sub:   userID,
		OrgID: orgID,
		Email: email,
		Iat:   now.Unix(),
		Exp:   now.Add(ttl).Unix(),
	}

	header := base64URLEncode([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("marshal claims: %w", err)
	}
	payloadB64 := base64URLEncode(payload)

	signingInput := header + "." + payloadB64
	sig := hmacSHA256(secret, []byte(signingInput))

	return signingInput + "." + base64URLEncode(sig), nil
}

// ValidateToken verifies an HS256 JWT and returns the claims.
func ValidateToken(secret []byte, tokenStr string) (*Claims, error) {
	parts := strings.SplitN(tokenStr, ".", 3)
	if len(parts) != 3 {
		return nil, fmt.Errorf("malformed token: expected 3 parts, got %d", len(parts))
	}

	// Validate the alg header to prevent algorithm confusion attacks.
	headerBytes, err := base64URLDecode(parts[0])
	if err != nil {
		return nil, fmt.Errorf("decode header: %w", err)
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(headerBytes, &header); err != nil || header.Alg != "HS256" {
		return nil, fmt.Errorf("unsupported or invalid alg: %s", header.Alg)
	}

	signingInput := parts[0] + "." + parts[1]
	expectedSig := hmacSHA256(secret, []byte(signingInput))
	actualSig, err := base64URLDecode(parts[2])
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}

	if !hmac.Equal(expectedSig, actualSig) {
		return nil, fmt.Errorf("invalid signature")
	}

	payloadBytes, err := base64URLDecode(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}

	var claims Claims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return nil, fmt.Errorf("unmarshal claims: %w", err)
	}

	if time.Now().Unix() >= claims.Exp {
		return nil, fmt.Errorf("token expired")
	}

	return &claims, nil
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func base64URLEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func base64URLDecode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}
