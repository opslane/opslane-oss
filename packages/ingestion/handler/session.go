package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/masking"
)

const (
	defaultChunkIntervalMs = 30_000
	maxChunkBytes          = 5 << 20
	maxInlineChunkBytes    = 64 << 10
	// Scrubbing waits this out because POST policies are replayable until expiry.
	chunkUploadPolicyTTL = 30 * time.Second
)

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

func validSessionID(id string) bool {
	return sessionIDPattern.MatchString(id)
}

type sessionInitRequest struct {
	SessionID   string `json:"session_id"`
	StartedAt   string `json:"started_at"`
	PageURL     string `json:"page_url"`
	Environment string `json:"environment"`
	Release     string `json:"release"`
	SDK         *struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"sdk"`
	User *struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		AccountID   string `json:"account_id"`
		AccountName string `json:"account_name"`
	} `json:"user"`
}

type sessionInitResponse struct {
	Recording       bool  `json:"recording"`
	ChunkIntervalMs int   `json:"chunk_interval_ms"`
	MaxChunkBytes   int64 `json:"max_chunk_bytes"`
}

// SessionInit registers a client-generated session and carries the recording
// kill switch. POST /api/v1/sessions/init
func (d *Dependencies) SessionInit(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}
	if d.MinIO == nil && d.Queries == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}
	environmentID := EnvironmentIDFromCtx(r.Context())
	if environmentID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		if err.Error() == "http: request body too large" {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}

	var req sessionInitRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if !validSessionID(req.SessionID) {
		writeJSONError(w, http.StatusBadRequest, "invalid session_id")
		return
	}
	hasSDKIdentity := req.SDK != nil && req.SDK.Name != "" && req.SDK.Version != ""
	// Preserve the cheap replay-only failure path used by deployments without
	// storage. Reporting requests continue so SDK identity can be registered.
	if d.MinIO == nil && !hasSDKIdentity {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}

	tombstoned, err := d.Queries.SessionIsTombstoned(r.Context(), req.SessionID)
	if err != nil {
		slog.Error("tombstone check failed", "error", err, "session_id", req.SessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if tombstoned {
		writeJSONError(w, http.StatusGone, "session has been deleted")
		return
	}
	ownerProjectID, err := d.Queries.SessionOwnerProject(r.Context(), req.SessionID)
	if err != nil {
		slog.Error("session owner check failed", "error", err, "session_id", req.SessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if ownerProjectID != "" && ownerProjectID != projectID {
		RecordSessionCrossProjectConflict()
		writeJSONError(w, http.StatusConflict, "session_id belongs to another project")
		return
	}
	enabled, err := d.Queries.ProjectRecordingEnabled(r.Context(), projectID)
	if err != nil {
		slog.Error("recording flag lookup failed", "error", err, "project_id", projectID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if !enabled && !hasSDKIdentity {
		writeJSON(w, http.StatusOK, sessionInitResponse{Recording: false})
		return
	}

	resolvedEnvironmentID, fallbackReason, err := d.resolvePayloadEnvironment(
		r.Context(), projectID, environmentID, req.Environment,
	)
	if err != nil {
		slog.Error("environment resolution failed", "error", err, "project_id", projectID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if fallbackReason != "" {
		RecordEnvironmentOverrideFallback(fallbackReason)
		if shouldLogEnvironmentFallback(fallbackReason) {
			slog.Warn("session payload environment override fell back to key environment", "reason", fallbackReason, "project_id", projectID)
		}
	}
	environmentID = resolvedEnvironmentID

	startedAt := time.Now()
	if req.StartedAt != "" {
		if parsed, parseErr := time.Parse(time.RFC3339, req.StartedAt); parseErr == nil && parsed.Before(startedAt) {
			startedAt = parsed
		}
	}

	var endUserID *string
	if req.User != nil && req.User.ID != "" {
		id, upsertErr := d.Queries.UpsertEndUser(r.Context(), projectID, req.User.ID,
			req.User.AccountID, req.User.Email, req.User.AccountName)
		if upsertErr != nil {
			slog.Warn("end user upsert failed", "error", upsertErr, "project_id", projectID)
		} else {
			endUserID = &id
		}
	}

	var sdkIdentity *db.SessionSDKIdentity
	if hasSDKIdentity {
		sdkIdentity = &db.SessionSDKIdentity{
			Name: req.SDK.Name, Version: req.SDK.Version, Release: req.Release,
		}
	}
	registration, err := d.Queries.RegisterSession(r.Context(), req.SessionID, projectID, environmentID,
		endUserID, startedAt, masking.RedactURL(req.PageURL), sdkIdentity)
	if err != nil {
		if errors.Is(err, db.ErrSessionTombstoned) {
			writeJSONError(w, http.StatusGone, "session has been deleted")
			return
		}
		if errors.Is(err, db.ErrSessionProjectConflict) {
			RecordSessionCrossProjectConflict()
			writeJSONError(w, http.StatusConflict, "session_id belongs to another project")
			return
		}
		slog.Error("insert session failed", "error", err, "session_id", req.SessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if registration.Diverged {
		RecordEnvironmentSessionDivergence()
	}
	if sdkIdentity != nil {
		if _, err := d.Queries.MarkAgentSessionsAppReporting(r.Context(), projectID); err != nil {
			slog.Error("advance onboarding reporting status failed", "error", err, "project_id", projectID)
			writeJSONError(w, http.StatusInternalServerError, "failed to register session")
			return
		}
	}

	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}
	if !enabled {
		writeJSON(w, http.StatusOK, sessionInitResponse{Recording: false})
		return
	}

	writeJSON(w, http.StatusOK, sessionInitResponse{
		Recording:       true,
		ChunkIntervalMs: defaultChunkIntervalMs,
		MaxChunkBytes:   maxChunkBytes,
	})
}

func chunkObjectKey(projectID, sessionID string, seq int) string {
	return fmt.Sprintf("sessions/%s/%s/chunk-%06d.json.gz", projectID, sessionID, seq)
}

type chunkUploadURLRequest struct {
	Seq             int   `json:"seq"`
	SizeBytes       int64 `json:"size_bytes"`
	HasFullSnapshot bool  `json:"has_full_snapshot"`
}

type chunkUploadURLResponse struct {
	UploadURL string            `json:"upload_url"`
	FormData  map[string]string `json:"form_data"`
	ObjectKey string            `json:"object_key"`
}

// ChunkUploadURL reserves a sequence and issues an exactly size-capped POST
// policy. POST /api/v1/sessions/{sessionID}/chunks/upload-url
func (d *Dependencies) ChunkUploadURL(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}
	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}

	sessionID := chi.URLParam(r, "sessionID")
	if !validSessionID(sessionID) {
		writeJSONError(w, http.StatusBadRequest, "invalid session_id")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<10))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	var req chunkUploadURLRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Seq < 0 {
		writeJSONError(w, http.StatusBadRequest, "seq must be non-negative")
		return
	}
	if req.SizeBytes <= 0 {
		writeJSONError(w, http.StatusBadRequest, "size_bytes must be positive")
		return
	}
	if req.SizeBytes > maxChunkBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "chunk exceeds maximum size")
		return
	}

	enabled, err := d.Queries.ProjectRecordingEnabled(r.Context(), projectID)
	if err != nil {
		slog.Error("recording flag lookup failed", "error", err, "project_id", projectID)
		writeJSONError(w, http.StatusInternalServerError, "failed to issue upload url")
		return
	}
	if !enabled {
		writeJSONError(w, http.StatusForbidden, "recording disabled for this project")
		return
	}
	owned, err := d.Queries.SessionBelongsToProject(r.Context(), sessionID, projectID)
	if err != nil {
		slog.Error("session ownership check failed", "error", err, "session_id", sessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to issue upload url")
		return
	}
	if !owned {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}
	objectKey := chunkObjectKey(projectID, sessionID, req.Seq)
	if err := d.Queries.ReserveChunkSeq(r.Context(), sessionID, projectID, req.Seq, objectKey, req.HasFullSnapshot); err != nil {
		if errors.Is(err, db.ErrChunkSeqTaken) {
			writeJSONError(w, http.StatusConflict, "chunk seq already used")
			return
		}
		slog.Error("reserve chunk seq failed", "error", err, "session_id", sessionID, "seq", req.Seq)
		writeJSONError(w, http.StatusInternalServerError, "failed to issue upload url")
		return
	}
	if !chunkBytesBudget.allow(projectID, req.SizeBytes) {
		_ = d.Queries.ReleaseChunkReservation(r.Context(), sessionID, projectID, req.Seq)
		slog.Warn("chunk byte budget exceeded", "project_id", projectID, "size_bytes", req.SizeBytes)
		writeJSONError(w, http.StatusTooManyRequests, "byte budget exceeded")
		return
	}

	uploadURL, formData, err := d.MinIO.PresignedPostPolicy(
		r.Context(), objectKey, "application/gzip", req.SizeBytes, chunkUploadPolicyTTL)
	if err != nil {
		slog.Error("presign chunk policy failed", "error", err, "object_key", objectKey)
		_ = d.Queries.ReleaseChunkReservation(r.Context(), sessionID, projectID, req.Seq)
		writeJSONError(w, http.StatusInternalServerError, "failed to issue upload url")
		return
	}
	writeJSON(w, http.StatusOK, chunkUploadURLResponse{UploadURL: uploadURL, FormData: formData, ObjectKey: objectKey})
}

// ChunkCommit records a stored chunk using the size observed from storage.
// POST /api/v1/sessions/{sessionID}/chunks/{seq}/commit
func (d *Dependencies) ChunkCommit(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}
	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}
	sessionID := chi.URLParam(r, "sessionID")
	if !validSessionID(sessionID) {
		writeJSONError(w, http.StatusBadRequest, "invalid session_id")
		return
	}
	seq, err := strconv.Atoi(chi.URLParam(r, "seq"))
	if err != nil || seq < 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid seq")
		return
	}
	owned, err := d.Queries.SessionBelongsToProject(r.Context(), sessionID, projectID)
	if err != nil {
		slog.Error("session ownership check failed", "error", err, "session_id", sessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to commit chunk")
		return
	}
	if !owned {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}

	objectKey := chunkObjectKey(projectID, sessionID, seq)
	size, err := d.MinIO.StatObject(r.Context(), objectKey)
	if err != nil {
		slog.Warn("commit for missing object", "object_key", objectKey, "error", err)
		writeJSONError(w, http.StatusConflict, "chunk object not found in storage")
		return
	}
	if err := d.Queries.CommitChunk(r.Context(), sessionID, projectID, seq, size); err != nil {
		if errors.Is(err, db.ErrSessionNotFound) {
			writeJSONError(w, http.StatusNotFound, "chunk reservation not found")
			return
		}
		slog.Error("commit chunk failed", "error", err, "session_id", sessionID, "seq", seq)
		writeJSONError(w, http.StatusInternalServerError, "failed to commit chunk")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "committed"})
}

var gzipMagic = []byte{0x1f, 0x8b}

// ChunkInline stores and commits a keepalive-sized final gzip chunk in one
// request. POST /api/v1/sessions/{sessionID}/chunks/{seq}/inline
func (d *Dependencies) ChunkInline(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}
	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}
	sessionID := chi.URLParam(r, "sessionID")
	if !validSessionID(sessionID) {
		writeJSONError(w, http.StatusBadRequest, "invalid session_id")
		return
	}
	seq, err := strconv.Atoi(chi.URLParam(r, "seq"))
	if err != nil || seq < 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid seq")
		return
	}

	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxInlineChunkBytes))
	if err != nil {
		if err.Error() == "http: request body too large" {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "inline chunk too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	if len(payload) < 2 || !bytes.Equal(payload[:2], gzipMagic) {
		writeJSONError(w, http.StatusBadRequest, "body is not gzip")
		return
	}

	enabled, err := d.Queries.ProjectRecordingEnabled(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	if !enabled {
		writeJSONError(w, http.StatusForbidden, "recording disabled for this project")
		return
	}
	owned, err := d.Queries.SessionBelongsToProject(r.Context(), sessionID, projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	if !owned {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}
	objectKey := chunkObjectKey(projectID, sessionID, seq)
	if err := d.Queries.ReserveChunkSeq(r.Context(), sessionID, projectID, seq, objectKey, false); err != nil {
		if errors.Is(err, db.ErrChunkSeqTaken) {
			writeJSONError(w, http.StatusConflict, "chunk seq already used")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	if !chunkBytesBudget.allow(projectID, int64(len(payload))) {
		_ = d.Queries.ReleaseChunkReservation(r.Context(), sessionID, projectID, seq)
		writeJSONError(w, http.StatusTooManyRequests, "byte budget exceeded")
		return
	}
	putCtx, cancelPut := context.WithTimeout(r.Context(), 30*time.Second)
	putErr := d.MinIO.PutObject(putCtx, objectKey, payload, "application/gzip")
	cancelPut()
	if putErr != nil {
		slog.Error("inline chunk put failed", "error", putErr, "object_key", objectKey)
		_ = d.Queries.ReleaseChunkReservation(r.Context(), sessionID, projectID, seq)
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	if err := d.Queries.CommitChunk(r.Context(), sessionID, projectID, seq, int64(len(payload))); err != nil {
		slog.Error("inline chunk commit failed", "error", err, "session_id", sessionID, "seq", seq)
		_ = d.MinIO.RemoveObject(r.Context(), objectKey)
		_ = d.Queries.ReleaseChunkReservation(r.Context(), sessionID, projectID, seq)
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "committed"})
}
