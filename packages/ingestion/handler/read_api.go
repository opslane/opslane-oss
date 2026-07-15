package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// incidentJSON is the JSON representation of an incident, matching the
// Incident type in shared/src/types.ts. Fields use snake_case.
type incidentJSON struct {
	ID                  string              `json:"id"`
	ProjectID           string              `json:"project_id"`
	Fingerprint         string              `json:"fingerprint"`
	Title               string              `json:"title"`
	Status              string              `json:"status"`
	Kind                string              `json:"kind"`
	FirstSeen           string              `json:"first_seen"`
	LastSeen            string              `json:"last_seen"`
	OccurrenceCount     int                 `json:"occurrence_count"`
	AffectedUsersCount  int                 `json:"affected_users_count"`
	Confidence          *string             `json:"confidence,omitempty"`
	PrURL               *string             `json:"pr_url,omitempty"`
	ReplayID            *string             `json:"replay_id,omitempty"`
	SessionPointer      *sessionPointerJSON `json:"session_pointer,omitempty"`
	Reason              *needsHumanReason   `json:"reason,omitempty"`
	RootCause           *string             `json:"root_cause,omitempty"`
	SuggestedMitigation *string             `json:"suggested_mitigation,omitempty"`
	MergedAt            *string             `json:"merged_at,omitempty"`
	ResolvedAt          *string             `json:"resolved_at,omitempty"`
	ArchivedAt          *string             `json:"archived_at,omitempty"`
	TraceURL            *string             `json:"trace_url,omitempty"`
}

type sessionPointerJSON struct {
	SessionID string `json:"session_id"`
	ErrorAt   string `json:"error_at"`
}

type needsHumanReason struct {
	ReasonCode    string `json:"reason_code"`
	ReasonMessage string `json:"reason_message"`
	Remediation   string `json:"remediation"`
}

// fmtTimePtr formats a nullable time as an RFC3339 string pointer.
func fmtTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(time.RFC3339)
	return &s
}

func toIncidentJSON(g db.ErrorGroup) incidentJSON {
	inc := incidentJSON{
		ID:                  g.ID,
		ProjectID:           g.ProjectID,
		Fingerprint:         g.Fingerprint,
		Title:               g.Title,
		Status:              g.Status,
		Kind:                g.Kind,
		FirstSeen:           g.FirstSeen.Format(time.RFC3339),
		LastSeen:            g.LastSeen.Format(time.RFC3339),
		OccurrenceCount:     g.OccurrenceCount,
		AffectedUsersCount:  g.AffectedUsersCount,
		Confidence:          g.Confidence,
		PrURL:               g.PrURL,
		RootCause:           g.RootCause,
		SuggestedMitigation: g.SuggestedMitigation,
		MergedAt:            fmtTimePtr(g.MergedAt),
		ResolvedAt:          fmtTimePtr(g.ResolvedAt),
		ArchivedAt:          fmtTimePtr(g.ArchivedAt),
	}
	if g.ReasonCode != nil && g.ReasonMessage != nil && g.Remediation != nil {
		inc.Reason = &needsHumanReason{
			ReasonCode:    *g.ReasonCode,
			ReasonMessage: *g.ReasonMessage,
			Remediation:   *g.Remediation,
		}
	}
	return inc
}

// projectJSON is the JSON representation of a project for the dashboard API.
type projectJSON struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	GithubRepo *string `json:"github_repo"`
	CreatedAt  string  `json:"created_at"`
}

func toProjectJSON(p db.Project) projectJSON {
	return projectJSON{
		ID:         p.ID,
		Name:       p.Name,
		GithubRepo: p.GithubRepo,
		CreatedAt:  p.CreatedAt.Format(time.RFC3339),
	}
}

