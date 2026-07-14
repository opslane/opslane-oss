package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/db"
)

var setupPrLimiter = newRateLimiter(5)

// SetupPR enqueues a setup_pr worker job. POST /api/v1/projects/{projectID}/setup-pr
func (d *Dependencies) SetupPR(w http.ResponseWriter, r *http.Request) {
	if !setupPrLimiter.allow(clientIP(r)) {
		writeJSONError(w, http.StatusTooManyRequests, "too many requests, try again later")
		return
	}
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	orgID := OrgIDFromCtx(r.Context())

	jobID, err := d.Queries.EnqueueSetupPrJob(r.Context(), orgID, projectID)
	if errors.Is(err, db.ErrNoGithubRepo) {
		writeJSONError(w, http.StatusBadRequest, "connect a GitHub repo before opening the setup PR")
		return
	}
	if err != nil {
		slog.Error("setup-pr: enqueue", "error", err, "project_id", projectID)
		writeJSONError(w, http.StatusInternalServerError, "failed to start setup PR")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]any{"job_id": jobID, "status": "pending"})
}

// GetSetupPR returns setup-PR status for the wizard. GET /api/v1/projects/{projectID}/setup-pr
func (d *Dependencies) GetSetupPR(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	orgID := OrgIDFromCtx(r.Context())
	info, err := d.Queries.GetSetupPrStatus(r.Context(), orgID, projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONError(w, http.StatusNotFound, "project not found")
		return
	}
	if err != nil {
		slog.Error("setup-pr: get status", "error", err, "project_id", projectID)
		writeJSONError(w, http.StatusInternalServerError, "failed to get setup PR status")
		return
	}
	status := ""
	if info.Status != nil {
		status = *info.Status
	}
	resp := map[string]any{"status": status, "pr_url": info.PRURL, "pr_number": info.PRNumber}
	if info.Error != nil {
		resp["error"] = *info.Error
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
