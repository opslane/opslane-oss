package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

// startTime records when the service started, for uptime calculation.
var startTime time.Time

func init() {
	startTime = time.Now()
}

// CheckResult represents the result of a single health check.
type CheckResult struct {
	Status    string  `json:"status"`
	LatencyMs float64 `json:"latency_ms,omitempty"`
	Error     string  `json:"error,omitempty"`
}

// HealthResponse is the comprehensive health check response.
type HealthResponse struct {
	Status        string                 `json:"status"`
	Checks        map[string]CheckResult `json:"checks"`
	Version       string                 `json:"version"`
	UptimeSeconds int64                  `json:"uptime_seconds"`
}

// HealthChecker holds dependencies needed for health checks.
type HealthChecker struct {
	pool    *pgxpool.Pool
	minio   *minioPkg.Client
	version string
}

// NewHealthChecker creates a health checker with the given dependencies.
func NewHealthChecker(pool *pgxpool.Pool, mc *minioPkg.Client) *HealthChecker {
	version := os.Getenv("VERSION")
	if version == "" {
		version = "dev"
	}

	return &HealthChecker{
		pool:    pool,
		minio:   mc,
		version: version,
	}
}

// Handler returns the HTTP handler for the enhanced /health endpoint.
func (hc *HealthChecker) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		checks := make(map[string]CheckResult)

		// Check database
		dbCheck := hc.checkDatabase(r.Context())
		checks["database"] = dbCheck

		// Check S3-compatible storage (if configured)
		if hc.minio != nil {
			minioCheck := hc.checkMinio(r.Context())
			checks["minio"] = minioCheck
		}

		// Determine overall status
		overallStatus := "ok"
		for name, check := range checks {
			if check.Status == "unhealthy" {
				// Database down = unhealthy; minio down = degraded
				if name == "database" {
					overallStatus = "unhealthy"
					break
				}
				if overallStatus != "unhealthy" {
					overallStatus = "degraded"
				}
			}
		}

		resp := HealthResponse{
			Status:        overallStatus,
			Checks:        checks,
			Version:       hc.version,
			UptimeSeconds: int64(time.Since(startTime).Seconds()),
		}

		httpStatus := http.StatusOK
		if overallStatus == "unhealthy" {
			httpStatus = http.StatusServiceUnavailable
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(httpStatus)
		json.NewEncoder(w).Encode(resp)
	}
}

func (hc *HealthChecker) checkDatabase(ctx context.Context) CheckResult {
	if hc.pool == nil {
		return CheckResult{Status: "unhealthy", Error: "no database pool configured"}
	}

	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	start := time.Now()
	err := hc.pool.Ping(checkCtx)
	latencyMs := float64(time.Since(start).Microseconds()) / 1000.0

	if err != nil {
		return CheckResult{Status: "unhealthy", LatencyMs: latencyMs, Error: err.Error()}
	}
	return CheckResult{Status: "ok", LatencyMs: latencyMs}
}

func (hc *HealthChecker) checkMinio(ctx context.Context) CheckResult {
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	start := time.Now()
	exists, err := hc.minio.BucketExists(checkCtx)
	latencyMs := float64(time.Since(start).Microseconds()) / 1000.0

	if err != nil {
		return CheckResult{Status: "unhealthy", LatencyMs: latencyMs, Error: err.Error()}
	}
	if !exists {
		return CheckResult{Status: "unhealthy", LatencyMs: latencyMs, Error: "bucket not found"}
	}
	return CheckResult{Status: "ok", LatencyMs: latencyMs}
}
