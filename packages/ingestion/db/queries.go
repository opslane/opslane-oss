package db

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrTokenReuse is returned when a previously consumed refresh token is presented again,
// indicating a potential token theft. All tokens in the family are revoked.
var ErrTokenReuse = errors.New("refresh token reuse detected")

// ErrNotInvestigated is returned when TriggerFixJob is called on an incident
// that is not in the fix-triggerable state for its kind.
var ErrNotInvestigated = errors.New("incident not in a fix-triggerable state")

// ErrNoGithubRepo indicates the project has no repo configured for a setup PR.
var ErrNoGithubRepo = errors.New("project has no github_repo")

// Queries wraps a connection pool and provides tenant-scoped database operations.
// All query helpers MUST take tenant scope (project_id or org_id) as required parameter.
type Queries struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Queries {
	return &Queries{pool: pool}
}

// Pool exposes the underlying pool for health checks and migration runner only.
func (q *Queries) Pool() *pgxpool.Pool {
	return q.pool
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// === Tenant hierarchy ===

type Org struct {
	ID        string
	Name      string
	CreatedAt time.Time
}

type Project struct {
	ID            string
	OrgID         string
	Name          string
	GithubRepo    *string
	DefaultBranch string
	CreatedAt     time.Time
}

type Environment struct {
	ID        string
	ProjectID string
	Name      string
	CreatedAt time.Time
}

type APIKeyResult struct {
	ID        string
	RawKey    string // only available at creation time
	KeyPrefix string
}

type APIKeyLookup struct {
	EnvironmentID  string
	ProjectID      string
	OrgID          string
	AllowedOrigins []string
}

// OrgExists checks whether an org with the given ID exists.
func (q *Queries) OrgExists(ctx context.Context, orgID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM orgs WHERE id = $1)`, orgID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check org exists: %w", err)
	}
	return exists, nil
}

func (q *Queries) CreateOrg(ctx context.Context, name string) (*Org, error) {
	var org Org
	err := q.pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ($1) RETURNING id, name, created_at`,
		name,
	).Scan(&org.ID, &org.Name, &org.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create org: %w", err)
	}
	return &org, nil
}

func (q *Queries) CreateProject(ctx context.Context, orgID, name string, githubRepo *string) (*Project, error) {
	var p Project
	err := q.pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name, github_repo)
		 VALUES ($1, $2, $3)
		 RETURNING id, org_id, name, github_repo, default_branch, created_at`,
		orgID, name, githubRepo,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create project: %w", err)
	}
	return &p, nil
}

func (q *Queries) CreateEnvironment(ctx context.Context, projectID, name string) (*Environment, error) {
	var env Environment
	err := q.pool.QueryRow(ctx,
		`INSERT INTO environments (project_id, name)
		 VALUES ($1, $2)
		 RETURNING id, project_id, name, created_at`,
		projectID, name,
	).Scan(&env.ID, &env.ProjectID, &env.Name, &env.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create environment: %w", err)
	}
	return &env, nil
}

// CreateAPIKey generates a new API key for an environment.
// The raw key is returned once; only a hash is stored.
func (q *Queries) CreateAPIKey(ctx context.Context, environmentID string) (*APIKeyResult, error) {
	rawKey := fmt.Sprintf("def_%s", uuid.New().String())
	keyHash := hashKey(rawKey)
	keyPrefix := rawKey[:12]

	var result APIKeyResult
	err := q.pool.QueryRow(ctx,
		`INSERT INTO environment_api_keys (environment_id, key_hash, key_prefix)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		environmentID, keyHash, keyPrefix,
	).Scan(&result.ID)
	if err != nil {
		return nil, fmt.Errorf("create api key: %w", err)
	}

	result.RawKey = rawKey
	result.KeyPrefix = keyPrefix
	return &result, nil
}

