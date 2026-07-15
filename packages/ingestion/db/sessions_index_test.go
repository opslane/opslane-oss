package db_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The retention sweep's indexes are partial. Postgres will only use a partial
// index when the query's predicate *implies* the index's predicate, so an index
// whose WHERE clause disagrees with its caller is not merely slow -- it is
// unusable, and the planner silently falls back to scanning the whole table.
// sessions grows one row per browser session under always-on recording, and the
// sweep runs on every replica, so that fallback is not a rounding error.
//
// These tests probe usability rather than speed: with seq scans discouraged, a
// usable index gets picked and an unusable one cannot be, no matter how much the
// planner would like to. That makes the assertion deterministic and independent
// of table size, unlike a timing or row-count threshold.
//
// A previous version of 002_sessions.sql indexed WHERE status <> 'recording'
// while SessionsToDelete filtered status <> 'deleting'. These tests fail against
// that schema.

// explainWithoutSeqScan returns the query plan for sql with seq scans
// discouraged. SET LOCAL keeps the setting scoped to a transaction that always
// rolls back, so it cannot leak onto a pooled connection and skew other tests.
func explainWithoutSeqScan(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
		t.Fatalf("disable seqscan: %v", err)
	}

	rows, err := tx.Query(ctx, "EXPLAIN "+sql, args...)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer rows.Close()

	var plan strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("scan plan: %v", err)
		}
		plan.WriteString(line)
		plan.WriteByte('\n')
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("plan rows: %v", err)
	}
	return plan.String()
}

// seedSessionsForPlanner inserts enough rows that the planner makes a realistic
// choice instead of trivially scanning a near-empty table.
func seedSessionsForPlanner(t *testing.T, pool *pgxpool.Pool, projectID, envID string, n int) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx,
		`INSERT INTO sessions (id, project_id, environment_id, started_at, status, deletion_started_at)
		 SELECT $1 || g, $2, $3,
		        now() - make_interval(mins => g),
		        CASE WHEN g % 100 = 0 THEN 'deleting' ELSE 'closed' END,
		        CASE WHEN g % 100 = 0 THEN now() - interval '10 minutes' ELSE NULL END
		   FROM generate_series(1, $4) g`,
		fmt.Sprintf("idxtest_%d_", n), projectID, envID, n)
	if err != nil {
		t.Fatalf("seed sessions: %v", err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE sessions`); err != nil {
		t.Fatalf("analyze: %v", err)
	}
}

// SessionsToDelete (db/sessions.go) must be servable by idx_sessions_retention_not_deleting.
func TestSessionsToDelete_UsesRetentionIndex(t *testing.T) {
	_, pool := sessionTestQueries(t)
	projectID, envID := seedSessionProject(t, pool)
	seedSessionsForPlanner(t, pool, projectID, envID, 5000)

	// Verbatim from Queries.SessionsToDelete.
	const sql = `SELECT s.id, s.project_id
	   FROM sessions s
	   JOIN projects p ON p.id = s.project_id
	  WHERE s.status <> 'deleting'
	    AND (s.started_at < now() - make_interval(days => $1)
	     OR (
	          s.started_at < now() - make_interval(days => p.session_retention_days)
	          AND (s.retain_until IS NULL OR s.retain_until <= now())
	        ))
	  ORDER BY s.started_at ASC
	  LIMIT $2`

	plan := explainWithoutSeqScan(t, pool, sql, 90, 100)

	if !strings.Contains(plan, "idx_sessions_retention_not_deleting") {
		t.Fatalf("SessionsToDelete does not use idx_sessions_retention_not_deleting.\n"+
			"The index predicate must imply the query predicate (status <> 'deleting').\nPlan:\n%s", plan)
	}
	if strings.Contains(plan, "Seq Scan on sessions") {
		t.Fatalf("SessionsToDelete falls back to a sequential scan of sessions.\nPlan:\n%s", plan)
	}
}

// SessionsReadyForPurge (db/sessions.go) orders by deletion_started_at and must
// be servable by idx_sessions_purge rather than sorting the table.
func TestSessionsReadyForPurge_UsesPurgeIndex(t *testing.T) {
	_, pool := sessionTestQueries(t)
	projectID, envID := seedSessionProject(t, pool)
	seedSessionsForPlanner(t, pool, projectID, envID, 5000)

	// Verbatim from Queries.SessionsReadyForPurge.
	const sql = `SELECT id, project_id FROM sessions
		  WHERE status = 'deleting' AND deletion_started_at <= now() - make_interval(secs => $1)
		  ORDER BY deletion_started_at ASC LIMIT $2`

	plan := explainWithoutSeqScan(t, pool, sql, 60, 100)

	if !strings.Contains(plan, "idx_sessions_purge") {
		t.Fatalf("SessionsReadyForPurge does not use idx_sessions_purge -- "+
			"deletion_started_at is unindexed, so every pass sorts the table.\nPlan:\n%s", plan)
	}
}

// The old predicate-mismatched index must not survive a migration re-run.
func TestRetentionIndex_OldMismatchedIndexIsGone(t *testing.T) {
	_, pool := sessionTestQueries(t)
	ctx := context.Background()

	var exists bool
	err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM pg_indexes
		                WHERE tablename = 'sessions' AND indexname = 'idx_sessions_retention')`,
	).Scan(&exists)
	if err != nil && err != pgx.ErrNoRows {
		t.Fatalf("check old index: %v", err)
	}
	if exists {
		t.Fatal("idx_sessions_retention (predicate: status <> 'recording') still exists; " +
			"002_sessions.sql should have dropped it in favour of idx_sessions_retention_not_deleting")
	}
}
