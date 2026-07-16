package db

import (
	"context"
	"fmt"
	"time"
)

type AdminHourlyEventBucket struct {
	Hour  time.Time `json:"hour"`
	Count int64     `json:"count"`
}

type AdminTopProject struct {
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
	OrgName     string `json:"org_name"`
	Count       int64  `json:"count"`
}

type AdminEventOverview struct {
	Last1H      int64                    `json:"last_1h"`
	Last24H     int64                    `json:"last_24h"`
	Last7D      int64                    `json:"last_7d"`
	Hourly      []AdminHourlyEventBucket `json:"hourly"`
	TopProjects []AdminTopProject        `json:"top_projects"`
}

type AdminJobOverview struct {
	ByStatus                map[string]int64 `json:"by_status"`
	ByType                  map[string]int64 `json:"by_type"`
	OldestPendingAgeSeconds *float64         `json:"oldest_pending_age_seconds"`
	DeadLetters7D           int64            `json:"dead_letters_7d"`
}

type AdminWorkerOverview struct {
	LiveClaims int64 `json:"live_claims"`
	Active5M   int64 `json:"active_5m"`
}

type AdminOutcomeOverview struct {
	ByStatus     map[string]int64 `json:"by_status"`
	PRCreated24H int64            `json:"pr_created_24h"`
	PRCreated7D  int64            `json:"pr_created_7d"`
	NeedsHuman7D int64            `json:"needs_human_7d"`
	Merged7D     int64            `json:"merged_7d"`
	Closed7D     int64            `json:"closed_7d"`
}

type AdminOverview struct {
	Events   AdminEventOverview   `json:"events"`
	Jobs     AdminJobOverview     `json:"jobs"`
	Workers  AdminWorkerOverview  `json:"workers"`
	Outcomes AdminOutcomeOverview `json:"outcomes"`
}

type AdminJob struct {
	ID              string    `json:"id"`
	ProjectName     string    `json:"project_name"`
	JobType         string    `json:"job_type"`
	Status          string    `json:"status"`
	Attempts        int       `json:"attempts"`
	CreatedAt       time.Time `json:"created_at"`
	DurationSeconds *float64  `json:"duration_seconds"`
	LastError       *string   `json:"last_error"`
	TraceURL        *string   `json:"trace_url"`
	IncidentTitle   *string   `json:"incident_title"`
	PRURL           *string   `json:"pr_url"`
}

