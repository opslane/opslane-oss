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
	"time"
)

// pullRequestEvent represents the relevant fields from a GitHub pull_request webhook payload.
type pullRequestEvent struct {
	Action      string `json:"action"`
	PullRequest struct {
		Number   int        `json:"number"`
		Merged   bool       `json:"merged"`
		ClosedAt *time.Time `json:"closed_at"`
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

	deliveryID := r.Header.Get("X-GitHub-Delivery")
	if deliveryID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing X-GitHub-Delivery header")
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
	occurredAt := time.Now()
	if event.PullRequest.ClosedAt != nil {
		occurredAt = *event.PullRequest.ClosedAt
	}
	action := "closed"
	if event.PullRequest.Merged {
		action = "merged"
	}

	result, err := d.Queries.ProcessPRWebhook(
		r.Context(), repo, prNumber, event.PullRequest.Merged, deliveryID, occurredAt,
	)
	if err != nil {
		slog.Error("webhook: process PR event failed", "repo", repo, "pr", prNumber, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process pull_request event")
		return
	}
	status := "processed"
	switch {
	case result.Duplicate:
		status = "duplicate"
	case result.GroupID == "":
		status = "no_match"
	}
	slog.Info("webhook: PR "+action,
		"repo", repo,
		"pr", prNumber,
		"group_id", result.GroupID,
		"status", status,
		"delivery_id", deliveryID,
	)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": status, "action": action, "group_id": result.GroupID,
	})
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