// LookupAPIKey resolves a raw API key to the full tenant chain.
// Returns error if key is not found or has been revoked.
func (q *Queries) LookupAPIKey(ctx context.Context, rawKey string) (*APIKeyLookup, error) {
	keyHash := hashKey(rawKey)

	var lookup APIKeyLookup
	err := q.pool.QueryRow(ctx,
		`SELECT e.id, p.id, o.id, p.allowed_origins
		 FROM environment_api_keys ak
		 JOIN environments e ON ak.environment_id = e.id
		 JOIN projects p ON e.project_id = p.id
		 JOIN orgs o ON p.org_id = o.id
		 WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
		keyHash,
	).Scan(&lookup.EnvironmentID, &lookup.ProjectID, &lookup.OrgID, &lookup.AllowedOrigins)
	if err != nil {
		return nil, fmt.Errorf("lookup api key: %w", err)
	}
	return &lookup, nil
}

func hashKey(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return fmt.Sprintf("%x", h)
}

// nonRetriableReasonCodes lists needs_human reason codes that represent permanent
// failures and should NOT trigger re-queuing on recurrence.
var nonRetriableReasonCodes = map[string]struct{}{
	"policy_blocked": {},
	"auth_invalid":   {},
	// Stackless / no-app-frame errors (cross-origin "Script error.", non-Error
	// promise rejections) are inherently unfixable. Don't auto-reopen the single
	// collapsed group on every recurrence.
	"unfixable_no_app_frames": {},
	"triage_unfixable":        {},
	// Gate failures: the agent tried and could not confidently fix. Keep the
	// writeup terminal on recurrence rather than wiping it and re-investigating.
	"low_confidence_fix": {},
	"tests_failed":       {},
}

// requeueStatuses defines error group statuses eligible for re-queuing when a new
// occurrence arrives. Active states (queued, analyzing) are excluded to prevent double-queuing.
// Note: "archived" is intentionally excluded — archived groups are considered permanently
// dismissed by the user and should not auto-requeue on recurrence. Users must manually
// unarchive first if they want the group re-investigated.
var requeueStatuses = map[string]struct{}{
	"resolved":    {},
	"needs_human": {},
	"merged":      {},
}

// isRequeueEligible returns true if a group should be re-queued on recurrence.
// Non-retriable needs_human reason codes (e.g. policy_blocked) are excluded.
func isRequeueEligible(groupStatus string, reasonCode *string) bool {
	if _, ok := requeueStatuses[groupStatus]; !ok {
		return false
	}
	if groupStatus == "needs_human" && reasonCode != nil {
		_, nonRetriable := nonRetriableReasonCodes[*reasonCode]
		return !nonRetriable
	}
	return true
}

// === Error groups ===

type ErrorGroup struct {
	ID                  string
	ProjectID           string
	Fingerprint         string
	Title               string
	FirstSeen           time.Time
	LastSeen            time.Time
	OccurrenceCount     int
	AffectedUsersCount  int
	Status              string
	Kind                string
	ReasonCode          *string
	ReasonMessage       *string
	Remediation         *string
	Confidence          *string
	PrURL               *string
	RootCause           *string
	SuggestedMitigation *string
	SignalType          *string
	ElementSelector     *string
	PageURLNormalized   *string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	MergedAt            *time.Time
	ResolvedAt          *time.Time
	ArchivedAt          *time.Time
}

type IngestParams struct {
	ProjectID     string
	EnvironmentID string
	ErrorType     string
	ErrorMessage  string
	StackTraceRaw string
	Fingerprint   string
	Title         string
	Breadcrumbs   string // JSON, defaults to "[]"
	Context       string // JSON, defaults to "{}"
	Release       string // source map lookup
	SessionID     string // links error event to replay
	// EventTime is the validated client-side event time (issue #27). Zero
	// means "unknown" and falls back to server arrival time. It feeds
	// error_events.timestamp and group/junction impact times; created_at
	// always keeps server arrival time.
	EventTime time.Time

	// B2B end-user identity (optional, extracted from context.user)
	EndUserID          string
	EndUserEmail       string
	EndUserAccountID   string
	EndUserAccountName string
}

type IngestResult struct {
	EventID  string
	GroupID  string
	JobID    string
	IsNew    bool
	Requeued bool // true if an existing group was re-queued due to recurrence policy
}

// evidencePinDays keeps incident-linked recordings available while the
// incident is fresh. The retention hard cap remains authoritative.
const evidencePinDays = 30

// InsertErrorEventAndGroup atomically inserts an error event, upserts the error group,
// and creates a queue job — all in a single transaction.
func (q *Queries) InsertErrorEventAndGroup(ctx context.Context, p IngestParams) (*IngestResult, error) {
	if p.Breadcrumbs == "" {
		p.Breadcrumbs = "[]"
	}
	if p.Context == "" {
		p.Context = "{}"
	}

	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// 0. Verify environment belongs to project (defense-in-depth)
	var envOK bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM environments WHERE id = $1 AND project_id = $2)`,
		p.EnvironmentID, p.ProjectID,
	).Scan(&envOK)
	if err != nil {
		return nil, fmt.Errorf("verify environment-project: %w", err)
	}
	if !envOK {
		return nil, fmt.Errorf("environment %s does not belong to project %s", p.EnvironmentID, p.ProjectID)
	}

	now := time.Now()

	// Client event time (issue #27): when the browser told us when the error
	// happened, persist that; otherwise fall back to server arrival time.
	eventTime := p.EventTime
	if eventTime.IsZero() {
		eventTime = now
	}

	// 1. Insert error event
	var eventID string
	err = tx.QueryRow(ctx,
		`INSERT INTO error_events (project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw, breadcrumbs, context, release, session_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
		 RETURNING id`,
		p.ProjectID, p.EnvironmentID, eventTime, p.ErrorType, p.ErrorMessage, p.StackTraceRaw, p.Breadcrumbs, p.Context, nilIfEmpty(p.Release), nilIfEmpty(p.SessionID),
	).Scan(&eventID)
	if err != nil {
		return nil, fmt.Errorf("insert error event: %w", err)
	}

	// Pin the referenced always-on recording in the same transaction as the
	// event insert. An unknown session id intentionally matches zero rows: old
	// SDKs and out-of-order delivery must not make event ingestion fail.
	if p.SessionID != "" {
		if _, err := tx.Exec(ctx,
			`UPDATE sessions
			    SET retain_until = GREATEST(
			        COALESCE(retain_until, 'epoch'::timestamptz),
			        now() + make_interval(days => $3))
			  WHERE id = $1 AND project_id = $2`,
			p.SessionID, p.ProjectID, evidencePinDays,
		); err != nil {
			return nil, fmt.Errorf("pin session for evidence: %w", err)
		}
	}

	// 2. Upsert error group
	var groupID string
	var isNew bool
	err = tx.QueryRow(ctx,
		`INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, occurrence_count, sample_event_id)
		 VALUES ($1, $2, $3, $4, $4, 1, $5)
		 ON CONFLICT (project_id, fingerprint) DO UPDATE
		   SET first_seen = LEAST(error_groups.first_seen, $4),
		       last_seen = GREATEST(error_groups.last_seen, $4),
		       occurrence_count = error_groups.occurrence_count + 1,
		       sample_event_id = $5,
		       updated_at = now()
		 RETURNING id, (xmax = 0) AS is_new`,
		p.ProjectID, p.Fingerprint, p.Title, eventTime, eventID,
	).Scan(&groupID, &isNew)
	if err != nil {
		return nil, fmt.Errorf("upsert error group: %w", err)
	}

	// 3. Link event to group
	_, err = tx.Exec(ctx,
		`UPDATE error_events SET error_group_id = $1 WHERE id = $2`,
		groupID, eventID,
	)
	if err != nil {
		return nil, fmt.Errorf("link event to group: %w", err)
	}

	// 3b. Upsert end-user identity if provided (B2B tracking)
	if p.EndUserID != "" {
		var endUserDBID string
		err = tx.QueryRow(ctx,
			`INSERT INTO end_users (project_id, external_user_id, external_account_id, email, account_name, first_seen, last_seen)
			 VALUES ($1, $2, $3, $4, $5, $6, $6)
			 ON CONFLICT (project_id, external_user_id) DO UPDATE
			   SET last_seen = $6,
			       email = COALESCE(NULLIF($4, ''), end_users.email),
			       external_account_id = COALESCE(NULLIF($3, ''), end_users.external_account_id),
			       account_name = COALESCE(NULLIF($5, ''), end_users.account_name)
			 RETURNING id`,
			p.ProjectID, p.EndUserID, nilIfEmpty(p.EndUserAccountID), nilIfEmpty(p.EndUserEmail), nilIfEmpty(p.EndUserAccountName), now,
		).Scan(&endUserDBID)
		if err != nil {
			return nil, fmt.Errorf("upsert end user: %w", err)
		}

		// Link event to end user
		_, err = tx.Exec(ctx,
			`UPDATE error_events SET end_user_id = $1 WHERE id = $2`,
			endUserDBID, eventID,
		)
		if err != nil {
			return nil, fmt.Errorf("link event to end user: %w", err)
		}

		// Upsert affected user junction
		_, err = tx.Exec(ctx,
			`INSERT INTO error_group_affected_users (error_group_id, end_user_id, first_seen, last_seen, occurrence_count)
			 VALUES ($1, $2, $3, $3, 1)
			 ON CONFLICT (error_group_id, end_user_id) DO UPDATE
			   SET first_seen = LEAST(error_group_affected_users.first_seen, $3),
			       last_seen = GREATEST(error_group_affected_users.last_seen, $3),
			       occurrence_count = error_group_affected_users.occurrence_count + 1`,
			groupID, endUserDBID, eventTime,
		)
		if err != nil {
			return nil, fmt.Errorf("upsert affected user: %w", err)
		}

		// Update affected_users_count on the error group
		_, err = tx.Exec(ctx,
			`UPDATE error_groups
			 SET affected_users_count = (SELECT COUNT(*) FROM error_group_affected_users WHERE error_group_id = $1)
			 WHERE id = $1`,
			groupID,
		)
		if err != nil {
			return nil, fmt.Errorf("update affected users count: %w", err)
		}
	}

	// 4. Create queue job (new groups always, existing groups per requeue policy)
	var jobID string
	var requeued bool

	if isNew {
		err = tx.QueryRow(ctx,
			`INSERT INTO error_group_jobs (error_group_id, project_id)
			 VALUES ($1, $2)
			 RETURNING id`,
			groupID, p.ProjectID,
		).Scan(&jobID)
		if err != nil {
			return nil, fmt.Errorf("insert queue job: %w", err)
		}

		_, err = tx.Exec(ctx,
			`UPDATE error_groups SET status = 'queued' WHERE id = $1`,
			groupID,
		)
		if err != nil {
			return nil, fmt.Errorf("update group status to queued: %w", err)
		}
	} else {
		var groupStatus string
		var reasonCode *string
		err = tx.QueryRow(ctx,
			`SELECT status, reason_code FROM error_groups WHERE id = $1 AND project_id = $2`,
			groupID, p.ProjectID,
		).Scan(&groupStatus, &reasonCode)
		if err != nil {
			return nil, fmt.Errorf("query group status for requeue check: %w", err)
		}

		if isRequeueEligible(groupStatus, reasonCode) {
			err = tx.QueryRow(ctx,
				`INSERT INTO error_group_jobs (error_group_id, project_id)
				 VALUES ($1, $2)
				 RETURNING id`,
				groupID, p.ProjectID,
			).Scan(&jobID)
			if err != nil {
				return nil, fmt.Errorf("insert requeue job: %w", err)
			}

			_, err = tx.Exec(ctx,
				`UPDATE error_groups
				 SET status = 'queued',
				     reason_code = NULL,
				     reason_message = NULL,
				     remediation = NULL,
				     root_cause = NULL,
				     suggested_mitigation = NULL,
				     merged_at = NULL,
				     resolved_at = NULL,
				     archived_at = NULL,
				     updated_at = now()
				 WHERE id = $1`,
				groupID,
			)
			if err != nil {
				return nil, fmt.Errorf("update group status to queued on requeue: %w", err)
			}
			requeued = true
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &IngestResult{
		EventID:  eventID,
		GroupID:  groupID,
		JobID:    jobID,
		IsNew:    isNew,
		Requeued: requeued,
	}, nil
}

// ErrorGroupFilters provides optional filtering for ListErrorGroups.
type ErrorGroupFilters struct {
	AccountID string // filter by external_account_id via end_users junction
	EndUserID string // filter by external_user_id via end_users junction
	Status    string // filter by error group status
}

// ListErrorGroups returns error groups for a project with optional filters. Tenant-scoped.
func (q *Queries) ListErrorGroups(ctx context.Context, projectID string, filters *ErrorGroupFilters) ([]ErrorGroup, error) {
	query := `SELECT DISTINCT eg.id, eg.project_id, eg.fingerprint, eg.title, eg.first_seen, eg.last_seen,
		        eg.occurrence_count, eg.affected_users_count, eg.status, eg.kind,
		        eg.reason_code, eg.reason_message, eg.remediation,
		        eg.confidence, eg.pr_url, eg.root_cause, eg.suggested_mitigation,
		        eg.signal_type, eg.element_selector, eg.page_url_normalized,
		        eg.created_at, eg.updated_at,
		        eg.merged_at, eg.resolved_at, eg.archived_at
		 FROM error_groups eg`

	args := []interface{}{projectID}
	argIdx := 2
	wheres := []string{"eg.project_id = $1", "eg.status <> 'candidate'"}

	needsJoin := filters != nil && (filters.AccountID != "" || filters.EndUserID != "")
	if needsJoin {
		query += ` JOIN error_group_affected_users eau ON eau.error_group_id = eg.id
		           JOIN end_users eu ON eu.id = eau.end_user_id`
	}

	if filters != nil {
		if filters.Status != "" {
			wheres = append(wheres, fmt.Sprintf("eg.status = $%d", argIdx))
			args = append(args, filters.Status)
			argIdx++
		}
		if filters.AccountID != "" {
			wheres = append(wheres, fmt.Sprintf("eu.external_account_id = $%d", argIdx))
			args = append(args, filters.AccountID)
			argIdx++
		}
		if filters.EndUserID != "" {
			wheres = append(wheres, fmt.Sprintf("eu.external_user_id = $%d", argIdx))
			args = append(args, filters.EndUserID)
			argIdx++
		}
	}

	query += " WHERE " + strings.Join(wheres, " AND ")
	query += " ORDER BY eg.last_seen DESC LIMIT 100"

	rows, err := q.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list error groups: %w", err)
	}
	defer rows.Close()

	var groups []ErrorGroup
	for rows.Next() {
		var g ErrorGroup
		err := rows.Scan(
			&g.ID, &g.ProjectID, &g.Fingerprint, &g.Title, &g.FirstSeen, &g.LastSeen,
			&g.OccurrenceCount, &g.AffectedUsersCount, &g.Status, &g.Kind,
			&g.ReasonCode, &g.ReasonMessage, &g.Remediation,
			&g.Confidence, &g.PrURL, &g.RootCause, &g.SuggestedMitigation,
			&g.SignalType, &g.ElementSelector, &g.PageURLNormalized,
			&g.CreatedAt, &g.UpdatedAt,
			&g.MergedAt, &g.ResolvedAt, &g.ArchivedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan error group: %w", err)
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

// === B2B read queries ===

type EndUser struct {
	ID                string
	ProjectID         string
	ExternalUserID    string
	ExternalAccountID *string
	Email             *string
	DisplayName       *string
	FirstSeen         time.Time
	LastSeen          time.Time
}

type AffectedUser struct {
	EndUserID         string
	ExternalUserID    string
	Email             *string
	ExternalAccountID *string
	FirstSeen         time.Time
	LastSeen          time.Time
	OccurrenceCount   int
}

type Account struct {
	ExternalAccountID string
	AccountName       *string
	UserCount         int
	IncidentCount     int
	LastSeen          time.Time
}

// ListAffectedUsers returns end users affected by a specific error group. Tenant-scoped.
func (q *Queries) ListAffectedUsers(ctx context.Context, projectID, errorGroupID string) ([]AffectedUser, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT eu.id, eu.external_user_id, eu.email, eu.external_account_id,
		        eau.first_seen, eau.last_seen, eau.occurrence_count
		 FROM error_group_affected_users eau
		 JOIN end_users eu ON eu.id = eau.end_user_id
		 JOIN error_groups eg ON eg.id = eau.error_group_id
		 WHERE eau.error_group_id = $1 AND eg.project_id = $2
		 ORDER BY eau.last_seen DESC`,
		errorGroupID, projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list affected users: %w", err)
	}
	defer rows.Close()

	var users []AffectedUser
	for rows.Next() {
		var u AffectedUser
		if err := rows.Scan(&u.EndUserID, &u.ExternalUserID, &u.Email, &u.ExternalAccountID,
			&u.FirstSeen, &u.LastSeen, &u.OccurrenceCount); err != nil {
			return nil, fmt.Errorf("scan affected user: %w", err)
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// ListAccounts returns aggregated accounts for a project. Tenant-scoped.
func (q *Queries) ListAccounts(ctx context.Context, projectID string, query *string) ([]Account, error) {
	sql := `SELECT eu.external_account_id,
	               MAX(eu.account_name) AS account_name,
	               COUNT(DISTINCT eu.id) AS user_count,
	               COUNT(DISTINCT eau.error_group_id) AS incident_count,
	               MAX(eu.last_seen) AS last_seen
	        FROM end_users eu
	        LEFT JOIN error_group_affected_users eau ON eau.end_user_id = eu.id
	        WHERE eu.project_id = $1 AND eu.external_account_id IS NOT NULL`

	args := []interface{}{projectID}
	if query != nil && *query != "" {
		sql += ` AND (eu.external_account_id ILIKE $2 OR eu.account_name ILIKE $2)`
		args = append(args, "%"+*query+"%")
	}
	sql += ` GROUP BY eu.external_account_id ORDER BY last_seen DESC LIMIT 100`

	rows, err := q.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	defer rows.Close()

	var accounts []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(&a.ExternalAccountID, &a.AccountName, &a.UserCount,
			&a.IncidentCount, &a.LastSeen); err != nil {
			return nil, fmt.Errorf("scan account: %w", err)
		}
		accounts = append(accounts, a)
	}
	return accounts, rows.Err()
}

// GetAccountByID returns a single account by exact external_account_id. Tenant-scoped.
func (q *Queries) GetAccountByID(ctx context.Context, projectID, externalAccountID string) (*Account, error) {
	var a Account
	err := q.pool.QueryRow(ctx,
		`SELECT eu.external_account_id,
		        MAX(eu.account_name) AS account_name,
		        COUNT(DISTINCT eu.id) AS user_count,
		        COUNT(DISTINCT eau.error_group_id) AS incident_count,
		        MAX(eu.last_seen) AS last_seen
		 FROM end_users eu
		 LEFT JOIN error_group_affected_users eau ON eau.end_user_id = eu.id
		 WHERE eu.project_id = $1 AND eu.external_account_id = $2
		 GROUP BY eu.external_account_id`,
		projectID, externalAccountID,
	).Scan(&a.ExternalAccountID, &a.AccountName, &a.UserCount, &a.IncidentCount, &a.LastSeen)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get account by id: %w", err)
	}
	return &a, nil
}

// GetErrorGroup returns a single error group by ID, scoped to project. Tenant-scoped.
func (q *Queries) GetErrorGroup(ctx context.Context, projectID, groupID string) (*ErrorGroup, error) {
	var g ErrorGroup
	err := q.pool.QueryRow(ctx,
		`SELECT id, project_id, fingerprint, title, first_seen, last_seen,
		        occurrence_count, affected_users_count, status, kind,
		        reason_code, reason_message, remediation,
		        confidence, pr_url, root_cause, suggested_mitigation,
		        signal_type, element_selector, page_url_normalized,
		        created_at, updated_at,
		        merged_at, resolved_at, archived_at
		 FROM error_groups
		 WHERE id = $1 AND project_id = $2 AND status <> 'candidate'`,
		groupID, projectID,
	).Scan(
		&g.ID, &g.ProjectID, &g.Fingerprint, &g.Title, &g.FirstSeen, &g.LastSeen,
		&g.OccurrenceCount, &g.AffectedUsersCount, &g.Status, &g.Kind,
		&g.ReasonCode, &g.ReasonMessage, &g.Remediation,
		&g.Confidence, &g.PrURL, &g.RootCause, &g.SuggestedMitigation,
		&g.SignalType, &g.ElementSelector, &g.PageURLNormalized,
		&g.CreatedAt, &g.UpdatedAt,
		&g.MergedAt, &g.ResolvedAt, &g.ArchivedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get error group: %w", err)
	}
	return &g, nil
}

// GetLatestJobTraceURL returns the trace_url from the most recent job for an error group.
// Tenant-scoped via error_groups join.
func (q *Queries) GetLatestJobTraceURL(ctx context.Context, projectID, errorGroupID string) (*string, error) {
	var traceURL *string
	err := q.pool.QueryRow(ctx,
		`SELECT egj.trace_url
		 FROM error_group_jobs egj
		 JOIN error_groups eg ON eg.id = egj.error_group_id
		 WHERE egj.error_group_id = $1 AND eg.project_id = $2
		 ORDER BY egj.created_at DESC LIMIT 1`,
		errorGroupID, projectID,
	).Scan(&traceURL)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get latest job trace url: %w", err)
	}
	return traceURL, nil
}

// TriggerFixJob atomically transitions an incident from its kind-specific
// fix-triggerable state to 'fixing' and creates a human-triggered fix job.
// Returns the new job ID or an error. Tenant-scoped.
func (q *Queries) TriggerFixJob(ctx context.Context, projectID, groupID, guidance string) (string, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Atomically check and transition status
	var id string
	err = tx.QueryRow(ctx,
		`UPDATE error_groups
		 SET status = 'fixing', updated_at = now()
		 WHERE id = $1 AND project_id = $2
		   AND (
		     (kind = 'error' AND status = 'investigated')
		     OR
		     (kind = 'friction' AND status = 'awaiting_approval')
		   )
		 RETURNING id`,
		groupID, projectID,
	).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", ErrNotInvestigated
	}
	if err != nil {
		return "", fmt.Errorf("update error group status: %w", err)
	}

	// Create fix job
	var jobID string
	err = tx.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, guidance, triggered_by)
		 VALUES ($1, $2, 'fix', $3, 'human')
		 RETURNING id`,
		groupID, projectID, nilIfEmpty(guidance),
	).Scan(&jobID)
	if err != nil {
		return "", fmt.Errorf("insert fix job: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}

	return jobID, nil
}

// EnqueueSetupPrJob enqueues a setup_pr job for the project. Idempotent: returns
// the existing pending/claimed job id if one is already in flight. Tenant-scoped by orgID.
func (q *Queries) EnqueueSetupPrJob(ctx context.Context, orgID, projectID string) (string, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var repo *string
	err = tx.QueryRow(ctx, `SELECT github_repo FROM projects WHERE id = $1 AND org_id = $2`, projectID, orgID).Scan(&repo)
	if err == pgx.ErrNoRows {
		return "", ErrNoGithubRepo
	}
	if err != nil {
		return "", fmt.Errorf("lookup project: %w", err)
	}
	if repo == nil || *repo == "" {
		return "", ErrNoGithubRepo
	}

	var existing string
	err = tx.QueryRow(ctx,
		`SELECT id FROM error_group_jobs
		  WHERE project_id = $1 AND job_type = 'setup_pr' AND status IN ('pending','claimed')
		  ORDER BY created_at DESC LIMIT 1`,
		projectID,
	).Scan(&existing)
	if err == nil {
		if cErr := tx.Commit(ctx); cErr != nil {
			return "", fmt.Errorf("commit tx: %w", cErr)
		}
		return existing, nil
	}
	if err != pgx.ErrNoRows {
		return "", fmt.Errorf("check in-flight: %w", err)
	}

	var jobID string
	err = tx.QueryRow(ctx,
		`INSERT INTO error_group_jobs (project_id, job_type) VALUES ($1, 'setup_pr') RETURNING id`,
		projectID,
	).Scan(&jobID)
	if err != nil {
		return "", fmt.Errorf("insert setup_pr job: %w", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE projects SET setup_pr_status = 'pending', setup_pr_error = NULL WHERE id = $1`, projectID); err != nil {
		return "", fmt.Errorf("set project status: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	return jobID, nil
}

type SetupPrInfo struct {
	Status   *string
	PRURL    *string
	PRNumber *int
	Error    *string
}

func (q *Queries) GetSetupPrStatus(ctx context.Context, orgID, projectID string) (*SetupPrInfo, error) {
	var s SetupPrInfo
	err := q.pool.QueryRow(ctx,
		`SELECT setup_pr_status, setup_pr_url, setup_pr_number, setup_pr_error
		   FROM projects WHERE id = $1 AND org_id = $2`,
		projectID, orgID,
	).Scan(&s.Status, &s.PRURL, &s.PRNumber, &s.Error)
	if err != nil {
		return nil, fmt.Errorf("get setup pr status: %w", err)
	}
	return &s, nil
}

// === Replay + Source Map ===

// ReplayArtifact represents a screenshot or recording artifact for a replay.
type ReplayArtifact struct {
	ID          string
	Kind        string
	ObjectKey   string
	ContentType string
	Width       int
	Height      int
}

// InsertReplay creates a session_replays row.
func (q *Queries) InsertReplay(ctx context.Context, id, projectID string, errorGroupID, errorEventID *string,
	sessionID, triggerType, pageURL, startedAt, endedAt, objectKey string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO session_replays (id, project_id, error_group_id, error_event_id, session_id, trigger_type, page_url, started_at, ended_at, status, object_key)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
		id, projectID, errorGroupID, errorEventID, sessionID, triggerType,
		nilIfEmpty(pageURL), nilIfEmpty(startedAt), nilIfEmpty(endedAt), objectKey)
	return err
}

// GroupIDForEvent returns the error_group_id for an error event within a project,
// or "" if the event is unknown or not yet grouped. Used by ReplayInit to derive
// the group when the SDK only sends an error_event_id (contract C1).
func (q *Queries) GroupIDForEvent(ctx context.Context, eventID, projectID string) (string, error) {
	var gid *string
	err := q.pool.QueryRow(ctx,
		`SELECT error_group_id FROM error_events WHERE id = $1 AND project_id = $2`,
		eventID, projectID).Scan(&gid)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if gid == nil {
		return "", nil
	}
	return *gid, nil
}

// GetReplayObjectKey returns the recording object key for a completed replay within a
// project, or "" if not found / not complete. Used by the retrieval endpoint.
func (q *Queries) GetReplayObjectKey(ctx context.Context, replayID, projectID string) (string, error) {
	var key string
	err := q.pool.QueryRow(ctx,
		`SELECT object_key FROM session_replays
		  WHERE id = $1 AND project_id = $2 AND status = 'complete' AND object_key IS NOT NULL`,
		replayID, projectID).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return key, err
}

// ReplayIDForGroup returns the best-matching completed replay for an error group.
// Matches direct group links, direct event links, and the legacy sample-event
// session_id fallback. Results are ranked by match precision (group > event >
// session) and then recency, so an unrelated replay that merely shares a session_id
// can never outrank an exact group/event match. Keep in sync with worker correlation.
func (q *Queries) ReplayIDForGroup(ctx context.Context, errorGroupID, projectID string) (string, error) {
	var id string
	err := q.pool.QueryRow(ctx,
		`SELECT sr.id
		   FROM session_replays sr
		  WHERE sr.project_id = $2
		    AND sr.status = 'complete'
		    AND (
		      sr.error_group_id = $1
		      OR sr.error_event_id IN (
		        SELECT ee.id FROM error_events ee
		        WHERE ee.error_group_id = $1 AND ee.project_id = $2
		      )
		      OR sr.session_id IN (
		        SELECT ee.session_id FROM error_events ee
		        JOIN error_groups eg ON eg.sample_event_id = ee.id
		        WHERE eg.id = $1 AND eg.project_id = $2 AND ee.session_id IS NOT NULL
		      )
		    )
		  ORDER BY
		    CASE
		      WHEN sr.error_group_id = $1 THEN 0
		      WHEN sr.error_event_id IN (
		        SELECT ee.id FROM error_events ee
		        WHERE ee.error_group_id = $1 AND ee.project_id = $2
		      ) THEN 1
		      ELSE 2
		    END,
		    sr.created_at DESC
		  LIMIT 1`,
		errorGroupID, projectID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// ReplayBelongsToProject checks ownership of a replay within a project.
func (q *Queries) ReplayBelongsToProject(ctx context.Context, replayID, projectID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM session_replays WHERE id = $1 AND project_id = $2)`,
		replayID, projectID).Scan(&exists)
	return exists, err
}

// FailReplay marks a pending replay terminally failed. Project-scoped.
func (q *Queries) FailReplay(ctx context.Context, replayID, projectID, reason string) error {
	tag, err := q.pool.Exec(ctx,
		`UPDATE session_replays
		    SET status = 'failed'
		  WHERE id = $1 AND project_id = $2 AND status = 'pending'`,
		replayID, projectID,
	)
	if err != nil {
		return fmt.Errorf("fail replay: %w", err)
	}
	if tag.RowsAffected() == 0 {
		slog.Warn("fail replay matched no pending row", "replay_id", replayID, "reason", reason)
	}
	return nil
}

// CompleteReplay atomically inserts artifacts and updates replay status.
// Amendment #11: wrapped in pgx transaction for atomicity.
func (q *Queries) CompleteReplay(ctx context.Context, replayID string, signals string,
	artifacts []ReplayArtifact) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, a := range artifacts {
		_, err := tx.Exec(ctx,
			`INSERT INTO session_replay_artifacts (id, replay_id, kind, object_key, content_type, width, height)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			a.ID, replayID, a.Kind, a.ObjectKey, a.ContentType, a.Width, a.Height)
		if err != nil {
			return fmt.Errorf("insert artifact: %w", err)
		}
	}

	_, err = tx.Exec(ctx,
		`UPDATE session_replays SET status = 'complete', replay_signals = $1::jsonb WHERE id = $2`,
		signals, replayID)
	if err != nil {
		return fmt.Errorf("update replay status: %w", err)
	}

	return tx.Commit(ctx)
}

// InsertSourceMap upserts a source map entry.
func (q *Queries) InsertSourceMap(ctx context.Context, projectID, release, filename, objectKey string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO source_maps (project_id, release, filename, object_key)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (project_id, release, filename) DO UPDATE SET object_key = $4, uploaded_at = now()`,
		projectID, release, filename, objectKey)
	return err
}

// UpdateErrorGroupStatus updates the status of an error group.
// If status is 'needs_human', reason fields are required.
type StatusUpdate struct {
	ProjectID     string
	GroupID       string
	Status        string
	ReasonCode    *string
	ReasonMessage *string
	Remediation   *string
	Confidence    *string
	PrURL         *string
}

func (q *Queries) UpdateErrorGroupStatus(ctx context.Context, u StatusUpdate) error {
	if u.Status == "needs_human" {
		if u.ReasonCode == nil || u.ReasonMessage == nil || u.Remediation == nil {
			return fmt.Errorf("needs_human requires reason_code, reason_message, and remediation")
		}
	}

	ct, err := q.pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = $3::error_group_status,
		     reason_code = $4,
		     reason_message = $5,
		     remediation = $6,
		     confidence = $7,
		     pr_url = $8,
		     updated_at = now()
		 WHERE id = $1 AND project_id = $2`,
		u.GroupID, u.ProjectID, u.Status,
		u.ReasonCode, u.ReasonMessage, u.Remediation,
		u.Confidence, u.PrURL,
	)
	if err != nil {
		return fmt.Errorf("update error group status: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("update error group status: no matching row for group %s in project %s", u.GroupID, u.ProjectID)
	}
	return nil
}

// === Resolution lifecycle ===

// TransitionOnPRMerge transitions an error group from pr_created to merged.
// Matches by github_repo (owner/repo) + pr_number. Returns the group ID or empty string if no match.
// Assumption: github_repo + pr_number + status='pr_created' is unique in practice.
// If multiple projects share the same repo, only one arbitrary match is updated.
// At pilot scale (3-4 partners) this is acceptable; revisit if multi-project-per-repo is needed.
func (q *Queries) TransitionOnPRMerge(ctx context.Context, githubRepo string, prNumber int) (string, error) {
	var groupID string
	err := q.pool.QueryRow(ctx,
		`UPDATE error_groups eg
		 SET status = 'merged', merged_at = now(), updated_at = now()
		 FROM projects p
		 WHERE eg.project_id = p.id
		   AND p.github_repo = $1
		   AND eg.pr_number = $2
		   AND eg.status = 'pr_created'
		 RETURNING eg.id`,
		githubRepo, prNumber,
	).Scan(&groupID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("transition on PR merge: %w", err)
	}
	return groupID, nil
}

// TransitionOnPRClose transitions an error group from pr_created back to investigated
// when a PR is closed without merging. Clears PR fields.
func (q *Queries) TransitionOnPRClose(ctx context.Context, githubRepo string, prNumber int) (string, error) {
	var groupID string
	err := q.pool.QueryRow(ctx,
		`UPDATE error_groups eg
		 SET status = 'investigated', pr_url = NULL, pr_number = NULL, updated_at = now()
		 FROM projects p
		 WHERE eg.project_id = p.id
		   AND p.github_repo = $1
		   AND eg.pr_number = $2
		   AND eg.status = 'pr_created'
		 RETURNING eg.id`,
		githubRepo, prNumber,
	).Scan(&groupID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("transition on PR close: %w", err)
	}
	return groupID, nil
}

// ResolveErrorGroup manually transitions an error group to resolved.
// Allowed from any status except archived. Tenant-scoped.
func (q *Queries) ResolveErrorGroup(ctx context.Context, projectID, groupID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = 'resolved', resolved_at = now(), updated_at = now()
		 WHERE id = $1 AND project_id = $2 AND status != 'archived'`,
		groupID, projectID,
	)
	if err != nil {
		return fmt.Errorf("resolve error group: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("resolve error group: no matching row (group %s may be archived or not found)", groupID)
	}
	return nil
}

// ArchiveErrorGroup transitions an error group to archived from any status. Tenant-scoped.
func (q *Queries) ArchiveErrorGroup(ctx context.Context, projectID, groupID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = 'archived', archived_at = now(), updated_at = now()
		 WHERE id = $1 AND project_id = $2`,
		groupID, projectID,
	)
	if err != nil {
		return fmt.Errorf("archive error group: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("archive error group: no matching row for group %s in project %s", groupID, projectID)
	}
	return nil
}

// UnarchiveErrorGroup transitions an archived incident to a conservative,
// kind-safe state. Tenant-scoped.
func (q *Queries) UnarchiveErrorGroup(ctx context.Context, projectID, groupID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = CASE WHEN kind = 'friction' THEN 'insight'::error_group_status
		                   ELSE 'investigated'::error_group_status END,
		     archived_at = NULL, updated_at = now()
		 WHERE id = $1 AND project_id = $2 AND status = 'archived'`,
		groupID, projectID,
	)
	if err != nil {
		return fmt.Errorf("unarchive error group: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("unarchive error group: group %s is not archived or not found", groupID)
	}
	return nil
}

// === Users ===

type User struct {
	ID             string
	OrgID          string
	Email          string
	PasswordHash   *string
	Name           string
	GitHubID       *int64
	GitHubUsername *string
	AvatarURL      *string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// GetUserByEmail looks up a user by email. Returns nil if not found.
// Note: no org_id scope — this is called during login before org is known.
// Email is globally unique so this is safe.
func (q *Queries) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	var u User
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, email, password_hash, name, github_id, github_username, avatar_url, created_at, updated_at
		 FROM users WHERE email = $1`,
		email,
	).Scan(&u.ID, &u.OrgID, &u.Email, &u.PasswordHash, &u.Name, &u.GitHubID, &u.GitHubUsername, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user by email: %w", err)
	}
	return &u, nil
}

// GetUserByID looks up a user by ID. Returns nil if not found.
// Note: no org_id scope — called during token refresh where user_id comes
// from a validated refresh token. The user_id is the trust anchor.
func (q *Queries) GetUserByID(ctx context.Context, userID string) (*User, error) {
	var u User
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, email, password_hash, name, github_id, github_username, avatar_url, created_at, updated_at
		 FROM users WHERE id = $1`,
		userID,
	).Scan(&u.ID, &u.OrgID, &u.Email, &u.PasswordHash, &u.Name, &u.GitHubID, &u.GitHubUsername, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user by id: %w", err)
	}
	return &u, nil
}

// GetUserByGitHubID looks up a user by their GitHub ID. Returns nil if not found.
// Note: no org_id scope — this is called during OAuth login before org is known.
func (q *Queries) GetUserByGitHubID(ctx context.Context, githubID int64) (*User, error) {
	var u User
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, email, password_hash, name, github_id, github_username, avatar_url, created_at, updated_at
		 FROM users WHERE github_id = $1`,
		githubID,
	).Scan(&u.ID, &u.OrgID, &u.Email, &u.PasswordHash, &u.Name, &u.GitHubID, &u.GitHubUsername, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user by github id: %w", err)
	}
	return &u, nil
}

// CreateUserGitHub inserts a new user with GitHub identity (no password).
func (q *Queries) CreateUserGitHub(ctx context.Context, orgID, email, name string, githubID int64, githubUsername, avatarURL string) (*User, error) {
	var u User
	err := q.pool.QueryRow(ctx,
		`INSERT INTO users (org_id, email, name, github_id, github_username, avatar_url)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, org_id, email, password_hash, name, github_id, github_username, avatar_url, created_at, updated_at`,
		orgID, email, name, githubID, githubUsername, avatarURL,
	).Scan(&u.ID, &u.OrgID, &u.Email, &u.PasswordHash, &u.Name, &u.GitHubID, &u.GitHubUsername, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create github user: %w", err)
	}
	return &u, nil
}

// LinkUserGitHub links a GitHub identity to an existing user (e.g., email/password user
// who later authenticates via GitHub OAuth).
func (q *Queries) LinkUserGitHub(ctx context.Context, userID string, githubID int64, githubUsername, avatarURL string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET github_id = $2, github_username = $3, avatar_url = $4, updated_at = now()
		 WHERE id = $1`,
		userID, githubID, githubUsername, avatarURL,
	)
	if err != nil {
		return fmt.Errorf("link github user: %w", err)
	}
	return nil
}

// UpdateUserGitHub refreshes GitHub profile fields on each login.
func (q *Queries) UpdateUserGitHub(ctx context.Context, userID, githubUsername, avatarURL, email string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET github_username = $2, avatar_url = $3, email = $4, updated_at = now()
		 WHERE id = $1`,
		userID, githubUsername, avatarURL, email,
	)
	if err != nil {
		return fmt.Errorf("update github user: %w", err)
	}
	return nil
}

// SetOrgGitHubInstallation stores the GitHub App installation ID on an org.
func (q *Queries) SetOrgGitHubInstallation(ctx context.Context, orgID string, installationID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE orgs SET github_installation_id = $2 WHERE id = $1`,
		orgID, installationID,
	)
	if err != nil {
		return fmt.Errorf("set org github installation: %w", err)
	}
	return nil
}

// GetOrgGitHubInstallation returns the GitHub App installation ID for an org.
// Returns 0 if not set.
func (q *Queries) GetOrgGitHubInstallation(ctx context.Context, orgID string) (int64, error) {
	var installationID *int64
	err := q.pool.QueryRow(ctx,
		`SELECT github_installation_id FROM orgs WHERE id = $1`,
		orgID,
	).Scan(&installationID)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get org github installation: %w", err)
	}
	if installationID == nil {
		return 0, nil
	}
	return *installationID, nil
}

// === Refresh Tokens ===

// StoreRefreshToken inserts a hashed refresh token for a user with a family ID
// for rotation reuse detection.
func (q *Queries) StoreRefreshToken(ctx context.Context, userID, tokenHash, familyID string, expiresAt time.Time) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		userID, tokenHash, familyID, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("store refresh token: %w", err)
	}
	return nil
}

