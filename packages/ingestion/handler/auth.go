package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

// contextKey is an unexported type for context keys in this package.
type contextKey int

const (
	ctxProjectID contextKey = iota
	ctxEnvironmentID
	ctxOrgID
	ctxRequestID
	ctxUserID
	ctxAllowedOrigins
	ctxRole
)

// ProjectIDFromCtx extracts the project_id set by auth middleware.
func ProjectIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(ctxProjectID).(string)
	return v
}

// EnvironmentIDFromCtx extracts the environment_id set by auth middleware.
func EnvironmentIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(ctxEnvironmentID).(string)
	return v
}

// OrgIDFromCtx extracts the org_id set by auth middleware.
func OrgIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(ctxOrgID).(string)
	return v
}

// UserIDFromCtx extracts the user_id set by session auth middleware.
func UserIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(ctxUserID).(string)
	return v
}

// RoleFromCtx returns the current database-backed membership role. JWT claims
// are never used for authorization decisions.
func RoleFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(ctxRole).(string)
	return v
}

// AllowedOriginsFromCtx extracts the project's origin allowlist set by AuthenticateSDK.
// A nil/empty slice means no allowlist is configured (allow all).
func AllowedOriginsFromCtx(ctx context.Context) []string {
	v, _ := ctx.Value(ctxAllowedOrigins).([]string)
	return v
}

// Dependencies holds shared service dependencies (DB, etc.) for handlers.
type Dependencies struct {
	Queries *db.Queries
	// resetSessionStore is a narrow test seam for password-reset session
	// revocation. Production falls back to Queries.
	resetSessionStore passwordResetSessionStore
	Health            *HealthChecker
	MinIO             *minioPkg.Client
	JWTSecret         []byte
	// AuthProvider is selected explicitly at boot. Nil retains the OSS GitHub
	// default for narrow tests that construct Dependencies directly.
	AuthProvider       auth.AuthProvider
	AuthCallbackOrigin string
	// GitHub App OAuth
	GitHubAppID           string
	GitHubAppClientID     string
	GitHubAppClientSecret string
	GitHubAppPrivateKey   []byte // PEM-encoded RSA private key
	GitHubAppSlug         string
	DashboardOrigin       string // e.g. "http://localhost:3000"
	AdminEmails           map[string]struct{}
}

func (d *Dependencies) provider() auth.AuthProvider {
	if d.AuthProvider != nil {
		return d.AuthProvider
	}
	return auth.GitHubProvider{ClientID: d.GitHubAppClientID, ClientSecret: d.GitHubAppClientSecret}
}

func (d *Dependencies) cloudAuthEnabled() bool {
	return d.provider().Name() == "workos"
}

// ParseAdminEmails normalizes the comma-separated ADMIN_EMAILS allowlist.
// An empty result disables all admin-only routes.
func ParseAdminEmails(value string) map[string]struct{} {
	emails := make(map[string]struct{})
	for _, email := range strings.Split(value, ",") {
		email = strings.ToLower(strings.TrimSpace(email))
		if email != "" {
			emails[email] = struct{}{}
		}
	}
	return emails
}

func (d *Dependencies) isAdminEmail(email string) bool {
	if len(d.AdminEmails) == 0 {
		return false
	}
	_, ok := d.AdminEmails[strings.ToLower(strings.TrimSpace(email))]
	return ok
}

