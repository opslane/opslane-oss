package handler

import (
	"net/http"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

const (
	AccessCookieName  = "__opslane_at"
	RefreshCookieName = "__opslane_rt"
)

// CSRF note: auth cookies are SameSite=Lax, so browsers do not send them on
// cross-site POST/PUT/PATCH/DELETE. Credentialed CORS is restricted to
// DASHBOARD_ORIGIN. The remaining known gap is GET /api/v1/github/setup, which
// mutates org state on a top-level navigation; Project B owns OAuth-state
// validation for that GitHub install callback.

func isSecureRequest(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

func setAuthCookies(w http.ResponseWriter, r *http.Request, accessToken, refreshToken string) {
	secure := isSecureRequest(r)
	http.SetCookie(w, &http.Cookie{
		Name:     AccessCookieName,
		Value:    accessToken,
		Path:     "/",
		MaxAge:   int(auth.DefaultAccessTokenTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     RefreshCookieName,
		Value:    refreshToken,
		Path:     "/",
		MaxAge:   int(refreshTokenTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearAuthCookies(w http.ResponseWriter, r *http.Request) {
	secure := isSecureRequest(r)
	for _, name := range []string{AccessCookieName, RefreshCookieName} {
		http.SetCookie(w, &http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		})
	}
}
