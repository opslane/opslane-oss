package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// SessionSummary is the project-scoped metadata exposed by session browsing.
// End-user fields are nullable because anonymous recordings are valid.
type SessionSummary struct {
	ID                 string
	StartedAt          time.Time
	LastChunkAt        *time.Time
	Status             string
	ChunkCount         int
	PlayableChunkCount int
	BytesStored        int64
	PageURL            *string
	EndUserID          *string
	ExternalUserID     *string
	EndUserEmail       *string
	ExternalAccountID  *string
	AccountName        *string
}

type SessionFilters struct {
	EndUserID     string
	AccountID     string
	EnvironmentID string
	From          *time.Time
	To            *time.Time
}

type SessionCursor struct {
	StartedAt time.Time
	ID        string
}

type sessionScanner interface {
	Scan(dest ...any) error
}

func scanSessionSummary(row sessionScanner) (SessionSummary, error) {
	var session SessionSummary
	err := row.Scan(
		&session.ID, &session.StartedAt, &session.LastChunkAt, &session.Status,
		&session.ChunkCount, &session.BytesStored, &session.PageURL,
		&session.EndUserID, &session.ExternalUserID, &session.EndUserEmail,
		&session.ExternalAccountID, &session.AccountName, &session.PlayableChunkCount,
	)
	return session, err
}

const sessionSummarySelect = `SELECT s.id, s.started_at, s.last_chunk_at, s.status,
       s.chunk_count, s.bytes_stored, s.page_url,
       eu.id, eu.external_user_id, eu.email, eu.external_account_id, eu.account_name,
       (SELECT count(*) FROM session_chunks c
         WHERE c.session_id = s.id AND c.scrubbed_at IS NOT NULL)
  FROM sessions s
  LEFT JOIN end_users eu ON eu.id = s.end_user_id`

// ListSessions returns non-deleting project sessions newest-first. It fetches
// one row beyond the requested limit so exactly-full terminal pages do not
// advertise a cursor for a page that does not exist.
func (q *Queries) ListSessions(ctx context.Context, projectID string, filters SessionFilters, cursor *SessionCursor, limit int) ([]SessionSummary, *SessionCursor, error) {
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	var cursorStartedAt *time.Time
	cursorID := ""
	if cursor != nil {
		cursorStartedAt = &cursor.StartedAt
		cursorID = cursor.ID
	}

	rows, err := q.pool.Query(ctx, sessionSummarySelect+`
 WHERE s.project_id = $1
   AND s.status <> 'deleting'
   AND ($2 = '' OR s.end_user_id::text = $2)
   AND ($3 = '' OR eu.external_account_id = $3)
   AND ($4::timestamptz IS NULL OR s.started_at >= $4)
   AND ($5::timestamptz IS NULL OR s.started_at <= $5)
   AND ($6 = '' OR s.environment_id = NULLIF($6, '')::uuid)
   AND ($7::timestamptz IS NULL OR (s.started_at, s.id) < ($7, $8))
 ORDER BY s.started_at DESC, s.id DESC
 LIMIT $9`, projectID, filters.EndUserID, filters.AccountID, filters.From, filters.To,
		filters.EnvironmentID, cursorStartedAt, cursorID, limit+1)
	if err != nil {
		return nil, nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()

	sessions := make([]SessionSummary, 0, limit+1)
	for rows.Next() {
		session, scanErr := scanSessionSummary(rows)
		if scanErr != nil {
			return nil, nil, fmt.Errorf("scan session summary: %w", scanErr)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("list sessions rows: %w", err)
	}

	var next *SessionCursor
	if len(sessions) > limit {
		sessions = sessions[:limit]
		last := sessions[len(sessions)-1]
		next = &SessionCursor{StartedAt: last.StartedAt, ID: last.ID}
	}
	return sessions, next, nil
}

// GetSessionSummary returns nil when the session is absent, belongs to another
// project, or is deleting.
func (q *Queries) GetSessionSummary(ctx context.Context, projectID, sessionID string) (*SessionSummary, error) {
	session, err := scanSessionSummary(q.pool.QueryRow(ctx, sessionSummarySelect+`
 WHERE s.project_id = $1 AND s.id = $2 AND s.status <> 'deleting'`, projectID, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get session summary: %w", err)
	}
	return &session, nil
}

// SessionChunk is a scrubbed chunk manifest entry. ObjectKey is intentionally
// retained only in the DB layer; HTTP manifests never serialize it.
type SessionChunk struct {
	Seq              int
	ObjectKey        string
	SizeBytes        *int64
	DecodedSizeBytes *int64
	HasFullSnapshot  bool
	FirstEventMs     *int64
	LastEventMs      *int64
}

const playableChunksSelect = `SELECT c.seq, c.object_key, c.size_bytes, c.decoded_size_bytes,
       c.has_full_snapshot, c.first_event_ms, c.last_event_ms
  FROM session_chunks c
  JOIN sessions s ON s.id = c.session_id
 WHERE c.project_id = $1 AND c.session_id = $2
   AND s.project_id = $1 AND s.status <> 'deleting'
   AND c.scrubbed_at IS NOT NULL`

func scanSessionChunk(row sessionScanner) (SessionChunk, error) {
	var chunk SessionChunk
	err := row.Scan(&chunk.Seq, &chunk.ObjectKey, &chunk.SizeBytes, &chunk.DecodedSizeBytes,
		&chunk.HasFullSnapshot, &chunk.FirstEventMs, &chunk.LastEventMs)
	return chunk, err
}

// ListPlayableChunks returns only scrubbed chunks, ordered for stitching.
func (q *Queries) ListPlayableChunks(ctx context.Context, projectID, sessionID string) ([]SessionChunk, error) {
	rows, err := q.pool.Query(ctx, playableChunksSelect+` ORDER BY c.seq ASC`, projectID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list playable chunks: %w", err)
	}
	defer rows.Close()

	chunks := make([]SessionChunk, 0)
	for rows.Next() {
		chunk, scanErr := scanSessionChunk(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan playable chunk: %w", scanErr)
		}
		chunks = append(chunks, chunk)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list playable chunks rows: %w", err)
	}
	return chunks, nil
}

// GetPlayableChunk applies the same fail-closed scrub and session-status gates
// as ListPlayableChunks and returns nil for every unavailable case.
func (q *Queries) GetPlayableChunk(ctx context.Context, projectID, sessionID string, seq int) (*SessionChunk, error) {
	chunk, err := scanSessionChunk(q.pool.QueryRow(ctx, playableChunksSelect+` AND c.seq = $3`, projectID, sessionID, seq))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get playable chunk: %w", err)
	}
	return &chunk, nil
}

// SessionPointerForGroup resolves pointer identity independently of chunk
// readiness. The newest ingested occurrence wins, while errorAt comes from the
// event-time column so #27 can improve accuracy without changing this contract.
func (q *Queries) SessionPointerForGroup(ctx context.Context, errorGroupID, projectID string) (sessionID string, errorAt time.Time, ok bool, err error) {
	err = q.pool.QueryRow(ctx,
		`SELECT ee.session_id, ee.timestamp
		   FROM error_events ee
		   JOIN sessions s ON s.id = ee.session_id AND s.project_id = $2
		  WHERE ee.error_group_id = $1 AND ee.project_id = $2
		    AND ee.session_id IS NOT NULL
		    AND s.status <> 'deleting'
		  ORDER BY ee.created_at DESC, ee.id DESC
		  LIMIT 1`, errorGroupID, projectID).Scan(&sessionID, &errorAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, fmt.Errorf("session pointer for group: %w", err)
	}
	return sessionID, errorAt, true, nil
}
