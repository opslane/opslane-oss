package db_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func sessionTestQueries(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	pool := testPool(t)
	return db.New(pool), pool
}

func seedSessionProject(t *testing.T, pool *pgxpool.Pool) (projectID, envID string) {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("t-%s-%d", t.Name(), time.Now().UnixNano())

	var orgID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, name).Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name) VALUES ($1, $2) RETURNING id`, orgID, name,
	).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, projectID,
	).Scan(&envID); err != nil {
		t.Fatalf("seed environment: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM session_tombstones WHERE project_id = $1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sessions WHERE project_id = $1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM end_users WHERE project_id = $1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM environments WHERE project_id = $1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM projects WHERE id = $1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM orgs WHERE id = $1`, orgID)
	})
	return projectID, envID
}

func newSessionID(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf("sess_%d", time.Now().UnixNano())
}

func TestInsertSession_AndScopedLookup(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	otherProjectID, _ := seedSessionProject(t, pool)
	sid := newSessionID(t)

	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://app.example.com/x"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	ok, err := q.SessionBelongsToProject(ctx, sid, projectID)
	if err != nil || !ok {
		t.Fatalf("SessionBelongsToProject(owner) = %v, %v; want true, nil", ok, err)
	}
	ok, err = q.SessionBelongsToProject(ctx, sid, otherProjectID)
	if err != nil || ok {
		t.Fatalf("cross-tenant lookup = %v, %v; want false, nil", ok, err)
	}
}

func TestInsertSession_IsIdempotent(t *testing.T) {
	q, pool := sessionTestQueries(t)
	projectID, envID := seedSessionProject(t, pool)
	sid := newSessionID(t)
	start := time.Now()
	for i := 0; i < 2; i++ {
		if err := q.InsertSession(context.Background(), sid, projectID, envID, nil, start, "https://a"); err != nil {
			t.Fatalf("insert %d: %v", i+1, err)
		}
	}
}

func TestReserveChunkSeq_RejectsDuplicateSeq(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sid := newSessionID(t)
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://a"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 0, "sessions/p/s/chunk-000000.json.gz", true); err != nil {
		t.Fatalf("first reserve: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 0, "sessions/p/s/chunk-000000.json.gz", true); err != db.ErrChunkSeqTaken {
		t.Fatalf("duplicate seq returned %v, want ErrChunkSeqTaken", err)
	}
}

func TestCommitChunk_SetsSizeAndUpdatesSession(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sid := newSessionID(t)
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://a"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 0, "k0", true); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 0, 4096); err != nil {
		t.Fatalf("commit: %v", err)
	}

	var size int64
	var uploadedAt, scrubbedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT size_bytes, uploaded_at, scrubbed_at FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
	).Scan(&size, &uploadedAt, &scrubbedAt); err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	if size != 4096 || uploadedAt == nil || scrubbedAt != nil {
		t.Fatalf("chunk = size %d, uploaded %v, scrubbed %v; want 4096, non-nil, nil", size, uploadedAt, scrubbedAt)
	}

	var chunkCount int
	var bytesStored int64
	var lastChunkAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT chunk_count, bytes_stored, last_chunk_at FROM sessions WHERE id=$1`, sid,
	).Scan(&chunkCount, &bytesStored, &lastChunkAt); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if chunkCount != 1 || bytesStored != 4096 || lastChunkAt == nil {
		t.Fatalf("session rollup = count %d, bytes %d, last %v", chunkCount, bytesStored, lastChunkAt)
	}
}

func TestCommitChunk_IsTenantScoped(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	otherProjectID, _ := seedSessionProject(t, pool)
	sid := newSessionID(t)
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://a"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 0, "k0", true); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, otherProjectID, 0, 4096); err == nil {
		t.Fatal("commit succeeded for a different project")
	}
}

func TestTombstone_BlocksSessionReuse(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sid := newSessionID(t)
	if tombstoned, err := q.SessionIsTombstoned(ctx, sid); err != nil || tombstoned {
		t.Fatalf("fresh tombstone lookup = %v, %v", tombstoned, err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO session_tombstones (session_id, project_id) VALUES ($1, $2)`, sid, projectID,
	); err != nil {
		t.Fatalf("seed tombstone: %v", err)
	}
	if tombstoned, err := q.SessionIsTombstoned(ctx, sid); err != nil || !tombstoned {
		t.Fatalf("tombstoned lookup = %v, %v", tombstoned, err)
	}
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://a"); !errors.Is(err, db.ErrSessionTombstoned) {
		t.Fatalf("insert tombstoned session returned %v, want ErrSessionTombstoned", err)
	}
}

