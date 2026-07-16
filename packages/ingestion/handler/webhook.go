package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
)

// pullRequestEvent represents the relevant fields from a GitHub pull_request webhook payload.
type pullRequestEvent struct {
	Action      string `json:"action"`
	PullRequest struct {
		Number int  `json:"number"`
		Merged bool `json:"merged"`
	} `json:"pull_request"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
}

// HandleWebhook handles POST /api/v1/github/webhook.
// Verifies the GitHub HMAC-SHA256 signature and processes pull_request events.
func (d *Dependencies) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	secret := os.Getenv("GITHUB_WEBHOOK_SECRET")
	if secret == "" {
		slog.Error("GITHUB_WEBHOOK_SECRET not configured")
		writeJSONError(w, http.StatusInternalServerError, "webhook not configured")
		return
	}

	// Read body (limit to 1MB — webhook payloads are typically small)
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	// Verify HMAC-SHA256 signature
	signature := r.Header.Get("X-Hub-Signature-256")
	if !verifyWebhookSignature(body, secret, signature) {
		writeJSONError(w, http.StatusUnauthorized, "invalid signature")
		return
	}

	// Only handle pull_request events
	eventType := r.Header.Get("X-GitHub-Event")
	if eventType != "pull_request" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ignored", "event": eventType})
		return
	}

	var event pullRequestEvent
	if err := json.Unmarshal(body, &event); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	// Only handle "closed" action
	if event.Action != "closed" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ignored", "action": event.Action})
		return
	}

	repo := event.Repository.FullName
	prNumber := event.PullRequest.Number
	deliveryID := strings.TrimSpace(r.Header.Get("X-GitHub-Delivery"))
	if deliveryID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing X-GitHub-Delivery header")
		return
	}

	outcome := "closed"
	if event.PullRequest.Merged {
		outcome = "merged"
	}

	// Transition + receipt insert are one transaction: a partial failure rolls
	// both back so a redelivery can complete them together.
	transition, err := d.Queries.RecordPRLifecycleEvent(r.Context(), repo, prNumber, outcome, deliveryID)
	if err != nil {
		slog.Error("webhook: record PR lifecycle event failed", "repo", repo, "pr", prNumber, "outcome", outcome, "delivery_id", deliveryID, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process "+outcome+" event")
		return
	}
	status := "processed"
	if transition.ErrorGroupID == "" {
		status = "no_match"
	}
	slog.Info("webhook: PR "+outcome, "repo", repo, "pr", prNumber, "group_id", transition.ErrorGroupID, "status", status)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": status, "action": outcome, "group_id": transition.ErrorGroupID})
}

// verifyWebhookSignature validates the X-Hub-Signature-256 header.
func verifyWebhookSignature(payload []byte, secret, signature string) bool {
	if signature == "" {
		return false
	}
	// Signature format: "sha256=<hex>"
	prefix := "sha256="
	if !strings.HasPrefix(signature, prefix) {
		return false
	}
	sigHex := signature[len(prefix):]

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expected := hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(sigHex), []byte(expected))
}
