package handler

import (
	"crypto/hmac"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// === GET /auth/github — start GitHub OAuth flow ===

func (d *Dependencies) GitHubOAuthStart(w http.ResponseWriter, r *http.Request) {
	if d.GitHubAppClientID == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub OAuth not configured")
		return
	}

	state, err := generateOAuthState(d.JWTSecret)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     "__github_state",
		Value:    state,
		Path:     "/auth/github",
		MaxAge:   300,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})

	params := url.Values{
		"client_id":    {d.GitHubAppClientID},
		"redirect_uri": {backendOrigin(r) + "/auth/github/callback"},
		"scope":        {"user:email"},
		"state":        {state},
	}
	redirectURL := "https://github.com/login/oauth/authorize?" + params.Encode()
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

// === GET /auth/github/callback — handle GitHub OAuth callback ===

func (d *Dependencies) GitHubOAuthCallback(w http.ResponseWriter, r *http.Request) {
	installationIDStr := r.URL.Query().Get("installation_id")
	setupAction := r.URL.Query().Get("setup_action")
	isInstallCallback := installationIDStr != "" && setupAction != ""

	stateCookie, err := r.Cookie("__github_state")
	stateParam := r.URL.Query().Get("state")
	cookieValue := ""
	if err == nil {
		cookieValue = stateCookie.Value
	}
	if !validOAuthState(cookieValue, stateParam) {
		writeJSONError(w, http.StatusForbidden, "invalid OAuth state")
		return
	}

	// Clear the state cookie (if it exists)
	http.SetCookie(w, &http.Cookie{
		Name:     "__github_state",
		Value:    "",
		Path:     "/auth/github",
		MaxAge:   -1,
		HttpOnly: true,
	})

	code := r.URL.Query().Get("code")
	if code == "" {
		writeJSONError(w, http.StatusBadRequest, "missing code parameter")
		return
	}

	// Exchange code for user token
	token, err := gh.ExchangeOAuthCode(d.GitHubAppClientID, d.GitHubAppClientSecret, code)
	if err != nil {
		slog.Error("GitHub OAuth code exchange failed", "error", err)
		writeJSONError(w, http.StatusBadGateway, "GitHub authentication failed")
		return
	}

	// Fetch user profile
	ghUser, err := gh.GetUser(token.AccessToken)
	if err != nil {
		slog.Error("GitHub get user failed", "error", err)
		writeJSONError(w, http.StatusBadGateway, "failed to fetch GitHub profile")
		return
	}

	// Get email — fallback to /user/emails if profile email is empty
	email := ghUser.Email
	if email == "" {
		emails, err := gh.GetUserEmails(token.AccessToken)
		if err != nil {
			slog.Error("GitHub get emails failed", "error", err)
			writeJSONError(w, http.StatusBadGateway, "failed to fetch GitHub email")
			return
		}
		for _, e := range emails {
			if e.Primary && e.Verified {
				email = e.Email
				break
			}
		}
	}
	if email == "" {
		writeJSONError(w, http.StatusBadRequest, "no verified email found on GitHub account")
		return
	}

	// Upsert user: try GitHub ID first, then email (account linking), then create new.
	name := ghUser.Name
	if name == "" {
		name = ghUser.Login
	}

	user, err := d.Queries.GetUserByGitHubID(r.Context(), ghUser.ID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if user != nil {
		// Existing GitHub user — update profile fields
		if err := d.Queries.UpdateUserGitHub(r.Context(), user.ID, ghUser.Login, ghUser.AvatarURL, email); err != nil {
			slog.Error("update github user failed", "error", err)
		}
		user.Email = email
	} else {
		// No user with this GitHub ID — check if email already exists (account linking)
		existingUser, err := d.Queries.GetUserByEmail(r.Context(), email)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}

		if existingUser != nil {
			// Link GitHub identity to the existing email/password user
			if err := d.Queries.LinkUserGitHub(r.Context(), existingUser.ID, ghUser.ID, ghUser.Login, ghUser.AvatarURL); err != nil {
				slog.Error("link github user failed", "error", err, "user_id", existingUser.ID, "github_id", ghUser.ID)
				writeJSONError(w, http.StatusInternalServerError, "failed to link GitHub account")
				return
			}
			slog.Info("linked GitHub identity to existing user", "user_id", existingUser.ID, "github_id", ghUser.ID)
			user = existingUser
		} else {
			// Truly new user — create org + user
			org, err := d.Queries.CreateOrg(r.Context(), ghUser.Login)
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, "failed to create organization")
				return
			}
			user, err = d.Queries.CreateUserGitHub(r.Context(), org.ID, email, name, ghUser.ID, ghUser.Login, ghUser.AvatarURL)
			if err != nil {
				slog.Error("create github user failed", "error", err, "github_id", ghUser.ID)
				writeJSONError(w, http.StatusInternalServerError, "failed to create user")
				return
			}
		}
	}

	// If this is a combined install+auth callback, verify the installation before storing it.
	if isInstallCallback && setupAction == "install" && installationIDStr != "" {
		installationID, parseErr := strconv.ParseInt(installationIDStr, 10, 64)
		if parseErr != nil || installationID <= 0 {
			writeJSONError(w, http.StatusBadRequest, "invalid installation_id")
			return
		}
		if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
			writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
			return
		}
		appJWT, jwtErr := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
		if jwtErr != nil {
			slog.Error("could not generate app JWT for install verification", "error", jwtErr)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if _, verifyErr := gh.VerifyInstallation(appJWT, installationID); verifyErr != nil {
			slog.Warn("installation verification failed", "error", verifyErr, "installation_id", installationID)
			writeJSONError(w, http.StatusForbidden, "invalid or unauthorized installation")
			return
		}
		if storeErr := d.Queries.SetOrgGitHubInstallation(r.Context(), user.OrgID, installationID); storeErr != nil {
			slog.Error("failed to store installation id during install callback", "error", storeErr, "org_id", user.OrgID)
			writeJSONError(w, http.StatusInternalServerError, "failed to store installation")
			return
		}
		slog.Info("GitHub App installed via combined callback", "org_id", user.OrgID, "installation_id", installationID)
	}

	// Issue JWT + refresh token
	familyID := uuid.New().String()
	accessToken, err := auth.SignAccessToken(d.JWTSecret, user.ID, user.OrgID, user.Email)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to sign token")
		return
	}

	rawRefresh, hashRefresh, err := auth.GenerateRefreshToken()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to generate refresh token")
		return
	}

	if err := d.Queries.StoreRefreshToken(r.Context(), user.ID, hashRefresh, familyID, time.Now().Add(refreshTokenTTL)); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store refresh token")
		return
	}

	setAuthCookies(w, r, accessToken, rawRefresh)
	http.Redirect(w, r, d.DashboardOrigin+"/auth/callback", http.StatusFound)
}

