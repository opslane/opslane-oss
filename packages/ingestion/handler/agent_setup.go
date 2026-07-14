package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// Rate limiters for agent endpoints
var agentSetupLimiter = newRateLimiter(5)  // 5/min per IP — session creation
var agentPollLimiter = newRateLimiter(30)  // 30/min per IP — polling

// repoURLPattern validates owner/repo format
var repoURLPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`)

// AgentSetup creates a new agent session for a CLI-initiated auth flow.
// No auth required — this initiates the auth flow.
//
// POST /api/v1/agent/setup
func (d *Dependencies) AgentSetup(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !agentSetupLimiter.allow(ip) {
		slog.Warn("agent setup rate limit exceeded", "ip", ip)
		writeJSONError(w, http.StatusTooManyRequests, "too many requests, try again later")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16) // 64KB
	var req struct {
		RepoURL   string `json:"repo_url"`
		AgentName string `json:"agent_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.RepoURL == "" {
		writeJSONError(w, http.StatusBadRequest, "repo_url is required")
		return
	}
	if !repoURLPattern.MatchString(req.RepoURL) {
		writeJSONError(w, http.StatusBadRequest, "repo_url must be in owner/repo format")
		return
	}

	// Check for returning user — repo already has a project
	existingProject, err := d.Queries.FindProjectByRepoURL(r.Context(), req.RepoURL)
	if err != nil {
		slog.Error("agent setup: find project by repo", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if existingProject != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"status":     "already_configured",
			"project_id": existingProject.ID,
			"org_id":     existingProject.OrgID,
			"repo":       req.RepoURL,
			"message":    "This repo already has a Opslane project. Run 'opslane login' to authenticate.",
		})
		return
	}

	var agentName *string
	if req.AgentName != "" {
		agentName = &req.AgentName
	}
	session, err := d.Queries.CreateAgentSession(r.Context(), req.RepoURL, agentName)
	if err != nil {
		slog.Error("agent setup: create session", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to create setup session")
		return
	}

	// Build the auth URL — human clicks this to install the GitHub App
	authURL := fmt.Sprintf("%s/agent/auth/%s", backendOrigin(r), session.ID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"status":   "auth_required",
		"auth_url": authURL,
		"poll_id":  session.ID,
		"message":  fmt.Sprintf("Authorize Opslane: %s", authURL),
	})
}

// AgentPoll checks the status of an agent session.
// No auth required — the poll_id (UUID) acts as the secret.
//
// GET /api/v1/agent/poll/{sessionID}
func (d *Dependencies) AgentPoll(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !agentPollLimiter.allow(ip) {
		writeJSONError(w, http.StatusTooManyRequests, "too many requests, try again later")
		return
	}

	sessionID := chi.URLParam(r, "sessionID")
	if sessionID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing session ID")
		return
	}

	// Validate UUID format
	if _, err := uuid.Parse(sessionID); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session ID")
		return
	}

	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent poll: get session", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if session == nil {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}

	switch session.Status {
	case "completed":
		resp := map[string]any{
			"status": "completed",
			"repo":   session.RepoURL,
		}
		if session.OrgID != nil {
			resp["org_id"] = *session.OrgID
		}
		if session.ProjectID != nil {
			resp["project_id"] = *session.ProjectID
		}

		// Atomically claim the key — only first poll gets it
		apiKey, claimErr := d.Queries.ClaimAgentSessionKey(r.Context(), sessionID)
		if claimErr != nil {
			slog.Error("agent poll: claim key", "error", claimErr)
		}
		if apiKey != nil {
			resp["api_key"] = *apiKey
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)

	case "expired":
		writeJSONError(w, http.StatusGone, "session expired")

	default: // pending
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"status": "pending",
		})
	}
}

// AgentAuthRedirect redirects the human to the GitHub App installation page.
// The session ID is passed as state so we can complete the session on callback.
//
// GET /agent/auth/{sessionID}
func (d *Dependencies) AgentAuthRedirect(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if sessionID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing session ID")
		return
	}

	if _, err := uuid.Parse(sessionID); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session ID")
		return
	}

	if d.GitHubAppSlug == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
		return
	}

	// Verify session exists and is pending
	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent auth redirect: get session", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if session == nil {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}
	if session.Status != "pending" {
		writeJSONError(w, http.StatusGone, "session already completed or expired")
		return
	}
	if time.Now().After(session.ExpiresAt) {
		writeJSONError(w, http.StatusGone, "session expired")
		return
	}

	// Redirect to GitHub App installation with state=sessionID
	installURL := fmt.Sprintf(
		"https://github.com/apps/%s/installations/new?state=%s",
		d.GitHubAppSlug,
		sessionID,
	)
	http.Redirect(w, r, installURL, http.StatusFound)
}