// ConsumeRefreshToken atomically marks a refresh token as used (soft-delete via revoked_at)
// and returns the user_id and family_id for issuing a replacement.
//
// If the token was already revoked, this indicates token reuse (theft).
// In that case, ALL tokens in the family are revoked and ErrTokenReuse is returned.
//
// Returns ("", "", nil) if the token is not found or expired.
func (q *Queries) ConsumeRefreshToken(ctx context.Context, tokenHash string) (userID, familyID string, err error) {
	// Atomic consume: UPDATE ... RETURNING ensures only one concurrent caller wins.
	err = q.pool.QueryRow(ctx,
		`UPDATE refresh_tokens SET revoked_at = now()
		 WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL
		 RETURNING user_id, family_id`,
		tokenHash,
	).Scan(&userID, &familyID)

	if err == pgx.ErrNoRows {
		// Token not found, expired, or already revoked.
		// Check if it was a previously-revoked token (reuse detection).
		// Grace period: ignore tokens revoked in the last 5 seconds to avoid
		// a race where a concurrent legitimate refresh triggers false reuse.
		var fID string
		err2 := q.pool.QueryRow(ctx,
			`SELECT family_id FROM refresh_tokens
			 WHERE token_hash = $1 AND revoked_at IS NOT NULL
			 AND revoked_at < now() - INTERVAL '5 seconds'`,
			tokenHash,
		).Scan(&fID)
		if err2 == nil {
			// Reuse detected — revoke entire family
			if _, rErr := q.pool.Exec(ctx,
				`UPDATE refresh_tokens SET revoked_at = now()
				 WHERE family_id = $1 AND revoked_at IS NULL`,
				fID,
			); rErr != nil {
				slog.Error("failed to revoke token family on reuse detection",
					"family_id", fID, "error", rErr)
			}
			return "", "", ErrTokenReuse
		}
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("consume refresh token: %w", err)
	}
	return userID, familyID, nil
}

