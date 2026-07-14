package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

type setGitHubConfigRequest struct {
	GithubRepo string `json:"github_repo"`
}

type gitHubConfigResponse struct {
	GithubRepo string `json:"github_repo"`
	Connected  bool   `json:"connected"`
}

// SetGitHubConfig handles PUT /api/v1/projects/{projectID}/github
// Stores only the repo name — auth comes from the org's GitHub App installation.
func (d *Dependencies) SetGitHubConfig(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	var req setGitHubConfigRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	// Validate repo format
	parts := strings.Split(req.GithubRepo, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		writeJSONError(w, http.StatusBadRequest, "github_repo must be in owner/repo format")
		return
	}

	orgID := OrgIDFromCtx(r.Context())
	if err := d.Queries.SetProjectGitHubConfig(r.Context(), orgID, projectID, req.GithubRepo); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to save GitHub config")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(gitHubConfigResponse{
		GithubRepo: req.GithubRepo,
		Connected:  true,
	})
}

// GetGitHubConfig handles GET /api/v1/projects/{projectID}/github
func (d *Dependencies) GetGitHubConfig(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	orgID := OrgIDFromCtx(r.Context())
	githubRepo, err := d.Queries.GetProjectGitHubConfig(r.Context(), orgID, projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get GitHub config")
		return
	}

	resp := gitHubConfigResponse{
		Connected: githubRepo != nil && *githubRepo != "",
	}
	if githubRepo != nil {
		resp.GithubRepo = *githubRepo
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// DeleteGitHubConfig handles DELETE /api/v1/projects/{projectID}/github
func (d *Dependencies) DeleteGitHubConfig(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	orgID := OrgIDFromCtx(r.Context())
	if err := d.Queries.ClearProjectGitHubConfig(r.Context(), orgID, projectID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to clear GitHub config")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