// AdminOverviewData intentionally crosses every tenant. RequireAdmin is the sole
// HTTP gate; keep the Admin prefix on every cross-tenant helper for auditability.
func (q *Queries) AdminOverviewData(ctx context.Context) (*AdminOverview, error) {
	result := &AdminOverview{
		Events: AdminEventOverview{Hourly: make([]AdminHourlyEventBucket, 0, 48), TopProjects: make([]AdminTopProject, 0, 10)},
		Jobs: AdminJobOverview{
			ByStatus: map[string]int64{"pending": 0, "claimed": 0, "completed": 0, "failed": 0, "dead_letter": 0},
			ByType:   map[string]int64{"investigate": 0, "fix": 0, "error_fix": 0, "setup_pr": 0, "session_analysis": 0},
		},
		Outcomes: AdminOutcomeOverview{ByStatus: make(map[string]int64)},
	}

	if err := q.pool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE created_at >= now() - interval '1 hour'),
			count(*) FILTER (WHERE created_at >= now() - interval '24 hours'),
			count(*) FILTER (WHERE created_at >= now() - interval '7 days')
		FROM error_events
		WHERE created_at >= now() - interval '7 days'`).Scan(&result.Events.Last1H, &result.Events.Last24H, &result.Events.Last7D); err != nil {
		return nil, fmt.Errorf("admin event totals: %w", err)
	}

	rows, err := q.pool.Query(ctx, `
		WITH buckets AS (
			SELECT generate_series(
				date_trunc('hour', now(), 'UTC') - interval '47 hours',
				date_trunc('hour', now(), 'UTC'),
				interval '1 hour'
			) AS hour
		), counts AS (
			SELECT date_trunc('hour', created_at, 'UTC') AS hour, count(*) AS count
			FROM error_events
			WHERE created_at >= date_trunc('hour', now(), 'UTC') - interval '47 hours'
			  AND created_at < date_trunc('hour', now(), 'UTC') + interval '1 hour'
			GROUP BY 1
		)
		SELECT b.hour, coalesce(c.count, 0)
		FROM buckets b LEFT JOIN counts c USING (hour)
		ORDER BY b.hour`)
	if err != nil {
		return nil, fmt.Errorf("admin hourly events: %w", err)
	}
	for rows.Next() {
		var bucket AdminHourlyEventBucket
		if err := rows.Scan(&bucket.Hour, &bucket.Count); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan admin hourly events: %w", err)
		}
		result.Events.Hourly = append(result.Events.Hourly, bucket)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate admin hourly events: %w", err)
	}
	rows.Close()

	rows, err = q.pool.Query(ctx, `
		SELECT p.id, p.name, o.name, count(*) AS count
		FROM error_events e
		JOIN projects p ON p.id = e.project_id
		JOIN orgs o ON o.id = p.org_id
		WHERE e.created_at >= now() - interval '24 hours'
		GROUP BY p.id, p.name, o.name
		ORDER BY count DESC, p.id
		LIMIT 10`)
	if err != nil {
		return nil, fmt.Errorf("admin top projects: %w", err)
	}
	for rows.Next() {
		var project AdminTopProject
		if err := rows.Scan(&project.ProjectID, &project.ProjectName, &project.OrgName, &project.Count); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan admin top projects: %w", err)
		}
		result.Events.TopProjects = append(result.Events.TopProjects, project)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate admin top projects: %w", err)
	}
	rows.Close()

	rows, err = q.pool.Query(ctx, `SELECT status::text, count(*) FROM error_group_jobs GROUP BY status`)
	if err != nil {
		return nil, fmt.Errorf("admin jobs by status: %w", err)
	}
	for rows.Next() {
		var key string
		var count int64
		if err := rows.Scan(&key, &count); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan admin jobs by status: %w", err)
		}
		result.Jobs.ByStatus[key] = count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate admin jobs by status: %w", err)
	}
	rows.Close()

	rows, err = q.pool.Query(ctx, `SELECT job_type, count(*) FROM error_group_jobs GROUP BY job_type`)
	if err != nil {
		return nil, fmt.Errorf("admin jobs by type: %w", err)
	}
	for rows.Next() {
		var key string
		var count int64
		if err := rows.Scan(&key, &count); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan admin jobs by type: %w", err)
		}
		result.Jobs.ByType[key] = count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate admin jobs by type: %w", err)
	}
	rows.Close()

	if err := q.pool.QueryRow(ctx, `
		SELECT
			extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::double precision,
			count(*) FILTER (WHERE status = 'dead_letter' AND updated_at >= now() - interval '7 days')
		FROM error_group_jobs
		WHERE status = 'pending' OR (status = 'dead_letter' AND updated_at >= now() - interval '7 days')`).Scan(
		&result.Jobs.OldestPendingAgeSeconds, &result.Jobs.DeadLetters7D,
	); err != nil {
		return nil, fmt.Errorf("admin job health: %w", err)
	}

	if err := q.pool.QueryRow(ctx, `
		SELECT
			count(DISTINCT worker_id) FILTER (WHERE status = 'claimed' AND lease_expires_at > now()),
			count(DISTINCT worker_id) FILTER (WHERE worker_id IS NOT NULL AND updated_at > now() - interval '5 minutes')
		FROM error_group_jobs`).Scan(&result.Workers.LiveClaims, &result.Workers.Active5M); err != nil {
		return nil, fmt.Errorf("admin worker health: %w", err)
	}

	rows, err = q.pool.Query(ctx, `SELECT status::text, count(*) FROM error_groups GROUP BY status`)
	if err != nil {
		return nil, fmt.Errorf("admin outcomes by status: %w", err)
	}
	for rows.Next() {
		var key string
		var count int64
		if err := rows.Scan(&key, &count); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan admin outcomes by status: %w", err)
		}
		result.Outcomes.ByStatus[key] = count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate admin outcomes by status: %w", err)
	}
	rows.Close()

	if err := q.pool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE pr_created_at >= now() - interval '24 hours'),
			count(*) FILTER (WHERE pr_created_at >= now() - interval '7 days'),
			count(*) FILTER (WHERE needs_human_at >= now() - interval '7 days')
		FROM error_groups`).Scan(
		&result.Outcomes.PRCreated24H, &result.Outcomes.PRCreated7D, &result.Outcomes.NeedsHuman7D,
	); err != nil {
		return nil, fmt.Errorf("admin lifecycle outcomes: %w", err)
	}

	if err := q.pool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE outcome = 'merged' AND occurred_at >= now() - interval '7 days'),
			count(*) FILTER (WHERE outcome = 'closed' AND occurred_at >= now() - interval '7 days')
		FROM pr_outcomes`).Scan(&result.Outcomes.Merged7D, &result.Outcomes.Closed7D); err != nil {
		return nil, fmt.Errorf("admin PR outcomes: %w", err)
	}

	return result, nil
}

// AdminRecentJobs intentionally returns jobs across all tenants. The caller must
// validate status/jobType against the public allowlists before calling.
func (q *Queries) AdminRecentJobs(ctx context.Context, limit int, status, jobType string) ([]AdminJob, error) {
	// The handler clamps limit too; bound it here as well so the slice
	// allocation and query LIMIT can never depend on an unchecked caller.
	limit = max(1, min(limit, 200))
	rows, err := q.pool.Query(ctx, `
		SELECT
			j.id, coalesce(p.name, ''), j.job_type, j.status::text, j.attempts, j.created_at,
			CASE
				WHEN j.status = 'pending' THEN NULL
				WHEN j.status = 'claimed' THEN extract(epoch FROM now() - j.claimed_at)::double precision
				ELSE extract(epoch FROM j.updated_at - j.claimed_at)::double precision
			END,
			j.last_error, j.trace_url, g.title, g.pr_url
		FROM error_group_jobs j
		LEFT JOIN error_groups g ON g.id = j.error_group_id
		LEFT JOIN projects p ON p.id = j.project_id
		WHERE ($1::text = '' OR j.status::text = $1)
		  AND ($2::text = '' OR j.job_type = $2)
		ORDER BY j.created_at DESC, j.id DESC
		LIMIT $3`, status, jobType, limit)
	if err != nil {
		return nil, fmt.Errorf("admin recent jobs: %w", err)
	}
	defer rows.Close()

	jobs := make([]AdminJob, 0, limit)
	for rows.Next() {
		var job AdminJob
		if err := rows.Scan(
			&job.ID, &job.ProjectName, &job.JobType, &job.Status, &job.Attempts, &job.CreatedAt,
			&job.DurationSeconds, &job.LastError, &job.TraceURL, &job.IncidentTitle, &job.PRURL,
		); err != nil {
			return nil, fmt.Errorf("scan admin recent jobs: %w", err)
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate admin recent jobs: %w", err)
	}
	return jobs, nil
}
