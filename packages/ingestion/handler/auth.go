package handler

import (
	"context"
	"encoding/json"
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

// AllowedOriginsFromCtx extracts the project's origin allowlist set by AuthenticateSDK.
// A nil/empty slice means no allowlist is configured (allow all).
func AllowedOriginsFromCtx(ctx context.Context) []string {
	v, _ := ctx.Value(ctxAllowedOrigins).([]string)
	return v
}

// Dependencies holds shared service dependencies (DB, etc.) for handlers.
type Dependencies struct {
	Queries   *db.Queries
	Health    *HealthChecker
	MinIO     *minioPkg.Client
	JWTSecret []byte
	// GitHub App OAuth
	GitHubAppID           string
	GitHubAppClientID     string
	GitHubAppClientSecret string
	GitHubAppPrivateKey   []byte // PEM-encoded RSA private key
	GitHubAppSlug         string
	DashboardOrigin       string // e.g. "http://localhost:3000"
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
	sessionHandler := d.AuthenticateSession(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "" {
			sdkHandler.ServeHTTP(w, r)
			return
		}
		sessionHandler.ServeHTTP(w, r)
	})
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
