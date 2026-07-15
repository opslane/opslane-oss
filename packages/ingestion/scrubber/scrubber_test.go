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
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sessions WHERE project_id=$1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM environments WHERE project_id=$1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM projects WHERE id=$1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM orgs WHERE id=$1`, orgID)
	})
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
		`UPDATE session_chunks SET uploaded_at = '1900-01-01'::timestamptz WHERE session_id = $1`, sessionID); err != nil {
		t.Fatalf("age chunk policy: %v", err)
	}
}

func TestScrubber_RecordsNullableEventBounds(t *testing.T) {
	tests := []struct {
		name      string
		raw       []byte
		wantFirst *int64
		wantLast  *int64
	}{
		{name: "empty events", raw: []byte(`{"events":[],"meta":{}}`)},
		{name: "malformed event does not discard valid timestamp", raw: []byte(`{"events":[{"type":2},{"timestamp":"x"},{"type":3,"timestamp":2000}],"meta":{}}`), wantFirst: scrubInt64(2000), wantLast: scrubInt64(2000)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, q, mc, pool := setup(t)
			ctx := context.Background()
			sessionID, projectID, key := seedChunk(t, q, pool)
			t.Cleanup(func() { _ = mc.RemoveObject(context.Background(), key) })
			compressed, err := compress.Deflate(tt.raw)
			if err != nil {
				t.Fatalf("deflate: %v", err)
			}
			if err := mc.PutObject(ctx, key, compressed, "application/gzip"); err != nil {
				t.Fatalf("seed object: %v", err)
			}
			if err := q.CommitChunk(ctx, sessionID, projectID, 0, int64(len(compressed))); err != nil {
				t.Fatalf("commit: %v", err)
			}
			ageChunkPolicy(t, pool, sessionID)
			scrubbed, failed, err := s.RunOnce(ctx)
			if err != nil || scrubbed < 1 {
				t.Fatalf("RunOnce scrubbed=%d failed=%d err=%v", scrubbed, failed, err)
			}
			var first, last *int64
			var decoded int64
			if err := pool.QueryRow(ctx,
				`SELECT first_event_ms, last_event_ms, decoded_size_bytes FROM session_chunks WHERE session_id=$1 AND seq=0`, sessionID,
			).Scan(&first, &last, &decoded); err != nil {
				t.Fatalf("read metadata: %v", err)
			}
			assertScrubOptionalInt64(t, "first", first, tt.wantFirst)
			assertScrubOptionalInt64(t, "last", last, tt.wantLast)
			if decoded != int64(len(tt.raw)) {
				t.Fatalf("decoded_size_bytes=%d, want %d", decoded, len(tt.raw))
			}
		})
	}
}

func scrubInt64(value int64) *int64 { return &value }

func assertScrubOptionalInt64(t *testing.T, field string, got, want *int64) {
	t.Helper()
	if got == nil || want == nil {
		if got != nil || want != nil {
			t.Fatalf("%s=%v, want %v", field, got, want)
		}
		return
	}
	if *got != *want {
		t.Fatalf("%s=%d, want %d", field, *got, *want)
	}
}

func TestScrubber_RedactsSecretsAndMarksScrubbed(t *testing.T) {
	s, q, mc, pool := setup(t)
	ctx := context.Background()
	sid, projectID, key := seedChunk(t, q, pool)
	t.Cleanup(func() { _ = mc.RemoveObject(context.Background(), key) })
	raw := []byte(`{"events":[{"type":4,"timestamp":1000},{"type":5,"timestamp":5000,"data":{"headers":{"authorization":"Bearer sk_live_SUPERSECRET"}}}]}`)
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
	if err != nil || scrubbed < 1 {
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
	var firstEventMs, lastEventMs *int64
	var decodedSizeBytes *int64
	if err := pool.QueryRow(ctx,
		`SELECT first_event_ms, last_event_ms, decoded_size_bytes
		   FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
	).Scan(&firstEventMs, &lastEventMs, &decodedSizeBytes); err != nil {
		t.Fatalf("read chunk metadata: %v", err)
	}
	if firstEventMs == nil || *firstEventMs != 1000 || lastEventMs == nil || *lastEventMs != 5000 {
		t.Fatalf("event bounds = %v/%v, want 1000/5000", firstEventMs, lastEventMs)
	}
	if decodedSizeBytes == nil || *decodedSizeBytes != int64(len(raw)) {
		t.Fatalf("decoded_size_bytes = %v, want %d", decodedSizeBytes, len(raw))
	}
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
