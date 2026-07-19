package auth

// Agent-session key delivery (design decision 15, v4.1 sealed-box form).
//
// The poll token is the only secret the CLI holds. The server stores the
// token's SHA-256 hash (authentication) and an X25519 PUBLIC key derived
// from the token (encryption). The GitHub callback seals the freshly minted
// API key to that public key; only a poll presenting the raw token can
// re-derive the private key and open the box. A database snapshot (hash +
// public key + ciphertext) is not decryptable.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

const agentKeySeedContext = "opslane-agent-key-v1:"

// deriveKey runs HKDF-SHA256 over a high-entropy secret (a poll token or an
// X25519 shared secret) to produce a 32-byte key. HKDF is the correct KDF for
// cryptographic secrets; a bare hash is not (it also invites length-extension
// and concatenation ambiguity for the multi-input AEAD case).
func deriveKey(secret, info []byte) ([32]byte, error) {
	var out [32]byte
	r := hkdf.New(sha256.New, secret, []byte(agentKeySeedContext), info)
	if _, err := io.ReadFull(r, out[:]); err != nil {
		return out, fmt.Errorf("hkdf: %w", err)
	}
	return out, nil
}

// NewAgentPollToken returns (raw token, sha256 hash, base64 X25519 public key).
// The raw token is shown to the CLI exactly once; only hash + pub are stored.
func NewAgentPollToken() (raw, hash, pubB64 string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", "", err
	}
	raw = "opt_" + hex.EncodeToString(buf)
	priv, err := agentKeyPrivate(raw)
	if err != nil {
		return "", "", "", err
	}
	return raw, HashToken(raw), base64.StdEncoding.EncodeToString(priv.PublicKey().Bytes()), nil
}

func agentKeyPrivate(pollToken string) (*ecdh.PrivateKey, error) {
	seed, err := deriveKey([]byte(pollToken), []byte("x25519-seed"))
	if err != nil {
		return nil, err
	}
	return ecdh.X25519().NewPrivateKey(seed[:])
}

// SealAgentKey encrypts apiKey to the stored public key. Output layout:
// base64(ephemeralPub[32] || nonce[12] || AES-256-GCM ciphertext), with the
// session ID bound as AAD so a ciphertext cannot be replayed across sessions.
func SealAgentKey(pubB64, sessionID, apiKey string) (string, error) {
	pubBytes, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil {
		return "", fmt.Errorf("decode agent key pub: %w", err)
	}
	recipient, err := ecdh.X25519().NewPublicKey(pubBytes)
	if err != nil {
		return "", fmt.Errorf("parse agent key pub: %w", err)
	}
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	gcm, err := agentKeyAEAD(eph, recipient, eph.PublicKey().Bytes(), pubBytes)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(apiKey), []byte(sessionID))
	out := append(append(eph.PublicKey().Bytes(), nonce...), sealed...)
	return base64.StdEncoding.EncodeToString(out), nil
}

// OpenAgentKey re-derives the private key from the presented poll token and
// opens the sealed box. Fails for a wrong token, wrong session, or tampering.
func OpenAgentKey(pollToken, sessionID, sealedB64 string) (string, error) {
	blob, err := base64.StdEncoding.DecodeString(sealedB64)
	if err != nil {
		return "", fmt.Errorf("decode sealed key: %w", err)
	}
	if len(blob) < 32+12+16 {
		return "", fmt.Errorf("sealed key too short")
	}
	ephPub, err := ecdh.X25519().NewPublicKey(blob[:32])
	if err != nil {
		return "", fmt.Errorf("parse ephemeral pub: %w", err)
	}
	priv, err := agentKeyPrivate(pollToken)
	if err != nil {
		return "", err
	}
	gcm, err := agentKeyAEAD(priv, ephPub, blob[:32], priv.PublicKey().Bytes())
	if err != nil {
		return "", err
	}
	nonce, ct := blob[32:32+gcm.NonceSize()], blob[32+gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ct, []byte(sessionID))
	if err != nil {
		return "", fmt.Errorf("open sealed key: %w", err)
	}
	return string(plain), nil
}

// agentKeyAEAD derives the AES-256-GCM AEAD from the X25519 shared secret,
// binding both public keys into the KDF input.
func agentKeyAEAD(priv *ecdh.PrivateKey, peer *ecdh.PublicKey, ephPub, recipientPub []byte) (cipher.AEAD, error) {
	shared, err := priv.ECDH(peer)
	if err != nil {
		return nil, fmt.Errorf("ecdh: %w", err)
	}
	// Bind both public keys into the KDF info so the derived key is unique to
	// this ephemeral/recipient pair.
	key, err := deriveKey(shared, append(append([]byte("aead:"), ephPub...), recipientPub...))
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