// === helpers ===

func generateOAuthState(secret []byte) (string, error) {
	nonce := make([]byte, 16)
	if _, err := crand.Read(nonce); err != nil {
		return "", err
	}
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(timestamp))
	mac.Write(nonce)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func validOAuthState(cookie, param string) bool {
	return cookie != "" && param != "" && hmac.Equal([]byte(cookie), []byte(param))
}

// backendOrigin returns the origin of the backend for redirect_uri construction.
func backendOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, r.Host)
}

// === GitHub App installation + repo endpoints ===

// GitHubSetupCallback handles the redirect after a user installs the GitHub App.
// GET /api/v1/github/setup?installation_id=123&setup_action=install
func (d *Dependencies) GitHubSetupCallback(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	installationIDStr := r.URL.Query().Get("installation_id")
	setupAction := r.URL.Query().Get("setup_action")

	if setupAction == "install" && installationIDStr != "" {
		installationID, err := strconv.ParseInt(installationIDStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid installation_id")
			return
		}

		// Verify installation belongs to this GitHub App before trusting it
		if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
			writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
			return
		}
		appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
		if err != nil {
			slog.Error("failed to generate app JWT for verification", "error", err)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if _, err := gh.VerifyInstallation(appJWT, installationID); err != nil {
			slog.Warn("installation verification failed", "installation_id", installationID, "org_id", orgID, "error", err)
			writeJSONError(w, http.StatusBadRequest, "invalid or unauthorized installation")
			return
		}

		if err := d.Queries.SetOrgGitHubInstallation(r.Context(), orgID, installationID); err != nil {
			slog.Error("failed to store installation id", "error", err, "org_id", orgID)
			writeJSONError(w, http.StatusInternalServerError, "failed to store installation")
			return
		}
		slog.Info("GitHub App installed", "org_id", orgID, "installation_id", installationID)
	}

	http.Redirect(w, r, d.DashboardOrigin+"/settings?github_installed=true", http.StatusFound)
}

// GetGitHubAppStatus returns the GitHub App installation status for the user's org.
// GET /api/v1/github/status
func (d *Dependencies) GetGitHubAppStatus(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	installURL := ""
	if d.GitHubAppSlug != "" {
		state, err := generateOAuthState(d.JWTSecret)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
		http.SetCookie(w, &http.Cookie{
			Name:     "__github_state",
			Value:    state,
			Path:     "/auth/github",
			MaxAge:   300,
			HttpOnly: true,
			Secure:   isSecure,
			SameSite: http.SameSiteLaxMode,
		})
		installURL = fmt.Sprintf("https://github.com/apps/%s/installations/new?state=%s", d.GitHubAppSlug, url.QueryEscape(state))
	}

	type statusResponse struct {
		Installed      bool   `json:"installed"`
		InstallationID *int64 `json:"installation_id"`
		InstallURL     string `json:"install_url"`
	}

	resp := statusResponse{
		Installed:  installationID > 0,
		InstallURL: installURL,
	}
	if installationID > 0 {
		resp.InstallationID = &installationID
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// ListGitHubRepos returns the repos accessible to the org's GitHub App installation.
// GET /api/v1/github/repos
func (d *Dependencies) ListGitHubRepos(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if installationID == 0 {
		writeJSONError(w, http.StatusBadRequest, "GitHub App not installed")
		return
	}

	if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
		return
	}

	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		slog.Error("failed to generate app JWT", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	installToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		slog.Error("failed to get installation token", "error", err, "installation_id", installationID)
		writeJSONError(w, http.StatusBadGateway, "failed to get GitHub access")
		return
	}

	repos, err := gh.ListInstallationRepos(installToken.Token)
	if err != nil {
		slog.Error("failed to list repos", "error", err)
		writeJSONError(w, http.StatusBadGateway, "failed to list repositories")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(repos)
}
