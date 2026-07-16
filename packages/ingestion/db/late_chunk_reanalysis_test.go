package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// Batch 4 (issue #56): a chunk that lands after a session was closed and
// analyzed must re-enqueue analysis — otherwise the SDK's flush cadence
// silently drops late evidence forever (whole-session truth, design v4-5).
func TestCommitChunk_LateChunkReenqueuesAnalysis(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "test-late-chunk")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM session_chunks WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenant(t, pool, org.ID)
	})
	proj, err := q.CreateProject(ctx, org.ID, "late-chunk", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	seed := func(sessionID, status string, seq int) {
		if _, err := pool.Exec(ctx,
			`INSERT INTO sessions (id, project_id, environment_id, started_at, status)
			 VALUES ($1, $2, $3, now() - interval '10 minutes', $4)
			 ON CONFLICT (id) DO NOTHING`,
			sessionID, proj.ID, env.ID, status,
		); err != nil {
			t.Fatalf("seed session: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO session_chunks (session_id, project_id, seq, object_key)
			 VALUES ($1, $2, $3, 'chunks/' || $1 || '/' || ($3::int)::text)`,
			sessionID, proj.ID, seq,
		); err != nil {
			t.Fatalf("seed chunk: %v", err)
		}
	}

	countJobs := func(sessionID string) int {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM error_group_jobs
			 WHERE session_id = $1 AND job_type = 'session_analysis'`,
			sessionID,
		).Scan(&n); err != nil {
			t.Fatalf("count jobs: %v", err)
		}
		return n
	}

	// Late chunk on an ANALYZED session re-enqueues exactly once.
	seed("late-analyzed", "analyzed", 0)
	if err := q.CommitChunk(ctx, "late-analyzed", proj.ID, 0, 100); err != nil {
		t.Fatalf("CommitChunk: %v", err)
	}
	if n := countJobs("late-analyzed"); n != 1 {
		t.Errorf("analyzed session late chunk: jobs = %d, want 1", n)
	}

	// A second late chunk while a job is still pending does not duplicate.
	seed("late-analyzed", "analyzed", 1)
	if err := q.CommitChunk(ctx, "late-analyzed", proj.ID, 1, 100); err != nil {
		t.Fatalf("CommitChunk seq1: %v", err)
	}
	if n := countJobs("late-analyzed"); n != 1 {
		t.Errorf("pending dedupe: jobs = %d, want 1", n)
	}

	// A recording session's normal chunk enqueues nothing (close will).
	seed("still-recording", "recording", 0)
	if err := q.CommitChunk(ctx, "still-recording", proj.ID, 0, 100); err != nil {
		t.Fatalf("CommitChunk recording: %v", err)
	}
	if n := countJobs("still-recording"); n != 0 {
		t.Errorf("recording session: jobs = %d, want 0", n)
	}

	// Closed (awaiting first analysis is already queued by close): a late
	// chunk with no live job still re-enqueues.
	seed("late-closed", "closed", 0)
	if err := q.CommitChunk(ctx, "late-closed", proj.ID, 0, 100); err != nil {
		t.Fatalf("CommitChunk closed: %v", err)
	}
	if n := countJobs("late-closed"); n != 1 {
		t.Errorf("closed session late chunk: jobs = %d, want 1", n)
	}
}