// RevokeAllUserRefreshTokens revokes all active refresh tokens for a user (logout).
func (q *Queries) RevokeAllUserRefreshTokens(ctx context.Context, userID string) (int64, error) {
	ct, err := q.pool.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = now()
		 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID,
	)
	if err != nil {
		return 0, fmt.Errorf("revoke all user refresh tokens: %w", err)
	}
	return ct.RowsAffected(), nil
}

// CleanupExpiredTokens removes expired/revoked refresh tokens and auth codes
// older than 1 day. Returns counts of deleted rows.
func (q *Queries) CleanupExpiredTokens(ctx context.Context) (int64, int64, error) {
	ct1, err := q.pool.Exec(ctx,
		`DELETE FROM refresh_tokens
		 WHERE (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '1 day')
		    OR (expires_at < now() - INTERVAL '1 day')`)
	if err != nil {
		return 0, 0, fmt.Errorf("cleanup refresh tokens: %w", err)
	}
	ct2, err := q.pool.Exec(ctx,
		`DELETE FROM oauth_authorization_codes WHERE expires_at < now() - INTERVAL '1 day'`)
	if err != nil {
		return ct1.RowsAffected(), 0, fmt.Errorf("cleanup auth codes: %w", err)
	}
	return ct1.RowsAffected(), ct2.RowsAffected(), nil
}

