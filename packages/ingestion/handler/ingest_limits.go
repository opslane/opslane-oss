package handler

import (
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

// Per-project ingest rate limiters (requests/minute, in-memory, reset each minute).
// Public SDK keys ship in customer bundles and are not secret, so these cap burst
// abuse per project. Generous defaults: real apps stay well under them.
var (
	eventsLimiter     = newRateLimiter(600) // ~10 errors/sec sustained
	replaysLimiter    = newRateLimiter(120)
	sourcemapsLimiter = newRateLimiter(20)

	// Always-on recording: every session uploads a chunk every ~30s, and each
	// chunk costs 2 ingestion requests (upload-url + commit). The 120/min
	// replays budget is a whole-project budget and would cap a project at ~30
	// concurrent sessions. 6000/min supports ~1500 concurrent sessions per
	// replica; the byte budget below is the real ceiling.
	chunksLimiter = newRateLimiter(6000)

	// 512 MB/min/project of compressed chunks. A 30s chunk gzips to roughly
	// 200-800KB, so this is ~1000 concurrent sessions before shedding — far
	// above real load, but a hard stop on a storage flood (#48).
	chunkBytesBudget = newByteBudget(512 << 20)
)

// rateLimitByProject returns middleware that rate-limits by project_id set by
// AuthenticateSDK. It must be chained after AuthenticateSDK.
func rateLimitByProject(limiter *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			projectID := ProjectIDFromCtx(r.Context())
			if projectID == "" {
				writeJSONError(w, http.StatusUnauthorized, "missing project context")
				return
			}
			if !limiter.allow(projectID) {
				slog.Warn("ingest rate limit exceeded", "project_id", projectID, "path", r.URL.Path)
				writeJSONError(w, http.StatusTooManyRequests, "rate limit exceeded")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// EnforceOrigin rejects SDK ingest from origins not on the project's allowlist.
//
// This is the server-side control against stolen public SDK keys. CORS only
// constrains browsers, so the Origin header is validated after the key resolves
// to a project. Opt-in: an empty allowlist allows all origins for compatibility.
func (d *Dependencies) EnforceOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed := AllowedOriginsFromCtx(r.Context())
		if len(allowed) == 0 {
			next.ServeHTTP(w, r)
			return
		}

		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = originFromReferer(r.Header.Get("Referer"))
		}
		if !originAllowed(origin, allowed) {
			slog.Warn("ingest rejected: origin not allowlisted",
				"project_id", ProjectIDFromCtx(r.Context()), "origin", origin)
			writeJSONError(w, http.StatusForbidden, "origin not allowed")
			return
		}

		next.ServeHTTP(w, r)
	})
}

func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	origin = strings.ToLower(origin)
	for _, a := range allowed {
		if origin == strings.ToLower(a) {
			return true
		}
	}
	return false
}

func originFromReferer(referer string) string {
	if referer == "" {
		return ""
	}
	u, err := url.Parse(referer)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}