func TestProjectRecordingEnabled_KillSwitch(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, _ := seedSessionProject(t, pool)
	if on, err := q.ProjectRecordingEnabled(ctx, projectID); err != nil || !on {
		t.Fatalf("default recording_enabled = %v, %v", on, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE projects SET recording_enabled = FALSE WHERE id = $1`, projectID); err != nil {
		t.Fatalf("flip switch: %v", err)
	}
	if on, err := q.ProjectRecordingEnabled(ctx, projectID); err != nil || on {
		t.Fatalf("disabled recording_enabled = %v, %v", on, err)
	}
}

func TestUpsertEndUser_IsStableAcrossCalls(t *testing.T) {
	q, pool := sessionTestQueries(t)
	projectID, _ := seedSessionProject(t, pool)
	id1, err := q.UpsertEndUser(context.Background(), projectID, "user-42", "acct-1", "a@example.com", "Acme")
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	id2, err := q.UpsertEndUser(context.Background(), projectID, "user-42", "", "", "")
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("upsert minted a second row (%s vs %s)", id1, id2)
	}
}

func TestClaimUnscrubbedChunks_OnlyReturnsUploadedAndUnscrubbed(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sid := newSessionID(t)
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://a"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 0, "k0", true); err != nil {
		t.Fatalf("reserve 0: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 1, "k1", true); err != nil {
		t.Fatalf("reserve 1: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 1, 100); err != nil {
		t.Fatalf("commit 1: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 2, "k2", true); err != nil {
		t.Fatalf("reserve 2: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 2, 100); err != nil {
		t.Fatalf("commit 2: %v", err)
	}
	// Put this test's rows first even when a developer database contains chunks
	// left by other integration packages.
	if _, err := pool.Exec(ctx,
		`UPDATE session_chunks SET uploaded_at = '1900-01-01'::timestamptz
		  WHERE session_id = $1 AND uploaded_at IS NOT NULL`, sid,
	); err != nil {
		t.Fatalf("age test chunks: %v", err)
	}
	if err := q.MarkChunkScrubbed(ctx, sid, projectID, 2, nil, nil, 0); err != nil {
		t.Fatalf("mark scrubbed: %v", err)
	}

	claimed, err := q.ClaimUnscrubbedChunks(ctx, 10000)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	var seqs []int
	for _, chunk := range claimed {
		if chunk.SessionID == sid {
			seqs = append(seqs, chunk.Seq)
		}
	}
	if len(seqs) != 1 || seqs[0] != 1 {
		t.Fatalf("claimed seqs %v, want exactly [1]", seqs)
	}
}

func TestClaimUnscrubbedChunks_GivesUpAfterMaxAttempts(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sid := newSessionID(t)
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://a"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 0, "k0", true); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 0, 100); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE session_chunks SET uploaded_at = '1900-01-01'::timestamptz WHERE session_id = $1`, sid,
	); err != nil {
		t.Fatalf("age test chunk: %v", err)
	}

	for i := 0; i < 10; i++ {
		claimed, err := q.ClaimUnscrubbedChunks(ctx, 10000)
		if err != nil {
			t.Fatalf("claim %d: %v", i, err)
		}
		for _, chunk := range claimed {
			if chunk.SessionID == sid {
				if err := q.MarkChunkScrubFailed(ctx, sid, projectID, 0, "test failure"); err != nil {
					t.Fatalf("release claim %d: %v", i, err)
				}
			}
		}
	}
	claimed, err := q.ClaimUnscrubbedChunks(ctx, 10000)
	if err != nil {
		t.Fatalf("final claim: %v", err)
	}
	for _, chunk := range claimed {
		if chunk.SessionID == sid {
			t.Fatal("chunk still claimed after exceeding max attempts")
		}
	}

	var scrubbedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT scrubbed_at FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
	).Scan(&scrubbedAt); err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	if scrubbedAt != nil {
		t.Fatal("a chunk that never scrubbed is marked scrubbed")
	}
}

func TestClaimUnscrubbedChunks_DoesNotReclaimAnActiveLease(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sid := newSessionID(t)
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://a"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 0, "lease-k0", true); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 0, 100); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE session_chunks SET uploaded_at = '1900-01-01'::timestamptz WHERE session_id = $1`, sid,
	); err != nil {
		t.Fatalf("age chunk: %v", err)
	}

	first, err := q.ClaimUnscrubbedChunks(ctx, 10000)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	found := false
	for _, chunk := range first {
		if chunk.SessionID == sid {
			found = true
		}
	}
	if !found {
		t.Fatal("first claim did not return test chunk")
	}

	second, err := q.ClaimUnscrubbedChunks(ctx, 10000)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	for _, chunk := range second {
		if chunk.SessionID == sid {
			t.Fatal("active scrub lease was claimed concurrently")
		}
	}
}

func TestClaimTombstonesForStorageSweep_DoesNotDuplicateAcrossReplicas(t *testing.T) {
	q, pool := sessionTestQueries(t)
	ctx := context.Background()
	projectID, envID := seedSessionProject(t, pool)
	sid := newSessionID(t)
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, time.Now(), "https://a"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE sessions SET started_at = now() - interval '100 days' WHERE id = $1`, sid); err != nil {
		t.Fatalf("age session: %v", err)
	}
	if err := q.MarkSessionDeleting(ctx, sid, projectID); err != nil {
		t.Fatalf("mark deleting: %v", err)
	}
	if err := q.DeleteMarkedSession(ctx, sid, projectID); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	first, err := q.ClaimTombstonesForStorageSweep(ctx, 10000)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	found := false
	for _, tombstone := range first {
		if tombstone.ID == sid {
			found = true
		}
	}
	if !found {
		t.Fatal("first claim did not return test tombstone")
	}

	second, err := q.ClaimTombstonesForStorageSweep(ctx, 10000)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	for _, tombstone := range second {
		if tombstone.ID == sid {
			t.Fatal("active tombstone sweep lease was claimed concurrently")
		}
	}
}
