package db_test

import (
	"context"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// BenchmarkRollupHotPath isolates the serialized ingest section for one hot
// fingerprint and reports p95 in addition to Go's mean ns/op. Run explicitly:
//
//	go test ./db -run '^$' -bench BenchmarkRollupHotPath -benchtime=500x
func BenchmarkRollupHotPath(b *testing.B) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultTestDSN
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		b.Skipf("connect to postgres: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		b.Skipf("postgres not reachable: %v", err)
	}
	b.Cleanup(pool.Close)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "rollup-hot-path-benchmark")
	if err != nil {
		b.Fatalf("CreateOrg: %v", err)
	}
	project, err := q.CreateProject(ctx, org.ID, "rollup-hot-path-benchmark", nil)
	if err != nil {
		b.Fatalf("CreateProject: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		b.Fatalf("CreateEnvironment: %v", err)
	}
	b.Cleanup(func() {
		cleanupCtx := context.Background()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM error_group_jobs WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM error_events WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM error_groups WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM environments WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM projects WHERE id = $1`, project.ID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM orgs WHERE id = $1`, org.ID)
	})

	for _, benchmark := range []struct {
		name       string
		withRollup bool
	}{
		{name: "without_rollup"},
		{name: "with_rollup", withRollup: true},
	} {
		b.Run(benchmark.name, func(b *testing.B) {
			b.StopTimer()
			var groupID string
			if err := pool.QueryRow(ctx, `
				INSERT INTO error_groups
				  (project_id, fingerprint, title, first_seen, last_seen, occurrence_count)
				VALUES ($1, $2, $2, now(), now(), 0)
				RETURNING id`, project.ID, "benchmark-"+benchmark.name+"-"+uuid.NewString()).Scan(&groupID); err != nil {
				b.Fatalf("insert group: %v", err)
			}
			b.StartTimer()

			durations := make([]time.Duration, 0, b.N)
			var durationsMu sync.Mutex
			b.SetParallelism(4)
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					started := time.Now()
					tx, err := pool.Begin(context.Background())
					if err != nil {
						b.Errorf("begin: %v", err)
						return
					}
					var eventID string
					var occurredAt time.Time
					err = tx.QueryRow(context.Background(), `
						INSERT INTO error_events
						  (project_id, environment_id, timestamp, error_type, error_message,
						   stack_trace_raw, breadcrumbs, context)
						VALUES ($1, $2, clock_timestamp(), 'TypeError', 'benchmark',
						        'at app.js:1:1', '[]', '{}')
						RETURNING id, "timestamp"`, project.ID, environment.ID,
					).Scan(&eventID, &occurredAt)
					if err == nil {
						_, err = tx.Exec(context.Background(), `
							UPDATE error_groups
							SET first_seen = LEAST(first_seen, $2),
							    last_seen = GREATEST(last_seen, $2),
							    occurrence_count = occurrence_count + 1,
							    sample_event_id = $3
							WHERE id = $1`, groupID, occurredAt, eventID)
					}
					if err == nil && benchmark.withRollup {
						_, err = tx.Exec(context.Background(), `
							WITH linked_event AS (
							  UPDATE error_events SET error_group_id = $1 WHERE id = $2
							  RETURNING id
							)
							INSERT INTO error_group_environments
							  (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
							SELECT $1, $3, $4, $4, 1 FROM linked_event
							ON CONFLICT (error_group_id, environment_id) DO UPDATE
							SET first_seen = LEAST(error_group_environments.first_seen, EXCLUDED.first_seen),
							    last_seen = GREATEST(error_group_environments.last_seen, EXCLUDED.last_seen),
							    occurrence_count = error_group_environments.occurrence_count + 1`,
							groupID, eventID, environment.ID, occurredAt)
					} else if err == nil {
						_, err = tx.Exec(context.Background(),
							`UPDATE error_events SET error_group_id = $1 WHERE id = $2`, groupID, eventID)
					}
					if err == nil {
						err = tx.Commit(context.Background())
					} else {
						_ = tx.Rollback(context.Background())
					}
					if err != nil {
						b.Errorf("hot-path transaction: %v", err)
						return
					}
					durationsMu.Lock()
					durations = append(durations, time.Since(started))
					durationsMu.Unlock()
				}
			})
			b.StopTimer()
			sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
			if len(durations) > 0 {
				p95 := durations[(len(durations)-1)*95/100]
				b.ReportMetric(float64(p95.Microseconds()), "p95-us")
			}
		})
	}
}
