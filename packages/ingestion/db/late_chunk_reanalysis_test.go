package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// Batch 4 (issue #56): a chunk that becomes READABLE after its session was
// closed and analyzed must re-enqueue analysis — otherwise late evidence is
// silently dropped forever (whole-session truth, design v4-5). The producer
// fires at scrub time, not commit time: a commit-time job races the scrubber
// and analyzes a partial session.
func TestMarkChunkScrubbed_LateChunkReenqueuesAnalysis(t *testing.T) {
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

	scrub := func(sessionID string, seq int) {
		if err := q.MarkChunkScrubbed(ctx, sessionID, proj.ID, seq, nil, nil, 100); err != nil {
			t.Fatalf("MarkChunkScrubbed %s/%d: %v", sessionID, seq, err)
		}
	}

	// COMMIT of a late chunk must NOT enqueue: the chunk is not readable yet,
	// and a commit-time job races the scrubber into a partial analysis.
	seed("late-analyzed", "analyzed", 0)
	if err := q.CommitChunk(ctx, "late-analyzed", proj.ID, 0, 100); err != nil {
		t.Fatalf("CommitChunk: %v", err)
	}
	if n := countJobs("late-analyzed"); n != 0 {
		t.Errorf("commit must not enqueue (scrub does): jobs = %d, want 0", n)
	}

	// SCRUB of that late chunk re-enqueues exactly once.
	scrub("late-analyzed", 0)
	if n := countJobs("late-analyzed"); n != 1 {
		t.Errorf("analyzed session late scrub: jobs = %d, want 1", n)
	}

	// A second late chunk scrubbed while a job is still pending: no duplicate.
	seed("late-analyzed", "analyzed", 1)
	scrub("late-analyzed", 1)
	if n := countJobs("late-analyzed"); n != 1 {
		t.Errorf("pending dedupe: jobs = %d, want 1", n)
	}

	// A recording session's normal scrub enqueues nothing (close will).
	seed("still-recording", "recording", 0)
	scrub("still-recording", 0)
	if n := countJobs("still-recording"); n != 0 {
		t.Errorf("recording session: jobs = %d, want 0", n)
	}

	// Closed session, no live job: a late scrubbed chunk still re-enqueues.
	seed("late-closed", "closed", 0)
	scrub("late-closed", 0)
	if n := countJobs("late-closed"); n != 1 {
		t.Errorf("closed session late scrub: jobs = %d, want 1", n)
	}
}