// AgentAuthCallback handles the GitHub App installation callback.
// Auto-provisions org + project + env + API key, then completes the agent session.
//
// GET /agent/auth/callback?installation_id=X&setup_action=install&state={sessionID}
func (d *Dependencies) AgentAuthCallback(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("state")
	installationIDStr := r.URL.Query().Get("installation_id")

	if sessionID == "" || installationIDStr == "" {
		http.Error(w, "Missing required parameters", http.StatusBadRequest)
		return
	}

	if _, err := uuid.Parse(sessionID); err != nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	// Get the session — status + expiry checked here to fail fast.
	// CompleteAgentSession also checks WHERE status='pending' AND expires_at > now()
	// as the authoritative guard against double-completion.
	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent auth callback: get session", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if session == nil || session.Status != "pending" {
		writeJSONError(w, http.StatusBadRequest, "invalid or expired session")
		return
	}

	var installationID int64
	if _, scanErr := fmt.Sscanf(installationIDStr, "%d", &installationID); scanErr != nil || installationID <= 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid installation_id")
		return
	}

	// If the callback also has a code param, exchange it for a user token
	// to get the GitHub user identity (for org/user creation).
	code := r.URL.Query().Get("code")
	var ghUser *gh.GitHubUser
	var email string

	if code != "" && d.GitHubAppClientID != "" {
		token, tokenErr := gh.ExchangeOAuthCode(d.GitHubAppClientID, d.GitHubAppClientSecret, code)
		if tokenErr != nil {
			slog.Error("agent auth callback: code exchange failed", "error", tokenErr)
		} else {
			ghUser, _ = gh.GetUser(token.AccessToken)
			if ghUser != nil {
				email = ghUser.Email
				if email == "" {
					emails, _ := gh.GetUserEmails(token.AccessToken)
					for _, e := range emails {
						if e.Primary && e.Verified {
							email = e.Email
							break
						}
					}
				}
			}
		}
	}

	// Verify the installation with GitHub
	if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
		return
	}

	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		slog.Error("agent auth callback: generate app JWT", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	installInfo, err := gh.VerifyInstallation(appJWT, installationID)
	if err != nil {
		slog.Warn("agent auth callback: installation verification failed",
			"error", err, "installation_id", installationID)
		writeJSONError(w, http.StatusBadRequest, "invalid or unauthorized installation")
		return
	}

	// Check session expiry before provisioning to avoid creating orphaned resources.
	// CompleteAgentSession also enforces this via WHERE expires_at > now(),
	// but checking here prevents wasted work.
	if time.Now().After(session.ExpiresAt) {
		writeJSONError(w, http.StatusGone, "session expired")
		return
	}

	// Auto-provision: find or create org, project, env, API key
	orgID, projectID, apiKey, provisionErr := d.autoProvision(
		r.Context(), session, installInfo, installationID, ghUser, email,
	)
	if provisionErr != nil {
		slog.Error("agent auth callback: auto-provision failed", "error", provisionErr)
		writeJSONError(w, http.StatusInternalServerError, "failed to set up project")
		return
	}

	// Complete the agent session — atomic WHERE status='pending' AND expires_at > now()
	// prevents double-completion even if two callbacks race.
	completed, err := d.Queries.CompleteAgentSession(
		r.Context(), sessionID, orgID, projectID, apiKey, installationID,
	)
	if err != nil {
		slog.Error("agent auth callback: complete session", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to complete setup")
		return
	}
	if !completed {
		// Session was completed by another request or expired between our check and the UPDATE.
		// Resources were provisioned but session won't deliver the key — acceptable for pilot.
		slog.Warn("agent auth callback: session already completed or expired",
			"session_id", sessionID)
	}

	slog.Info("agent session completed",
		"session_id", sessionID,
		"org_id", orgID,
		"project_id", projectID,
		"repo", session.RepoURL)

	// Show confirmation page to the human
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>Opslane Setup Complete</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 100px auto; text-align: center;">
<h1>Done!</h1>
<p>Opslane is set up for <strong>%s</strong>.</p>
<p>Your agent is finishing the integration. You can close this tab.</p>
</body></html>`, template.HTMLEscapeString(session.RepoURL))
}

// autoProvision finds or creates org + project + env + API key for the agent session.
func (d *Dependencies) autoProvision(
	ctx context.Context,
	session *db.AgentSession,
	installInfo *gh.InstallationInfo,
	installationID int64,
	ghUser *gh.GitHubUser,
	email string,
) (orgID, projectID, apiKey string, err error) {

	// Check if there's an existing installation → existing org
	existingInstall, err := d.Queries.GetGitHubAppInstallationByID(ctx, installationID)
	if err != nil {
		return "", "", "", fmt.Errorf("check existing installation: %w", err)
	}

	if existingInstall != nil {
		// Existing org — create project under it
		orgID = existingInstall.OrgID
	} else {
		// New installation — need to create or find org

		// Try to find user by GitHub ID or email for existing org
		if ghUser != nil {
			existingUser, lookupErr := d.Queries.GetUserByGitHubID(ctx, ghUser.ID)
			if lookupErr == nil && existingUser != nil {
				orgID = existingUser.OrgID
			}
		}

		if orgID == "" && email != "" {
			existingUser, lookupErr := d.Queries.GetUserByEmail(ctx, email)
			if lookupErr == nil && existingUser != nil {
				orgID = existingUser.OrgID
			}
		}

		if orgID == "" {
			// Truly new — create org
			orgName := installInfo.Account.Login
			if orgName == "" {
				orgName = session.RepoURL
			}
			org, createErr := d.Queries.CreateOrg(ctx, orgName)
			if createErr != nil {
				return "", "", "", fmt.Errorf("create org: %w", createErr)
			}
			orgID = org.ID

			// Create user if we have GitHub identity
			if ghUser != nil {
				name := ghUser.Name
				if name == "" {
					name = ghUser.Login
				}
				if email == "" {
					email = ghUser.Login + "@users.noreply.github.com"
				}
				_, createErr = d.Queries.CreateUserGitHub(
					ctx, orgID, email, name, ghUser.ID, ghUser.Login, ghUser.AvatarURL,
				)
				if createErr != nil {
					slog.Warn("agent auth: create user failed (non-fatal)", "error", createErr)
				}
			}
		}

		// Store the installation record
		if installInfo.Account.Login != "" {
			repos, _ := json.Marshal([]string{session.RepoURL})
			_, upsertErr := d.Queries.UpsertGitHubAppInstallation(
				ctx, installationID, installInfo.Account.Login,
				installInfo.Account.ID, orgID, repos,
			)
			if upsertErr != nil {
				slog.Warn("agent auth: upsert installation failed (non-fatal)", "error", upsertErr)
			}
		}

		// Also store on org for backward compat with existing code
		if storeErr := d.Queries.SetOrgGitHubInstallation(ctx, orgID, installationID); storeErr != nil {
			slog.Warn("agent auth: set org installation failed (non-fatal)", "error", storeErr)
		}
	}

	// Create project + env + API key in a transaction (reuse onboarding pattern)
	tx, err := d.Queries.Pool().Begin(ctx)
	if err != nil {
		return "", "", "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Derive project name from repo (e.g., "acme/my-app" → "my-app")
	projectName := session.RepoURL
	if idx := strings.LastIndex(session.RepoURL, "/"); idx >= 0 {
		projectName = session.RepoURL[idx+1:]
	}

	githubRepo := session.RepoURL
	project, err := d.Queries.CreateProjectTx(ctx, tx, orgID, projectName, &githubRepo)
	if err != nil {
		return "", "", "", fmt.Errorf("create project: %w", err)
	}

	env, err := d.Queries.CreateEnvironmentTx(ctx, tx, project.ID, "production")
	if err != nil {
		return "", "", "", fmt.Errorf("create environment: %w", err)
	}

	key, err := d.Queries.CreateAPIKeyTx(ctx, tx, env.ID)
	if err != nil {
		return "", "", "", fmt.Errorf("create api key: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", "", "", fmt.Errorf("commit tx: %w", err)
	}

	return orgID, project.ID, key.RawKey, nil
}
