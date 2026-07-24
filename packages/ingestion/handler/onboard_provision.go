package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

var onboardProvisionLimiter = newRateLimiter(10)

const (
	maxOnboardRepoURLLen   = 200
	maxOnboardAgentNameLen = 64
)

// OnboardProvision creates or reuses a project for an authenticated user's
// organization and returns a freshly rotated API key plus poll credentials.
//
// POST /api/v1/onboard/provision
func (d *Dependencies) OnboardProvision(w http.ResponseWriter, r *http.Request) {
	userID := UserIDFromCtx(r.Context())
	orgID := OrgIDFromCtx(r.Context())
	if userID == "" || orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	if !onboardProvisionLimiter.allow(userID) {
		w.Header().Set("Retry-After", "60")
		agentJSON(w, http.StatusTooManyRequests, map[string]any{
			"status": "rate_limited", "retry_after": 60,
		})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		RepoURL   string `json:"repo_url"`
		AgentName string `json:"agent_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !repoURLPattern.MatchString(req.RepoURL) {
		writeJSONError(w, http.StatusBadRequest, "repo_url must be in owner/repo format")
		return
	}
	// The repo becomes part of the project idempotency token, which is indexed;
	// an unbounded value would fail deep in Postgres as a 500 instead of a 400.
	if len(req.RepoURL) > maxOnboardRepoURLLen {
		writeJSONError(w, http.StatusBadRequest, "repo_url must be 200 characters or less")
		return
	}
	if len(req.AgentName) > maxOnboardAgentNameLen {
		writeJSONError(w, http.StatusBadRequest, "agent_name must be 64 characters or less")
		return
	}
	var agentName *string
	if req.AgentName != "" {
		agentName = &req.AgentName
	}

	pollToken, tokenHash, agentKeyPub, err := auth.NewAgentPollToken()
	if err != nil {
		slog.Error("onboard provision: generate poll token", "error", err, "org_id", orgID)
		agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error"})
		return
	}

	result, err := d.Queries.ProvisionOnboardSession(r.Context(), db.OnboardProvisionInput{
		OrgID:         orgID,
		ProvisionedBy: userID,
		Repo:          req.RepoURL,
		AgentName:     agentName,
		PollTokenHash: tokenHash,
		AgentKeyPub:   agentKeyPub,
		SealKey: func(sessionID, rawKey string) (string, error) {
			return auth.SealAgentKey(agentKeyPub, sessionID, rawKey)
		},
	})
	if err != nil {
		slog.Error("onboard provision", "error", err, "org_id", orgID, "user_id", userID)
		agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error"})
		return
	}

	agentJSON(w, http.StatusCreated, map[string]any{
		"status":     "provisioned",
		"api_key":    result.RawKey,
		"endpoint":   backendOrigin(r),
		"org_id":     result.OrgID,
		"project_id": result.ProjectID,
		"repo":       req.RepoURL,
		"poll_id":    result.SessionID,
		"poll_token": pollToken,
	})
}
