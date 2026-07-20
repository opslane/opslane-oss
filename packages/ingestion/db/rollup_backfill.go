package db

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	rollupBackfillAdvisoryLock int64 = 728305118315874201
	rollupBackfillBatchSize          = 250
)

// RollupReady reports whether environment-scoped reads can be exposed safely.
func (q *Queries) RollupReady(ctx context.Context) (bool, error) {
	var ready bool
	if err := q.pool.QueryRow(ctx, `
		SELECT status = 'complete'
		FROM rollup_backfill_state
		WHERE id`).Scan(&ready); err != nil {
		return false, fmt.Errorf("read rollup backfill readiness: %w", err)
	}
	return ready, nil
}

// RunRollupBackfill recomputes environment rollups from their source rows.
// It returns false when the durable state is already complete or another
// replica owns the advisory lock. Holding the advisory lock on one acquired
// connection is essential: session advisory locks are connection-scoped.
func (q *Queries) RunRollupBackfill(ctx context.Context) (bool, error) {
	var status string
	if err := q.pool.QueryRow(ctx,
		`SELECT status FROM rollup_backfill_state WHERE id`,
	).Scan(&status); err != nil {
		return false, fmt.Errorf("read rollup backfill state: %w", err)
	}
	if status == "complete" {
		return false, nil
	}

	conn, err := q.pool.Acquire(ctx)
	if err != nil {
		return false, fmt.Errorf("acquire rollup backfill connection: %w", err)
	}
	defer conn.Release()

	var locked bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock($1)`, rollupBackfillAdvisoryLock,
	).Scan(&locked); err != nil {
		return false, fmt.Errorf("acquire rollup backfill advisory lock: %w", err)
	}
	if !locked {
		return false, nil
	}
	defer func() {
		// Unlock even when the caller's context was cancelled.
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, rollupBackfillAdvisoryLock)
	}()

	// A replica may have completed the task between the cheap pre-check and our
	// advisory-lock acquisition.
	if err := conn.QueryRow(ctx,
		`SELECT status FROM rollup_backfill_state WHERE id`,
	).Scan(&status); err != nil {
		return false, fmt.Errorf("recheck rollup backfill state: %w", err)
	}
	if status == "complete" {
		return false, nil
	}
	if _, err := conn.Exec(ctx, `
		UPDATE rollup_backfill_state
		SET status = 'running', updated_at = now()
		WHERE id`); err != nil {
		return false, fmt.Errorf("mark rollup backfill running: %w", err)
	}

	if err := q.runRollupBackfillPass(ctx, 1); err != nil {
		resetRollupBackfillRunning(conn)
		return true, err
	}
	// Repeat the live keyset scan, rather than only replaying old ranges, so the
	// reconciliation pass also catches groups created during a rolling deploy.
	if err := q.runRollupBackfillPass(ctx, 2); err != nil {
		resetRollupBackfillRunning(conn)
		return true, err
	}
	if _, err := conn.Exec(ctx, `
		UPDATE rollup_backfill_state
		SET status = 'complete', updated_at = now()
		WHERE id`); err != nil {
		return true, fmt.Errorf("mark rollup backfill complete: %w", err)
	}
	return true, nil
}

// resetRollupBackfillRunning returns a failed run to 'pending' so a later
// restart or replica retries instead of leaving readers dark on a status that
// only ever advances to 'complete'. It runs on a fresh context because the
// caller's context may already be cancelled, mirroring the advisory unlock.
func resetRollupBackfillRunning(conn *pgxpool.Conn) {
	_, _ = conn.Exec(context.Background(), `
		UPDATE rollup_backfill_state
		SET status = 'pending', updated_at = now()
		WHERE id AND status = 'running'`)
}

func (q *Queries) runRollupBackfillPass(ctx context.Context, pass int) error {
	var after *string
	for {
		rows, err := q.pool.Query(ctx, `
			SELECT id
			FROM error_groups
			WHERE kind = 'error'
			  AND ($1::uuid IS NULL OR id > $1::uuid)
			ORDER BY id
			LIMIT $2`, after, rollupBackfillBatchSize)
		if err != nil {
			return fmt.Errorf("list rollup backfill batch: %w", err)
		}
		ids := make([]string, 0, rollupBackfillBatchSize)
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return fmt.Errorf("scan rollup backfill group: %w", err)
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("iterate rollup backfill groups: %w", err)
		}
		rows.Close()
		if len(ids) == 0 {
			return nil
		}
		if err := q.recomputeRollupBatch(ctx, ids, pass); err != nil {
			return err
		}
		after = &ids[len(ids)-1]
	}
}

func (q *Queries) recomputeRollupBatch(ctx context.Context, ids []string, pass int) error {
	parsedIDs := make([]uuid.UUID, len(ids))
	for i, id := range ids {
		parsed, err := uuid.Parse(id)
		if err != nil {
			return fmt.Errorf("parse rollup group id %q: %w", id, err)
		}
		parsedIDs[i] = parsed
	}

	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin rollup backfill batch: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// This is the same row lock taken by the error-group upsert. Once held, the
	// source snapshot and absolute rollup replacement cannot race a current
	// ingestion writer for these groups.
	lockedRows, err := tx.Query(ctx, `
		SELECT id
		FROM error_groups
		WHERE kind = 'error' AND id = ANY($1::uuid[])
		ORDER BY id
		FOR UPDATE`, parsedIDs)
	if err != nil {
		return fmt.Errorf("lock rollup backfill groups: %w", err)
	}
	lockedIDs := make([]uuid.UUID, 0, len(parsedIDs))
	for lockedRows.Next() {
		var id uuid.UUID
		if err := lockedRows.Scan(&id); err != nil {
			lockedRows.Close()
			return fmt.Errorf("scan locked rollup group: %w", err)
		}
		lockedIDs = append(lockedIDs, id)
	}
	if err := lockedRows.Err(); err != nil {
		lockedRows.Close()
		return fmt.Errorf("iterate locked rollup groups: %w", err)
	}
	lockedRows.Close()

	if len(lockedIDs) > 0 {
		if _, err := tx.Exec(ctx,
			`DELETE FROM error_group_environments WHERE error_group_id = ANY($1::uuid[])`,
			lockedIDs,
		); err != nil {
			return fmt.Errorf("clear rollup backfill batch: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO error_group_environments
			  (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
			SELECT error_group_id, environment_id, min(occurred_at), max(occurred_at), sum(occurrences)::bigint
			FROM (
			  SELECT ee.error_group_id, ee.environment_id, ee."timestamp" AS occurred_at, 1::bigint AS occurrences
			  FROM error_events ee
			  WHERE ee.error_group_id = ANY($1::uuid[])
			  UNION ALL
			  SELECT fs.incident_id, fs.environment_id, fs.occurred_at, fs.occurrence_count::bigint
			  FROM friction_signals fs
			  WHERE fs.incident_id = ANY($1::uuid[])
			    AND fs.retracted_at IS NULL
			    AND fs.superseded_by IS NULL
			) source_rows
			GROUP BY error_group_id, environment_id
			ON CONFLICT (error_group_id, environment_id) DO UPDATE
			SET first_seen = EXCLUDED.first_seen,
			    last_seen = EXCLUDED.last_seen,
			    occurrence_count = EXCLUDED.occurrence_count`, lockedIDs); err != nil {
			return fmt.Errorf("recompute rollup backfill batch: %w", err)
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO rollup_backfill_ledger (batch_start, batch_end, pass)
		VALUES ($1, $2, $3)
		ON CONFLICT (batch_start, pass) DO UPDATE
		SET batch_end = EXCLUDED.batch_end, completed_at = now()`,
		ids[0], ids[len(ids)-1], pass,
	); err != nil {
		return fmt.Errorf("record rollup backfill batch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit rollup backfill batch: %w", err)
	}
	return nil
}