// === OAuth Authorization Codes ===

type AuthCodeResult struct {
	UserID              string
	CodeChallenge       string
	CodeChallengeMethod string
	RedirectURI         string
	ClientID            string
}

// StoreAuthorizationCode inserts a hashed authorization code.
func (q *Queries) StoreAuthorizationCode(ctx context.Context, userID, codeHash, codeChallenge, codeChallengeMethod, redirectURI, clientID string, expiresAt time.Time) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO oauth_authorization_codes (user_id, code_hash, code_challenge, code_challenge_method, redirect_uri, client_id, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		userID, codeHash, codeChallenge, codeChallengeMethod, redirectURI, clientID, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("store authorization code: %w", err)
	}
	return nil
}

// ConsumeAuthorizationCode atomically marks an auth code as used and returns
// the associated data. Returns nil if code not found, already used, or expired.
func (q *Queries) ConsumeAuthorizationCode(ctx context.Context, codeHash string) (*AuthCodeResult, error) {
	var result AuthCodeResult
	err := q.pool.QueryRow(ctx,
		`UPDATE oauth_authorization_codes
		 SET used_at = now()
		 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING user_id, code_challenge, code_challenge_method, redirect_uri, client_id`,
		codeHash,
	).Scan(&result.UserID, &result.CodeChallenge, &result.CodeChallengeMethod, &result.RedirectURI, &result.ClientID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("consume authorization code: %w", err)
	}
	return &result, nil
}

