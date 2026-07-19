package handler

import (
	"context"
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
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

type oauthLoginStateStore interface {
	StoreOAuthLoginState(ctx context.Context, tokenHash string, expiresAt time.Time) error
}

// OAuthLoginStart begins the configured browser identity-provider flow.
func (d *Dependencies) OAuthLoginStart(w http.ResponseWriter, r *http.Request) {
	var socialProvider auth.SocialProvider
	if values, present := r.URL.Query()["provider"]; present {
		if len(values) != 1 {
			writeJSONError(w, http.StatusBadRequest, "unsupported sign-in provider")
			return
		}
		provider, ok := auth.DecodeSocialProvider(values[0])
		if !ok || !d.SocialProviders.Allows(provider) {
			writeJSONError(w, http.StatusBadRequest, "unsupported sign-in provider")
			return
		}
		socialProvider = provider
	}
	state, err := generateOAuthState(d.JWTSecret)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if err := d.redirectToProvider(w, r, state, socialProvider); err != nil {
		slog.Error("build provider authorization URL failed", "provider", d.provider().Name(), "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "authentication provider is not configured")
	}
}

// GitHubOAuthStart is retained for internal compatibility; public /auth/github
// is now a redirect to /auth/login.
func (d *Dependencies) GitHubOAuthStart(w http.ResponseWriter, r *http.Request) {
	d.OAuthLoginStart(w, r)
}

func (d *Dependencies) redirectToProvider(w http.ResponseWriter, r *http.Request, state string, socialProvider auth.SocialProvider) error {
	callbackOrigin := d.AuthCallbackOrigin
	if callbackOrigin == "" {
		callbackOrigin = "http://localhost:8080"
	}
	redirectURL, err := d.provider().AuthorizeURL(auth.AuthRequest{
		State:          state,
		RedirectURI:    callbackOrigin + "/auth/callback",
		SocialProvider: socialProvider,
	})
	if err != nil {
		return err
	}
	store := d.oauthStateStore
	if store == nil && d.Queries != nil {
		store = d.Queries
	}
	if store != nil {
		if err := store.StoreOAuthLoginState(r.Context(), auth.HashToken(state), time.Now().Add(5*time.Minute)); err != nil {
			return err
		}
	}
	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     "__auth_state",
		Value:    state,
		Path:     "/auth",
		MaxAge:   300,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, redirectURL, http.StatusFound)
	return nil
}

// OAuthLoginCallback completes either the browser login or the durable CLI bridge.
func (d *Dependencies) OAuthLoginCallback(w http.ResponseWriter, r *http.Request) {
	// OAuth-during-install sends all GitHub App installs to this shared
	// callback. UUID state belongs to an agent session; browser state is HMAC
	// hex and continues through the ordinary login path.
	if state := r.URL.Query().Get("state"); state != "" && r.URL.Query().Get("installation_id") != "" {
		if _, err := uuid.Parse(state); err == nil {
			d.AgentAuthCallback(w, r)
			return
		}
	}
	if providerError := r.URL.Query().Get("error"); providerError != "" {
		writeJSONError(w, http.StatusBadRequest, "authentication was denied: "+providerError)
		return
	}

	stateCookie, cookieErr := r.Cookie("__auth_state")
	state := r.URL.Query().Get("state")
	cookieValue := ""
	if cookieErr == nil {
		cookieValue = stateCookie.Value
	}
	if !validOAuthState(cookieValue, state) {
		writeJSONError(w, http.StatusForbidden, "invalid OAuth state")
		return
	}
	installTargetOrgID := ""
	if d.Queries != nil {
		loginState, err := d.Queries.ConsumeOAuthLoginStateDetails(r.Context(), auth.HashToken(state))
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if loginState == nil {
			writeJSONError(w, http.StatusForbidden, "OAuth state already used or expired")
			return
		}
		if loginState.TargetOrgID != nil {
			installTargetOrgID = *loginState.TargetOrgID
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "__auth_state",
		Value:    "",
		Path:     "/auth",
		MaxAge:   -1,
		HttpOnly: true,
	})

	code := r.URL.Query().Get("code")
	if code == "" {
		writeJSONError(w, http.StatusBadRequest, "missing code parameter")
		return
	}
	identity, err := d.provider().ExchangeCode(r.Context(), code)
	if err != nil {
		slog.Warn("identity provider code exchange failed", "provider", d.provider().Name(), "error", err)
		writeJSONError(w, http.StatusBadGateway, "authentication failed")
		return
	}

	var user *db.User
	if d.cloudAuthEnabled() {
		userID, _, err := d.Queries.ProvisionFromIdentity(r.Context(), identity)
		if err != nil {
			slog.Error("cloud identity provisioning failed", "error", err)
			writeJSONError(w, http.StatusConflict, "could not provision identity")
			return
		}
		user, err = d.Queries.GetUserByID(r.Context(), userID)
		if err != nil || user == nil {
			writeJSONError(w, http.StatusInternalServerError, "could not load provisioned user")
			return
		}
	} else {
		user, err = d.provisionGitHubIdentity(r, identity)
		if err != nil {
			slog.Error("GitHub identity provisioning failed", "error", err)
			writeJSONError(w, http.StatusConflict, "could not provision identity")
			return
		}
	}

	if err := d.applyCombinedGitHubInstallation(r, user, identity, installTargetOrgID); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	// A matching pending record means this callback belongs to a CLI PKCE flow.
	pending, err := d.Queries.ConsumeCLIPKCERequest(r.Context(), auth.HashToken(state))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if pending != nil {
		rawCode, codeHash, err := auth.GenerateAuthCode()
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if err := d.Queries.StoreAuthorizationCode(r.Context(), user.ID, codeHash,
			pending.CodeChallenge, pending.CodeChallengeMethod, pending.RedirectURI,
			pending.ClientID, time.Now().Add(authCodeTTL)); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		redirectURL := fmt.Sprintf("%s?code=%s&state=%s", pending.RedirectURI,
			url.QueryEscape(rawCode), url.QueryEscape(pending.OAuthState))
		http.Redirect(w, r, redirectURL, http.StatusFound)
		return
	}

	sessionOrgID := user.OrgID
	if installTargetOrgID != "" {
		sessionOrgID = installTargetOrgID
	}
	accessToken, err := auth.SignAccessToken(d.JWTSecret, user.ID, sessionOrgID, user.Email)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to sign token")
		return
	}
	rawRefresh, hashRefresh, err := auth.GenerateRefreshToken()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to generate refresh token")
		return
	}
	if err := d.Queries.StoreRefreshToken(r.Context(), user.ID, hashRefresh, uuid.NewString(), sessionOrgID, time.Now().Add(refreshTokenTTL)); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store refresh token")
		return
	}
	setAuthCookies(w, r, accessToken, rawRefresh)
	http.Redirect(w, r, d.DashboardOrigin+"/auth/complete", http.StatusFound)
}