// RequireAdmin hides the cross-tenant operator surface from normal users.
// It must run after AuthenticateSession so ctxUserID is trustworthy.
// A DB failure is a 500, not a 404: the client treats 404 as "not an admin"
// and would silently evict a real operator on a transient database blip.
func (d *Dependencies) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(d.AdminEmails) == 0 {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		user, err := d.Queries.GetUserByID(r.Context(), UserIDFromCtx(r.Context()))
		if err != nil {
			slog.Error("admin: load user for allowlist check failed", "error", err)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if user == nil || !d.isAdminEmail(user.Email) {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AuthenticateSDK resolves environment API key -> environment -> project -> org.
// Returns project_id and environment_id in context, or 401.
func (d *Dependencies) AuthenticateSDK(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiKey := r.Header.Get("X-API-Key")
		if apiKey == "" {
			writeJSONError(w, http.StatusUnauthorized, "missing X-API-Key header")
			return
		}

		lookup, err := d.Queries.LookupAPIKey(r.Context(), apiKey)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "invalid or revoked API key")
			return
		}

		ctx := r.Context()
		ctx = context.WithValue(ctx, ctxProjectID, lookup.ProjectID)
		ctx = context.WithValue(ctx, ctxEnvironmentID, lookup.EnvironmentID)
		ctx = context.WithValue(ctx, ctxOrgID, lookup.OrgID)
		ctx = context.WithValue(ctx, ctxAllowedOrigins, lookup.AllowedOrigins)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// AuthenticateSessionOrSDK accepts either JWT session auth (Authorization: Bearer)
// or SDK API key auth (X-API-Key). Prefers SDK auth when X-API-Key is present.
// Used for endpoints that both the dashboard (session) and CLI (API key) need.
func (d *Dependencies) AuthenticateSessionOrSDK(next http.Handler) http.Handler {
	sdkHandler := d.AuthenticateSDK(next)
	sessionHandler := d.AuthenticateUserSession(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "" {
			sdkHandler.ServeHTTP(w, r)
			return
		}
		sessionHandler.ServeHTTP(w, r)
	})
}

// AuthenticateUserSession authenticates a local session and, in cloud mode,
// immediately re-checks active membership so removals and downgrades take effect.
func (d *Dependencies) AuthenticateUserSession(next http.Handler) http.Handler {
	if !d.cloudAuthEnabled() {
		return d.AuthenticateSession(next)
	}
	return d.AuthenticateSession(d.RequireMembership(next))
}

// AuthenticateSession validates a session token and sets ctxUserID + ctxOrgID.
// Session auth is org-scoped (no project/environment in context).
func (d *Dependencies) AuthenticateSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Prefer the httpOnly cookie (dashboard); fall back to Bearer (CLI).
		tokenStr := ""
		if c, err := r.Cookie(AccessCookieName); err == nil && c.Value != "" {
			tokenStr = c.Value
		} else if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			tokenStr = strings.TrimPrefix(header, "Bearer ")
		}
		if tokenStr == "" {
			writeJSONError(w, http.StatusUnauthorized, "missing or invalid credentials")
			return
		}

		claims, err := auth.ValidateToken(d.JWTSecret, tokenStr)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}

		ctx := r.Context()
		ctx = context.WithValue(ctx, ctxUserID, claims.Sub)
		ctx = context.WithValue(ctx, ctxOrgID, claims.OrgID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireMembership loads the current role for the active org from Postgres.
// It must run after AuthenticateSession.
func (d *Dependencies) RequireMembership(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := UserIDFromCtx(r.Context())
		orgID := OrgIDFromCtx(r.Context())
		if userID == "" || orgID == "" {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		role, err := d.Queries.GetMembership(r.Context(), userID, orgID)
		if err != nil {
			slog.Error("load current membership failed", "error", err, "user_id", userID, "org_id", orgID)
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if role == "" {
			writeJSONError(w, http.StatusForbidden, "organization membership required")
			return
		}
		ctx := context.WithValue(r.Context(), ctxRole, role)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireRole enforces the owner >= admin >= member hierarchy using only the
// current role populated by RequireMembership.
func (d *Dependencies) RequireRole(required string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !d.cloudAuthEnabled() {
				writeJSONError(w, http.StatusNotFound, "not found")
				return
			}
			if !auth.RoleSatisfies(RoleFromCtx(r.Context()), required) {
				writeJSONError(w, http.StatusForbidden, "insufficient organization role")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
