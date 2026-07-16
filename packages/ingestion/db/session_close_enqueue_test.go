package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// Batch 4 (issue #56): detection turns on. Closing an idle session is the
// session_analysis producer — one typed job per close, never duplicated.
func TestCloseIdleSessions_EnqueuesSessionAnalysis(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "test-close-enqueue")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenant(t, pool, org.ID)
	})
	proj, err := q.CreateProject(ctx, org.ID, "close-enqueue", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	seedSession := func(id string, idleMinutes int) {
		_, err := pool.Exec(ctx,
			`INSERT INTO sessions (id, project_id, environment_id, started_at, last_chunk_at, status)
			 VALUES ($1, $2, $3, now() - interval '2 hours',
			         now() - make_interval(mins => $4), 'recording')`,
			id, proj.ID, env.ID, idleMinutes,
		)
		if err != nil {
			t.Fatalf("seed session %s: %v", id, err)
		}
	}
	seedSession("close-idle-1", 45)
	seedSession("close-idle-2", 45)
	seedSession("close-active", 1)

	// CloseIdleSessions is global; on a shared DB other tenants' sessions may
	// close too. Assert only this tenant's observable effects.
	if _, err := q.CloseIdleSessions(ctx, 30); err != nil {
		t.Fatalf("CloseIdleSessions: %v", err)
	}
	var closedMine int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM sessions WHERE project_id = $1 AND status = 'closed'`,
		proj.ID,
	).Scan(&closedMine); err != nil {
		t.Fatalf("count closed: %v", err)
	}
	if closedMine != 2 {
		t.Fatalf("closed sessions in tenant = %d, want 2", closedMine)
	}

	var jobs int
	err = pool.QueryRow(ctx,
		`SELECT count(*) FROM error_group_jobs
		 WHERE project_id = $1 AND job_type = 'session_analysis' AND status = 'pending'
		   AND session_id IN ('close-idle-1', 'close-idle-2')`,
		proj.ID,
	).Scan(&jobs)
	if err != nil {
		t.Fatalf("count jobs: %v", err)
	}
	if jobs != 2 {
		t.Errorf("session_analysis jobs = %d, want 2 (one per closed session)", jobs)
	}

	var activeJobs int
	err = pool.QueryRow(ctx,
		`SELECT count(*) FROM error_group_jobs
		 WHERE project_id = $1 AND session_id = 'close-active'`,
		proj.ID,
	).Scan(&activeJobs)
	if err != nil {
		t.Fatalf("count active jobs: %v", err)
	}
	if activeJobs != 0 {
		t.Errorf("active session must not be closed or enqueued, got %d jobs", activeJobs)
	}

	// A second pass is a no-op for this tenant: no duplicate jobs.
	if _, err := q.CloseIdleSessions(ctx, 30); err != nil {
		t.Fatalf("CloseIdleSessions second pass: %v", err)
	}
	err = pool.QueryRow(ctx,
		`SELECT count(*) FROM error_group_jobs
		 WHERE project_id = $1 AND job_type = 'session_analysis'`,
		proj.ID,
	).Scan(&jobs)
	if err != nil {
		t.Fatalf("recount jobs: %v", err)
	}
	if jobs != 2 {
		t.Errorf("second pass duplicated jobs: %d, want 2", jobs)
	}
}