func (d *Dependencies) GitHubOAuthCallback(w http.ResponseWriter, r *http.Request) {
	d.OAuthLoginCallback(w, r)
}

func (d *Dependencies) provisionGitHubIdentity(r *http.Request, identity auth.Identity) (*db.User, error) {
	githubID, err := strconv.ParseInt(identity.ProviderSubject, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid GitHub subject: %w", err)
	}
	userID, err := d.Queries.GetUserIDByIdentity(r.Context(), "github", identity.ProviderSubject)
	if err != nil {
		return nil, err
	}
	var user *db.User
	if userID != "" {
		user, err = d.Queries.GetUserByID(r.Context(), userID)
	} else {
		user, err = d.Queries.GetUserByGitHubID(r.Context(), githubID)
	}
	if err != nil {
		return nil, err
	}
	if user == nil {
		existing, err := d.Queries.GetUserByEmail(r.Context(), identity.Email)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			if !identity.EmailVerified {
				return nil, fmt.Errorf("unverified GitHub email cannot link an existing account")
			}
			if err := d.Queries.LinkUserGitHub(r.Context(), existing.ID, githubID, identity.Username, identity.AvatarURL); err != nil {
				return nil, err
			}
			user = existing
		} else {
			// Fail closed: never create an account for an unverified email, or an
			// attacker can seed an org under a victim's address and be adopted into
			// it when the victim later signs in with their verified email.
			if !identity.EmailVerified {
				return nil, fmt.Errorf("unverified GitHub email cannot create an account")
			}
			org, err := d.Queries.CreateOrg(r.Context(), identity.Username)
			if err != nil {
				return nil, err
			}
			user, err = d.Queries.CreateUserGitHub(r.Context(), org.ID, identity.Email,
				identity.Name, githubID, identity.Username, identity.AvatarURL)
			if err != nil {
				return nil, err
			}
		}
	}
	if err := d.Queries.UpdateUserGitHub(r.Context(), user.ID, identity.Username, identity.AvatarURL, identity.Email); err != nil {
		slog.Warn("refresh GitHub profile failed", "user_id", user.ID, "error", err)
	}
	if err := d.Queries.UpsertIdentityDetails(r.Context(), user.ID, "github", identity.ProviderSubject, identity.Email, identity.EmailVerified); err != nil {
		return nil, err
	}
	user.Email = db.NormalizeEmail(identity.Email)
	return user, nil
}

func (d *Dependencies) applyCombinedGitHubInstallation(r *http.Request, user *db.User, identity auth.Identity, targetOrgID string) error {
	if d.provider().Name() != "github" || r.URL.Query().Get("setup_action") != "install" {
		return nil
	}
	installationIDText := r.URL.Query().Get("installation_id")
	if installationIDText == "" {
		return nil
	}
	installationID, err := strconv.ParseInt(installationIDText, 10, 64)
	if err != nil || installationID <= 0 {
		return fmt.Errorf("invalid installation_id")
	}
	if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
		return fmt.Errorf("GitHub App not configured")
	}
	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		return fmt.Errorf("generate GitHub App token: %w", err)
	}
	if _, err := gh.VerifyInstallation(appJWT, installationID); err != nil {
		return fmt.Errorf("invalid or unauthorized installation")
	}
	if identity.AccessToken == "" {
		return fmt.Errorf("cannot verify installation ownership")
	}
	userInstalls, err := gh.ListUserInstallations(identity.AccessToken)
	if err != nil {
		return fmt.Errorf("verify installation ownership: %w", err)
	}
	if !containsInstallation(userInstalls, installationID) {
		return fmt.Errorf("installation does not belong to the authenticated user")
	}
	orgID := user.OrgID
	if targetOrgID != "" {
		role, err := d.Queries.GetMembership(r.Context(), user.ID, targetOrgID)
		if err != nil {
			return fmt.Errorf("verify target organization membership: %w", err)
		}
		if role == "" {
			return fmt.Errorf("authenticated user is not a member of the target organization")
		}
		orgID = targetOrgID
	}
	return d.Queries.SetOrgGitHubInstallation(r.Context(), orgID, installationID)
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
		if d.Queries != nil {
			if err := d.Queries.StoreOAuthLoginStateForOrg(r.Context(), auth.HashToken(state), orgID, time.Now().Add(5*time.Minute)); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "internal error")
				return
			}
		}
		isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
		http.SetCookie(w, &http.Cookie{
			Name:     "__auth_state",
			Value:    state,
			Path:     "/auth",
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
