package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
	"github.com/opslane/opslane/packages/ingestion/retention"
	"github.com/opslane/opslane/packages/ingestion/scrubber"
)

func main() {
	// Set up structured JSON logging as the default logger.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx)
	if err != nil {
		slog.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Initialize MinIO client for replay/sourcemap storage.
	// Don't fatal on error — ingestion can work without MinIO for events-only mode.
	var minioClient *minioPkg.Client
	minioEndpoint := os.Getenv("REPLAY_STORE_ENDPOINT")
	if minioEndpoint != "" {
		var err2 error
		minioClient, err2 = minioPkg.New(
			minioEndpoint,
			os.Getenv("REPLAY_STORE_PUBLIC_ENDPOINT"),
			os.Getenv("REPLAY_STORE_ACCESS_KEY"),
			os.Getenv("REPLAY_STORE_SECRET_KEY"),
			os.Getenv("REPLAY_STORE_BUCKET"),
			os.Getenv("REPLAY_STORE_REGION"),
		)
		if err2 != nil {
			slog.Error("Failed to create MinIO client", "error", err2)
		} else {
			slog.Info("MinIO client initialized",
				"endpoint", minioEndpoint,
				"bucket", os.Getenv("REPLAY_STORE_BUCKET"))
		}
	} else {
		slog.Warn("REPLAY_STORE_ENDPOINT not set — replay/sourcemap uploads disabled")
	}

	// JWT secret for session auth — fail-fast if missing or weak.
	jwtSecret := os.Getenv("JWT_SECRET")
	if len(jwtSecret) < 32 {
		slog.Error("JWT_SECRET must be set and at least 32 bytes", "length", len(jwtSecret))
		os.Exit(1)
	}

	// GitHub App OAuth — optional for dev environments without GitHub App.
	githubAppID := os.Getenv("GITHUB_APP_ID")
	githubAppClientID := os.Getenv("GITHUB_APP_CLIENT_ID")
	githubAppClientSecret := os.Getenv("GITHUB_APP_CLIENT_SECRET")
	githubAppPrivateKeyRaw := os.Getenv("GITHUB_APP_PRIVATE_KEY")
	githubAppSlug := os.Getenv("GITHUB_APP_SLUG")
	dashboardOrigin := os.Getenv("DASHBOARD_ORIGIN")
	if dashboardOrigin == "" {
		dashboardOrigin = "http://localhost:3000"
	}

	var githubAppPrivateKey []byte
	if githubAppPrivateKeyRaw != "" {
		githubAppPrivateKey = []byte(githubAppPrivateKeyRaw)
	}

	if githubAppClientID == "" || githubAppClientSecret == "" {
		slog.Warn("GITHUB_APP_CLIENT_ID/SECRET not set — GitHub OAuth login disabled")
	}

	queries := db.New(pool)
	deps := &handler.Dependencies{
		Queries:               queries,
		MinIO:                 minioClient,
		JWTSecret:             []byte(jwtSecret),
		GitHubAppID:           githubAppID,
		GitHubAppClientID:     githubAppClientID,
		GitHubAppClientSecret: githubAppClientSecret,
		GitHubAppPrivateKey:   githubAppPrivateKey,
		GitHubAppSlug:         githubAppSlug,
		DashboardOrigin:       dashboardOrigin,
		AdminEmails:           handler.ParseAdminEmails(os.Getenv("ADMIN_EMAILS")),
	}
	r := handler.NewRouterWithPool(deps, pool)

	// Periodic cleanup of expired/revoked refresh tokens and auth codes
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			deleted, codes, err := queries.CleanupExpiredTokens(context.Background())
			if err != nil {
				slog.Error("token cleanup failed", "error", err)
			} else if deleted > 0 || codes > 0 {
				slog.Info("token cleanup", "refresh_deleted", deleted, "codes_deleted", codes)
			}

			expired, sessErr := queries.ExpireAgentSessions(context.Background())
			if sessErr != nil {
				slog.Error("agent session cleanup failed", "error", sessErr)
			} else if expired > 0 {
				slog.Info("agent session cleanup", "expired", expired)
			}
		}
	}()

	// Raw chunks are fail-closed until this pass overwrites them with redacted
	// bytes and stamps scrubbed_at. Every replica runs a scrubber; claims use
	// FOR UPDATE SKIP LOCKED to avoid duplicate work.
	if minioClient != nil {
		s := &scrubber.Scrubber{Q: queries, MinIO: minioClient}
		go s.Start(context.Background(), 15*time.Second)
		slog.Info("chunk scrubber started")

		sweeper := &retention.Sweeper{Q: queries, MinIO: minioClient}
		if v := os.Getenv("SESSION_IDLE_CLOSE_MINUTES"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				sweeper.IdleCloseMinutes = parsed
			}
		}
		sweepInterval := time.Hour
		if v := os.Getenv("RETENTION_SWEEP_INTERVAL_SECONDS"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				sweepInterval = time.Duration(parsed) * time.Second
			}
		}
		go sweeper.Start(context.Background(), sweepInterval)
		slog.Info("retention sweeper started", "interval", sweepInterval.String())
	}

	slog.Info("Opslane ingestion starting", "port", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%s", port), r); err != nil {
		slog.Error("Server failed", "error", err)
		os.Exit(1)
	}
}