// === Project lookup (org-scoped tenant check) ===

// ListProjectsByOrg returns all projects for a given org. Tenant-scoped.
func (q *Queries) ListProjectsByOrg(ctx context.Context, orgID string) ([]Project, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, org_id, name, github_repo, default_branch, created_at
		 FROM projects
		 WHERE org_id = $1
		 ORDER BY created_at ASC`,
		orgID,
	)
	if err != nil {
		return nil, fmt.Errorf("list projects by org: %w", err)
	}
	defer rows.Close()

	var projects []Project
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

// GetProjectByOrgID returns a project by ID within the given org. Returns nil if not found
// or if the project belongs to a different org (tenant-scoped).
func (q *Queries) GetProjectByOrgID(ctx context.Context, orgID, projectID string) (*Project, error) {
	var p Project
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, name, github_repo, default_branch, created_at
		 FROM projects WHERE id = $1 AND org_id = $2`,
		projectID, orgID,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project by id: %w", err)
	}
	return &p, nil
}

// UpdateProject updates a project's github_repo. Tenant-scoped by orgID.
func (q *Queries) UpdateProject(ctx context.Context, orgID, projectID string, githubRepo *string) (*Project, error) {
	var p Project
	err := q.pool.QueryRow(ctx,
		`UPDATE projects SET github_repo = $3
		 WHERE id = $2 AND org_id = $1
		 RETURNING id, org_id, name, github_repo, default_branch, created_at`,
		orgID, projectID, githubRepo,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("update project: %w", err)
	}
	return &p, nil
}

