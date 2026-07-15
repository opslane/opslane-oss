package scrubber_test

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/compress"
	"github.com/opslane/opslane/packages/ingestion/db"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
	"github.com/opslane/opslane/packages/ingestion/scrubber"
)

func setup(t *testing.T) (*scrubber.Scrubber, *db.Queries, *minioPkg.Client, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	endpoint := os.Getenv("REPLAY_STORE_ENDPOINT")
	if dsn == "" || endpoint == "" {
		t.Skip("DATABASE_URL / REPLAY_STORE_ENDPOINT not set; skipping integration test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	q := db.New(pool)
	mc, err := minioPkg.New(endpoint, os.Getenv("REPLAY_STORE_PUBLIC_ENDPOINT"),
		os.Getenv("REPLAY_STORE_ACCESS_KEY"), os.Getenv("REPLAY_STORE_SECRET_KEY"),
		os.Getenv("REPLAY_STORE_BUCKET"), os.Getenv("REPLAY_STORE_REGION"))
	if err != nil {
		t.Fatalf("minio: %v", err)
	}
	return &scrubber.Scrubber{Q: q, MinIO: mc, MaxInflateBytes: 20 << 20}, q, mc, pool
}

func seedChunk(t *testing.T, q *db.Queries, pool *pgxpool.Pool) (sessionID, projectID, key string) {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("scrub-%d", time.Now().UnixNano())
	var orgID, envID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, name).Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, $2) RETURNING id`, orgID, name).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, projectID).Scan(&envID); err != nil {
		t.Fatalf("seed environment: %v", err)
	}
	sessionID = fmt.Sprintf("sess_%d", time.Now().UnixNano())
	key = fmt.Sprintf("sessions/%s/%s/chunk-000000.json.gz", projectID, sessionID)
	if err := q.InsertSession(ctx, sessionID, projectID, envID, nil, time.Now(), "https://example.test"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sessionID, projectID, 0, key, true); err != nil {
		t.Fatalf("reserve chunk: %v", err)
	}
	return sessionID, projectID, key
}

func readScrubbedAt(t *testing.T, pool *pgxpool.Pool, sessionID string) time.Time {
	t.Helper()
	var at *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT scrubbed_at FROM session_chunks WHERE session_id=$1 AND seq=0`, sessionID).Scan(&at); err != nil {
		t.Fatalf("read scrubbed_at: %v", err)
	}
	if at == nil {
		t.Fatal("chunk is not scrubbed")
	}
	return *at
}

func ageChunkPolicy(t *testing.T, pool *pgxpool.Pool, sessionID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE session_chunks SET uploaded_at = now() - interval '31 seconds' WHERE session_id = $1`, sessionID); err != nil {
		t.Fatalf("age chunk policy: %v", err)
	}
}

func TestScrubber_RedactsSecretsAndMarksScrubbed(t *testing.T) {
	s, q, mc, pool := setup(t)
	ctx := context.Background()
	sid, projectID, key := seedChunk(t, q, pool)
	t.Cleanup(func() { _ = mc.RemoveObject(context.Background(), key) })
	raw := []byte(`{"events":[{"type":5,"data":{"headers":{"authorization":"Bearer sk_live_SUPERSECRET"}}}]}`)
	gz, err := compress.Deflate(raw)
	if err != nil {
		t.Fatalf("deflate: %v", err)
	}
	if err := mc.PutObject(ctx, key, gz, "application/gzip"); err != nil {
		t.Fatalf("seed object: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 0, int64(len(gz))); err != nil {
		t.Fatalf("commit: %v", err)
	}
	ageChunkPolicy(t, pool, sid)

	scrubbed, failed, err := s.RunOnce(ctx)
	if err != nil || scrubbed < 1 || failed != 0 {
		t.Fatalf("RunOnce scrubbed=%d failed=%d err=%v", scrubbed, failed, err)
	}
	stored, err := mc.GetObject(ctx, key)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	plain, err := compress.InflateLimited(bytes.NewReader(stored), 20<<20)
	if err != nil {
		t.Fatalf("inflate stored: %v", err)
	}
	if strings.Contains(string(plain), "sk_live_SUPERSECRET") {
		t.Fatal("secret survived scrubbing")
	}
	_ = readScrubbedAt(t, pool, sid)
}

func TestScrubber_RejectsGzipBombAndLeavesItUnreadable(t *testing.T) {
	s, q, mc, pool := setup(t)
	ctx := context.Background()
	sid, projectID, key := seedChunk(t, q, pool)
	s.MaxInflateBytes = 1 << 20
	bomb, err := compress.Deflate(bytes.Repeat([]byte("A"), 50<<20))
	if err != nil {
		t.Fatalf("build bomb: %v", err)
	}
	if err := mc.PutObject(ctx, key, bomb, "application/gzip"); err != nil {
		t.Fatalf("seed bomb: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 0, int64(len(bomb))); err != nil {
		t.Fatalf("commit: %v", err)
	}
	ageChunkPolicy(t, pool, sid)
	_, failed, err := s.RunOnce(ctx)
	if err != nil || failed < 1 {
		t.Fatalf("RunOnce failed=%d err=%v", failed, err)
	}
	var scrubbedAt *time.Time
	var scrubErr *string
	if err := pool.QueryRow(ctx, `SELECT scrubbed_at, scrub_error FROM session_chunks WHERE session_id=$1 AND seq=0`, sid).Scan(&scrubbedAt, &scrubErr); err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	if scrubbedAt != nil || scrubErr == nil {
		t.Fatalf("fail-closed fields scrubbed_at=%v scrub_error=%v", scrubbedAt, scrubErr)
	}
	if _, err := mc.StatObject(ctx, key); err == nil {
		t.Fatal("gzip bomb object still exists")
	}
}

func TestScrubber_IsIdempotent(t *testing.T) {
	s, q, mc, pool := setup(t)
	ctx := context.Background()
	sid, projectID, key := seedChunk(t, q, pool)
	t.Cleanup(func() { _ = mc.RemoveObject(context.Background(), key) })
	gz, _ := compress.Deflate([]byte(`{"events":[]}`))
	if err := mc.PutObject(ctx, key, gz, "application/gzip"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 0, int64(len(gz))); err != nil {
		t.Fatalf("commit: %v", err)
	}
	ageChunkPolicy(t, pool, sid)
	if _, _, err := s.RunOnce(ctx); err != nil {
		t.Fatalf("first run: %v", err)
	}
	before := readScrubbedAt(t, pool, sid)
	if _, _, err := s.RunOnce(ctx); err != nil {
		t.Fatalf("second run: %v", err)
	}
	after := readScrubbedAt(t, pool, sid)
	if !before.Equal(after) {
		t.Fatal("second pass re-scrubbed the chunk")
	}
}
