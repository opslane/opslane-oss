package handler

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleWebhook_MissingDeliveryID(t *testing.T) {
	t.Setenv("GITHUB_WEBHOOK_SECRET", "test-secret")
	payload := []byte(`{"action":"closed","pull_request":{"number":1,"merged":true},"repository":{"full_name":"org/repo"}}`)
	mac := hmac.New(sha256.New, []byte("test-secret"))
	mac.Write(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", bytes.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-GitHub-Event", "pull_request")

	rec := httptest.NewRecorder()
	(&Dependencies{}).HandleWebhook(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestVerifyWebhookSignature_Valid(t *testing.T) {
	secret := "test-secret"
	payload := []byte(`{"action":"closed"}`)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !verifyWebhookSignature(payload, secret, sig) {
		t.Error("expected valid signature to pass verification")
	}
}

func TestVerifyWebhookSignature_Invalid(t *testing.T) {
	secret := "test-secret"
	payload := []byte(`{"action":"closed"}`)

	if verifyWebhookSignature(payload, secret, "sha256=deadbeef") {
		t.Error("expected invalid signature to fail verification")
	}
}

func TestVerifyWebhookSignature_EmptySignature(t *testing.T) {
	if verifyWebhookSignature([]byte("test"), "secret", "") {
		t.Error("expected empty signature to fail verification")
	}
}

func TestVerifyWebhookSignature_WrongPrefix(t *testing.T) {
	if verifyWebhookSignature([]byte("test"), "secret", "sha1=abc") {
		t.Error("expected wrong prefix to fail verification")
	}
}

func TestVerifyWebhookSignature_WrongSecret(t *testing.T) {
	payload := []byte(`{"action":"closed"}`)
	mac := hmac.New(sha256.New, []byte("correct-secret"))
	mac.Write(payload)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if verifyWebhookSignature(payload, "wrong-secret", sig) {
		t.Error("expected wrong secret to fail verification")
	}
}
