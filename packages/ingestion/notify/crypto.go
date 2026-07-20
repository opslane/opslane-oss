// Package notify implements notification config, formatting, and delivery.
package notify

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

const configKeyInfo = "opslane/notification-destination-config/v1"

// ConfigCipher seals notification destination credentials at rest.
type ConfigCipher struct {
	aead cipher.AEAD
}

func NewConfigCipher(jwtSecret []byte) (*ConfigCipher, error) {
	if len(jwtSecret) < 32 {
		return nil, fmt.Errorf("jwt secret too short for key derivation")
	}

	key := make([]byte, 32)
	reader := hkdf.New(sha256.New, jwtSecret, nil, []byte(configKeyInfo))
	if _, err := io.ReadFull(reader, key); err != nil {
		return nil, fmt.Errorf("derive config key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create config cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create config AEAD: %w", err)
	}
	return &ConfigCipher{aead: aead}, nil
}

// ConfigAAD binds a ciphertext to the destination row that owns it.
func ConfigAAD(destinationID, projectID, destinationType string) []byte {
	return []byte(destinationID + "|" + projectID + "|" + destinationType)
}

// Seal returns nonce || ciphertext.
func (c *ConfigCipher) Seal(plaintext, aad []byte) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}
	return c.aead.Seal(nonce, nonce, plaintext, aad), nil
}

func (c *ConfigCipher) Open(blob, aad []byte) ([]byte, error) {
	nonceSize := c.aead.NonceSize()
	if len(blob) < nonceSize+c.aead.Overhead() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	plaintext, err := c.aead.Open(nil, blob[:nonceSize], blob[nonceSize:], aad)
	if err != nil {
		return nil, fmt.Errorf("open config: %w", err)
	}
	return plaintext, nil
}