// ListEnvironments returns all environments for a project. Tenant-scoped.
func (q *Queries) ListEnvironments(ctx context.Context, projectID string) ([]Environment, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, project_id, name, created_at
		 FROM environments WHERE project_id = $1
		 ORDER BY created_at`,
		projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list environments: %w", err)
	}
	defer rows.Close()

	var envs []Environment
	for rows.Next() {
		var e Environment
		if err := rows.Scan(&e.ID, &e.ProjectID, &e.Name, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan environment: %w", err)
		}
		envs = append(envs, e)
	}
	return envs, rows.Err()
}

// APIKeyInfo is the read-only view of an API key (no raw key or hash).
type APIKeyInfo struct {
	ID              string
	EnvironmentID   string
	EnvironmentName string
	KeyPrefix       string
	RevokedAt       *time.Time
	CreatedAt       time.Time
}

// ListAPIKeys returns API keys for all environments in a project. Tenant-scoped.
func (q *Queries) ListAPIKeys(ctx context.Context, projectID string) ([]APIKeyInfo, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT eak.id, eak.environment_id, e.name, eak.key_prefix, eak.revoked_at, eak.created_at
		 FROM environment_api_keys eak
		 JOIN environments e ON e.id = eak.environment_id
		 WHERE e.project_id = $1
		 ORDER BY eak.created_at DESC`,
		projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list api keys: %w", err)
	}
	defer rows.Close()

	var keys []APIKeyInfo
	for rows.Next() {
		var k APIKeyInfo
		if err := rows.Scan(&k.ID, &k.EnvironmentID, &k.EnvironmentName, &k.KeyPrefix, &k.RevokedAt, &k.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan api key: %w", err)
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// HasEvents checks if a project has any error events. Uses EXISTS for performance.
func (q *Queries) HasEvents(ctx context.Context, projectID string) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM error_events WHERE project_id = $1)`,
		projectID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has events: %w", err)
	}
	return exists, nil
}

// VerifyEnvironmentAccess checks that an environment belongs to the given org.
// Returns the project_id if the environment is owned, empty string if not found.
func (q *Queries) VerifyEnvironmentAccess(ctx context.Context, orgID, envID string) (string, error) {
	var projectID string
	err := q.pool.QueryRow(ctx,
		`SELECT e.project_id FROM environments e
		 JOIN projects p ON p.id = e.project_id
		 WHERE e.id = $1 AND p.org_id = $2`,
		envID, orgID,
	).Scan(&projectID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("verify environment access: %w", err)
	}
	return projectID, nil
}

// === Transaction variants for composite operations ===

// CreateProjectTx creates a project within an existing transaction.
func (q *Queries) CreateProjectTx(ctx context.Context, tx pgx.Tx, orgID, name string, githubRepo *string) (*Project, error) {
	var p Project
	err := tx.QueryRow(ctx,
		`INSERT INTO projects (org_id, name, github_repo)
		 VALUES ($1, $2, $3)
		 RETURNING id, org_id, name, github_repo, default_branch, created_at`,
		orgID, name, githubRepo,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create project tx: %w", err)
	}
	return &p, nil
}

// CreateEnvironmentTx creates an environment within an existing transaction.
func (q *Queries) CreateEnvironmentTx(ctx context.Context, tx pgx.Tx, projectID, name string) (*Environment, error) {
	var env Environment
	err := tx.QueryRow(ctx,
		`INSERT INTO environments (project_id, name)
		 VALUES ($1, $2)
		 RETURNING id, project_id, name, created_at`,
		projectID, name,
	).Scan(&env.ID, &env.ProjectID, &env.Name, &env.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create environment tx: %w", err)
	}
	return &env, nil
}

// === GitHub config CRUD ===

// SetProjectGitHubConfig stores the GitHub repo for a project. Tenant-scoped by orgID.
func (q *Queries) SetProjectGitHubConfig(ctx context.Context, orgID, projectID, githubRepo string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE projects SET github_repo = $3
		 WHERE id = $2 AND org_id = $1`,
		orgID, projectID, githubRepo,
	)
	if err != nil {
		return fmt.Errorf("set project github config: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("set project github config: no matching project %s in org %s", projectID, orgID)
	}
	return nil
}

// ClearProjectGitHubConfig clears the GitHub repo association for a project. Tenant-scoped by orgID.
func (q *Queries) ClearProjectGitHubConfig(ctx context.Context, orgID, projectID string) error {
	ct, err := q.pool.Exec(ctx,
		`UPDATE projects SET github_repo = NULL
		 WHERE id = $2 AND org_id = $1`,
		orgID, projectID,
	)
	if err != nil {
		return fmt.Errorf("clear project github config: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("clear project github config: no matching project %s in org %s", projectID, orgID)
	}
	return nil
}

// GetProjectGitHubConfig returns the GitHub repo for a project. Tenant-scoped by orgID.
func (q *Queries) GetProjectGitHubConfig(ctx context.Context, orgID, projectID string) (githubRepo *string, err error) {
	err = q.pool.QueryRow(ctx,
		`SELECT github_repo FROM projects WHERE id = $1 AND org_id = $2`,
		projectID, orgID,
	).Scan(&githubRepo)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project github config: %w", err)
	}
	return githubRepo, nil
}