// ListProjects returns all projects for the authenticated user's org.
func (d *Dependencies) ListProjects(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	projects, err := d.Queries.ListProjectsByOrg(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list projects")
		return
	}

	result := make([]projectJSON, 0, len(projects))
	for _, p := range projects {
		result = append(result, toProjectJSON(p))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// verifyProjectAccess checks that the authenticated identity has access to the given project.
// SDK auth: projectID must match the authenticated project (project-scoped).
// Session auth: project's org must match the authenticated org (org-scoped).
func (d *Dependencies) verifyProjectAccess(w http.ResponseWriter, r *http.Request, projectID string) bool {
	// SDK auth path: ProjectIDFromCtx is set
	if authProjectID := ProjectIDFromCtx(r.Context()); authProjectID != "" {
		if authProjectID != projectID {
			writeJSONError(w, http.StatusForbidden, "project mismatch")
			return false
		}
		return true
	}

	// Session auth path: org-scoped check (tenant boundary enforced at query layer)
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return false
	}
	project, err := d.Queries.GetProjectByOrgID(r.Context(), orgID, projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to verify project access")
		return false
	}
	if project == nil {
		writeJSONError(w, http.StatusForbidden, "project not found or does not belong to your organization")
		return false
	}
	return true
}

// ListIncidents returns incidents (error groups) for a project with optional filters.
func (d *Dependencies) ListIncidents(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")

	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	// Parse optional query param filters
	var filters *db.ErrorGroupFilters
	accountID := r.URL.Query().Get("account_id")
	endUserID := r.URL.Query().Get("end_user_id")
	status := r.URL.Query().Get("status")
	if accountID != "" || endUserID != "" || status != "" {
		filters = &db.ErrorGroupFilters{
			AccountID: accountID,
			EndUserID: endUserID,
			Status:    status,
		}
	}

	groups, err := d.Queries.ListErrorGroups(r.Context(), projectID, filters)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list incidents")
		return
	}

	incidents := make([]incidentJSON, 0, len(groups))
	for _, g := range groups {
		incidents = append(incidents, toIncidentJSON(g))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(incidents)
}

// GetIncident returns a single incident (error group) by ID.
func (d *Dependencies) GetIncident(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")

	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	group, err := d.Queries.GetErrorGroup(r.Context(), projectID, incidentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get incident")
		return
	}
	if group == nil {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}

	inc := toIncidentJSON(*group)

	// Attach latest job trace URL (best-effort, non-fatal)
	traceURL, err := d.Queries.GetLatestJobTraceURL(r.Context(), projectID, incidentID)
	if err == nil && traceURL != nil {
		inc.TraceURL = traceURL
	}

	// Attach the linked replay id (best-effort, non-fatal). Dashboard loads the
	// replay itself via the replay-retrieval endpoint (Project D). ReplayIDForGroup
	// ranks matches by precision (group > event > session) over recency.
	if replayID, err := d.Queries.ReplayIDForGroup(r.Context(), incidentID, projectID); err == nil && replayID != "" {
		inc.ReplayID = &replayID
	}
	// Pointer identity is valid before any chunk becomes readable. Readers poll
	// manifest readiness; the incident contract must not hide processing sessions.
	if sessionID, errorAt, ok, err := d.Queries.SessionPointerForGroup(r.Context(), incidentID, projectID); err == nil && ok {
		inc.SessionPointer = &sessionPointerJSON{SessionID: sessionID, ErrorAt: errorAt.Format(time.RFC3339)}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(inc)
}

// === B2B endpoints ===

type affectedUserJSON struct {
	EndUserID         string  `json:"end_user_id"`
	ExternalUserID    string  `json:"external_user_id"`
	Email             *string `json:"email,omitempty"`
	ExternalAccountID *string `json:"external_account_id,omitempty"`
	FirstSeen         string  `json:"first_seen"`
	LastSeen          string  `json:"last_seen"`
	OccurrenceCount   int     `json:"occurrence_count"`
}

type accountJSON struct {
	ExternalAccountID string  `json:"external_account_id"`
	AccountName       *string `json:"account_name,omitempty"`
	UserCount         int     `json:"user_count"`
	IncidentCount     int     `json:"incident_count"`
	LastSeen          string  `json:"last_seen"`
}

// ListAffectedUsers returns end users affected by a specific incident.
func (d *Dependencies) ListAffectedUsers(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	users, err := d.Queries.ListAffectedUsers(r.Context(), projectID, incidentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list affected users")
		return
	}

	result := make([]affectedUserJSON, 0, len(users))
	for _, u := range users {
		result = append(result, affectedUserJSON{
			EndUserID:         u.EndUserID,
			ExternalUserID:    u.ExternalUserID,
			Email:             u.Email,
			ExternalAccountID: u.ExternalAccountID,
			FirstSeen:         u.FirstSeen.Format(time.RFC3339),
			LastSeen:          u.LastSeen.Format(time.RFC3339),
			OccurrenceCount:   u.OccurrenceCount,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// ListAccounts returns aggregated B2B accounts for a project.
func (d *Dependencies) ListAccounts(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	var queryPtr *string
	if q := r.URL.Query().Get("q"); q != "" {
		queryPtr = &q
	}

	accounts, err := d.Queries.ListAccounts(r.Context(), projectID, queryPtr)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list accounts")
		return
	}

	result := make([]accountJSON, 0, len(accounts))
	for _, a := range accounts {
		result = append(result, accountJSON{
			ExternalAccountID: a.ExternalAccountID,
			AccountName:       a.AccountName,
			UserCount:         a.UserCount,
			IncidentCount:     a.IncidentCount,
			LastSeen:          a.LastSeen.Format(time.RFC3339),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// GetAccount returns a single account's details.
func (d *Dependencies) GetAccount(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	accountID := chi.URLParam(r, "accountID")
	a, err := d.Queries.GetAccountByID(r.Context(), projectID, accountID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get account")
		return
	}
	if a == nil {
		writeJSONError(w, http.StatusNotFound, "account not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(accountJSON{
		ExternalAccountID: a.ExternalAccountID,
		AccountName:       a.AccountName,
		UserCount:         a.UserCount,
		IncidentCount:     a.IncidentCount,
		LastSeen:          a.LastSeen.Format(time.RFC3339),
	})
}

// ListAccountIncidents returns incidents filtered by account.
func (d *Dependencies) ListAccountIncidents(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	accountID := chi.URLParam(r, "accountID")
	filters := &db.ErrorGroupFilters{AccountID: accountID}

	groups, err := d.Queries.ListErrorGroups(r.Context(), projectID, filters)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list account incidents")
		return
	}

	incidents := make([]incidentJSON, 0, len(groups))
	for _, g := range groups {
		incidents = append(incidents, toIncidentJSON(g))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(incidents)
}

// === Onboarding CRUD endpoints ===

// CreateProjectEndpoint creates a new project for the authenticated user's org.
// POST /api/v1/projects
func (d *Dependencies) CreateProjectEndpoint(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !onboardingLimiter.allow(ip) {
		writeJSONError(w, http.StatusTooManyRequests, "too many requests, try again later")
		return
	}

	orgID := OrgIDFromCtx(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		Name       string `json:"name"`
		GithubRepo string `json:"github_repo"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeJSONError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(req.Name) > 100 {
		writeJSONError(w, http.StatusBadRequest, "name must be 100 characters or less")
		return
	}

	var githubRepo *string
	if req.GithubRepo != "" {
		githubRepo = &req.GithubRepo
	}

	project, err := d.Queries.CreateProject(r.Context(), orgID, req.Name, githubRepo)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create project")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(toProjectJSON(*project))
}

// UpdateProjectEndpoint updates a project's settings.
// PATCH /api/v1/projects/{projectID}
func (d *Dependencies) UpdateProjectEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	orgID := OrgIDFromCtx(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		GithubRepo *string `json:"github_repo"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	project, err := d.Queries.UpdateProject(r.Context(), orgID, projectID, req.GithubRepo)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to update project")
		return
	}
	if project == nil {
		writeJSONError(w, http.StatusNotFound, "project not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toProjectJSON(*project))
}

// ListEnvironmentsEndpoint returns environments for a project.
// GET /api/v1/projects/{projectID}/environments
func (d *Dependencies) ListEnvironmentsEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	envs, err := d.Queries.ListEnvironments(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list environments")
		return
	}

	result := make([]environmentJSON, 0, len(envs))
	for _, e := range envs {
		result = append(result, environmentJSON{
			ID:        e.ID,
			ProjectID: e.ProjectID,
			Name:      e.Name,
			CreatedAt: e.CreatedAt.Format(time.RFC3339),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// CreateEnvironmentEndpoint creates a new environment for a project.
// POST /api/v1/projects/{projectID}/environments
func (d *Dependencies) CreateEnvironmentEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeJSONError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(req.Name) > 100 {
		writeJSONError(w, http.StatusBadRequest, "name must be 100 characters or less")
		return
	}

	env, err := d.Queries.CreateEnvironment(r.Context(), projectID, req.Name)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
			writeJSONError(w, http.StatusConflict, "environment with this name already exists")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to create environment")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(environmentJSON{
		ID:        env.ID,
		ProjectID: env.ProjectID,
		Name:      env.Name,
		CreatedAt: env.CreatedAt.Format(time.RFC3339),
	})
}

// CreateAPIKeyEndpoint creates a new API key for an environment.
// POST /api/v1/environments/{envID}/api-keys
func (d *Dependencies) CreateAPIKeyEndpoint(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !apiKeyLimiter.allow(ip) {
		writeJSONError(w, http.StatusTooManyRequests, "too many requests, try again later")
		return
	}

	orgID := OrgIDFromCtx(r.Context())
	envID := chi.URLParam(r, "envID")

	// Verify environment belongs to caller's org (tenant isolation)
	projectID, err := d.Queries.VerifyEnvironmentAccess(r.Context(), orgID, envID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if projectID == "" {
		writeJSONError(w, http.StatusNotFound, "environment not found")
		return
	}

	key, err := d.Queries.CreateAPIKey(r.Context(), envID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create API key")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"id":         key.ID,
		"raw_key":    key.RawKey,
		"key_prefix": key.KeyPrefix,
	})
}

// ListAPIKeysEndpoint returns API keys for all environments in a project.
// GET /api/v1/projects/{projectID}/api-keys
func (d *Dependencies) ListAPIKeysEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	keys, err := d.Queries.ListAPIKeys(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list API keys")
		return
	}

	result := make([]apiKeyInfoJSON, 0, len(keys))
	for _, k := range keys {
		info := apiKeyInfoJSON{
			ID:              k.ID,
			EnvironmentID:   k.EnvironmentID,
			EnvironmentName: k.EnvironmentName,
			KeyPrefix:       k.KeyPrefix,
			CreatedAt:       k.CreatedAt.Format(time.RFC3339),
		}
		if k.RevokedAt != nil {
			s := k.RevokedAt.Format(time.RFC3339)
			info.RevokedAt = &s
		}
		result = append(result, info)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// GetEventCountEndpoint returns whether a project has received any events.
// GET /api/v1/projects/{projectID}/event-count
func (d *Dependencies) GetEventCountEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	hasEvents, err := d.Queries.HasEvents(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to check events")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"has_events": hasEvents})
}

// TriggerFix creates a fix job for an incident in its kind-specific trigger state.
// POST /api/v1/projects/{projectID}/incidents/{incidentID}/fix
func (d *Dependencies) TriggerFix(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")

	// Parse optional guidance
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		Guidance string `json:"guidance"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate guidance length
	if len(req.Guidance) > 2000 {
		writeJSONError(w, http.StatusBadRequest, "guidance must be 2000 characters or less")
		return
	}

	// Strip null bytes and control characters from guidance
	guidance := sanitizeGuidance(req.Guidance)

	// Atomically transition status and create fix job
	jobID, err := d.Queries.TriggerFixJob(r.Context(), projectID, incidentID, guidance)
	if err != nil {
		if errors.Is(err, db.ErrNotInvestigated) {
			writeJSONError(w, http.StatusConflict, "incident is not in a fix-triggerable state")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to trigger fix")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"job_id": jobID})
}

// sanitizeGuidance strips null bytes and ASCII control chars (except newline, tab).
func sanitizeGuidance(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == 0 || (r < 0x20 && r != '\n' && r != '\t') {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// respondWithIncident fetches the updated incident and writes it as JSON.
func (d *Dependencies) respondWithIncident(w http.ResponseWriter, r *http.Request, projectID, incidentID string) {
	group, err := d.Queries.GetErrorGroup(r.Context(), projectID, incidentID)
	if err != nil || group == nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to fetch updated incident")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toIncidentJSON(*group))
}

// ResolveIncident manually marks an incident as resolved.
// POST /api/v1/projects/{projectID}/incidents/{incidentID}/resolve
func (d *Dependencies) ResolveIncident(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	if err := d.Queries.ResolveErrorGroup(r.Context(), projectID, incidentID); err != nil {
		if strings.Contains(err.Error(), "no matching row") {
			writeJSONError(w, http.StatusConflict, "incident is archived or not found")
		} else {
			writeJSONError(w, http.StatusInternalServerError, "failed to resolve incident")
		}
		return
	}
	d.respondWithIncident(w, r, projectID, incidentID)
}

// ArchiveIncident dismisses an incident so it no longer appears in the default view.
// POST /api/v1/projects/{projectID}/incidents/{incidentID}/archive
func (d *Dependencies) ArchiveIncident(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	if err := d.Queries.ArchiveErrorGroup(r.Context(), projectID, incidentID); err != nil {
		if strings.Contains(err.Error(), "no matching row") {
			writeJSONError(w, http.StatusConflict, "incident not found")
		} else {
			writeJSONError(w, http.StatusInternalServerError, "failed to archive incident")
		}
		return
	}
	d.respondWithIncident(w, r, projectID, incidentID)
}

// UnarchiveIncident restores an archived incident to a conservative kind-safe state.
// POST /api/v1/projects/{projectID}/incidents/{incidentID}/unarchive
func (d *Dependencies) UnarchiveIncident(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	incidentID := chi.URLParam(r, "incidentID")
	if err := d.Queries.UnarchiveErrorGroup(r.Context(), projectID, incidentID); err != nil {
		if strings.Contains(err.Error(), "no matching row") {
			writeJSONError(w, http.StatusConflict, "incident is not archived or not found")
		} else {
			writeJSONError(w, http.StatusInternalServerError, "failed to unarchive incident")
		}
		return
	}
	d.respondWithIncident(w, r, projectID, incidentID)
}