// CreateAPIKeyTx generates a new API key within an existing transaction.
func (q *Queries) CreateAPIKeyTx(ctx context.Context, tx pgx.Tx, environmentID string) (*APIKeyResult, error) {
	rawKey := fmt.Sprintf("def_%s", uuid.New().String())
	keyHash := hashKey(rawKey)
	keyPrefix := rawKey[:12]

	var result APIKeyResult
	err := tx.QueryRow(ctx,
		`INSERT INTO environment_api_keys (environment_id, key_hash, key_prefix)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		environmentID, keyHash, keyPrefix,
	).Scan(&result.ID)
	if err != nil {
		return nil, fmt.Errorf("create api key tx: %w", err)
	}

	result.RawKey = rawKey
	result.KeyPrefix = keyPrefix
	return &result, nil
}

// === Agent sessions ===

// AgentSession represents a CLI-initiated auth session for agent-first onboarding.
type AgentSession struct {
	ID              string
	RepoURL         string
	AgentName       *string
	Status          string // pending | completed | expired
	OrgID           *string
	ProjectID       *string
	APIKeyPlaintext *string
	InstallationID  *int64
	CreatedAt       time.Time
	CompletedAt     *time.Time
	ExpiresAt       time.Time
}

// CreateAgentSession creates a new pending agent session for the given repo URL.
func (q *Queries) CreateAgentSession(ctx context.Context, repoURL string, agentName *string) (*AgentSession, error) {
	var s AgentSession
	err := q.pool.QueryRow(ctx,
		`INSERT INTO agent_sessions (repo_url, agent_name)
		 VALUES ($1, $2)
		 RETURNING id, repo_url, agent_name, status, org_id, project_id,
		           api_key_plaintext, installation_id, created_at, completed_at, expires_at`,
		repoURL, agentName,
	).Scan(&s.ID, &s.RepoURL, &s.AgentName, &s.Status, &s.OrgID, &s.ProjectID,
		&s.APIKeyPlaintext, &s.InstallationID, &s.CreatedAt, &s.CompletedAt, &s.ExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("create agent session: %w", err)
	}
	return &s, nil
}

// GetAgentSession returns an agent session by ID. Returns nil if not found.
func (q *Queries) GetAgentSession(ctx context.Context, sessionID string) (*AgentSession, error) {
	var s AgentSession
	err := q.pool.QueryRow(ctx,
		`SELECT id, repo_url, agent_name, status, org_id, project_id,
		        api_key_plaintext, installation_id, created_at, completed_at, expires_at
		 FROM agent_sessions WHERE id = $1`,
		sessionID,
	).Scan(&s.ID, &s.RepoURL, &s.AgentName, &s.Status, &s.OrgID, &s.ProjectID,
		&s.APIKeyPlaintext, &s.InstallationID, &s.CreatedAt, &s.CompletedAt, &s.ExpiresAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get agent session: %w", err)
	}
	return &s, nil
}

// CompleteAgentSession marks a pending session as completed with the provisioned resources.
// Returns false if session was not in pending state or is expired.
func (q *Queries) CompleteAgentSession(ctx context.Context, sessionID string, orgID, projectID, apiKeyPlaintext string, installationID int64) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions
		 SET status = 'completed', org_id = $2, project_id = $3,
		     api_key_plaintext = $4, installation_id = $5, completed_at = now()
		 WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
		sessionID, orgID, projectID, apiKeyPlaintext, installationID,
	)
	if err != nil {
		return false, fmt.Errorf("complete agent session: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// ClaimAgentSessionKey atomically retrieves and nullifies the plaintext API key.
// Only the first caller gets the key; subsequent calls return nil.
//
// Uses a two-CTE pattern: SELECT FOR UPDATE to lock and read the old value,
// then UPDATE to nullify. PostgreSQL RETURNING yields post-update values,
// so a single UPDATE ... RETURNING api_key_plaintext would return NULL.
func (q *Queries) ClaimAgentSessionKey(ctx context.Context, sessionID string) (*string, error) {
	var key string
	err := q.pool.QueryRow(ctx,
		`WITH to_claim AS (
		   SELECT id, api_key_plaintext
		   FROM agent_sessions
		   WHERE id = $1 AND api_key_plaintext IS NOT NULL
		   FOR UPDATE
		 ), do_nullify AS (
		   UPDATE agent_sessions
		   SET api_key_plaintext = NULL
		   FROM to_claim
		   WHERE agent_sessions.id = to_claim.id
		 )
		 SELECT api_key_plaintext FROM to_claim`,
		sessionID,
	).Scan(&key)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("claim agent session key: %w", err)
	}
	return &key, nil
}

// ExpireAgentSessions marks all pending sessions past their expiry as expired.
// Called periodically by the cleanup goroutine.
func (q *Queries) ExpireAgentSessions(ctx context.Context) (int64, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE agent_sessions SET status = 'expired'
		 WHERE status = 'pending' AND expires_at <= now()`,
	)
	if err != nil {
		return 0, fmt.Errorf("expire agent sessions: %w", err)
	}
	return tag.RowsAffected(), nil
}

// FindProjectByRepoURL returns the project for a given repo URL (owner/repo format).
// Used by the agent setup flow to detect returning users.
// Returns nil if no project matches.
func (q *Queries) FindProjectByRepoURL(ctx context.Context, repoURL string) (*Project, error) {
	var p Project
	err := q.pool.QueryRow(ctx,
		`SELECT id, org_id, name, github_repo, default_branch, created_at
		 FROM projects
		 WHERE github_repo = $1
		 ORDER BY created_at ASC
		 LIMIT 1`,
		repoURL,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find project by repo url: %w", err)
	}
	return &p, nil
}

// === GitHub App installations ===

// GitHubAppInstallation represents a GitHub App installation with org mapping.
type GitHubAppInstallation struct {
	ID             string
	InstallationID int64
	GithubOrgName  string
	GithubOrgID    int64
	OrgID          string
	Repos          []byte // raw JSONB
	Suspended      bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// UpsertGitHubAppInstallation creates or updates a GitHub App installation record.
func (q *Queries) UpsertGitHubAppInstallation(ctx context.Context, installationID int64, githubOrgName string, githubOrgID int64, orgID string, repos []byte) (*GitHubAppInstallation, error) {
	var i GitHubAppInstallation
	err := q.pool.QueryRow(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (installation_id) DO UPDATE
		 SET github_org_name = EXCLUDED.github_org_name,
		     repos = EXCLUDED.repos,
		     updated_at = now()
		 RETURNING id, installation_id, github_org_name, github_org_id, org_id, repos, suspended, created_at, updated_at`,
		installationID, githubOrgName, githubOrgID, orgID, repos,
	).Scan(&i.ID, &i.InstallationID, &i.GithubOrgName, &i.GithubOrgID, &i.OrgID,
		&i.Repos, &i.Suspended, &i.CreatedAt, &i.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("upsert github app installation: %w", err)
	}
	return &i, nil
}

// GetGitHubAppInstallationByID returns an installation by GitHub's installation ID.
func (q *Queries) GetGitHubAppInstallationByID(ctx context.Context, installationID int64) (*GitHubAppInstallation, error) {
	var i GitHubAppInstallation
	err := q.pool.QueryRow(ctx,
		`SELECT id, installation_id, github_org_name, github_org_id, org_id, repos, suspended, created_at, updated_at
		 FROM github_app_installations WHERE installation_id = $1`,
		installationID,
	).Scan(&i.ID, &i.InstallationID, &i.GithubOrgName, &i.GithubOrgID, &i.OrgID,
		&i.Repos, &i.Suspended, &i.CreatedAt, &i.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get github app installation: %w", err)
	}
	return &i, nil
}
