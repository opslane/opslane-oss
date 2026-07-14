package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/grouping"
	"github.com/opslane/opslane/packages/ingestion/masking"
)

// IngestEvent handles POST /api/v1/events (error events only).
func (d *Dependencies) IngestEvent(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		if err.Error() == "http: request body too large" {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	d.ingestErrorEvent(w, r, body)
}

// IngestErrorEvent handles direct POST /api/v1/events calls (used by existing tests).
// Reads body from r.Body and delegates to ingestErrorEvent.
func (d *Dependencies) IngestErrorEvent(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		if err.Error() == "http: request body too large" {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	d.ingestErrorEvent(w, r, body)
}

// ingestErrorEvent processes an error event from pre-read body bytes.
func (d *Dependencies) ingestErrorEvent(w http.ResponseWriter, r *http.Request, body []byte) {
	start := time.Now()

	projectID := ProjectIDFromCtx(r.Context())
	environmentID := EnvironmentIDFromCtx(r.Context())

	if projectID == "" || environmentID == "" {
		RecordIngestError("missing_tenant_context")
		writeJSONError(w, http.StatusUnauthorized, "missing tenant context")
		return
	}

	var payload struct {
		Timestamp string `json:"timestamp"`
		Error     struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Stack   string `json:"stack"`
		} `json:"error"`
		Breadcrumbs json.RawMessage `json:"breadcrumbs"`
		Context     json.RawMessage `json:"context"`
		SDKVersion  string          `json:"sdk_version"`
		Release     string          `json:"release"`
		SessionID   string          `json:"session_id"`
	}

	if err := json.Unmarshal(body, &payload); err != nil {
		RecordIngestError("invalid_json")
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate: message is the only required error field. type and stack are
	// optional — many real browser errors have no stack (cross-origin
	// "Script error.", non-Error promise rejections) and must not be dropped.
	if payload.Error.Message == "" {
		RecordIngestError("missing_error_fields")
		writeJSONError(w, http.StatusBadRequest, "error.message is required")
		return
	}

	// Default an empty type BEFORE fingerprinting/title/insert so stackless
	// groups don't fragment on an empty type string.
	if payload.Error.Type == "" {
		payload.Error.Type = "Error"
	}

	// Track stackless events so we can measure recovery volume in prod.
	if payload.Error.Stack == "" {
		RecordStacklessAccepted()
	}

	// Compute fingerprint
	fingerprint := grouping.Fingerprint(payload.Error.Type, payload.Error.Message, payload.Error.Stack)

	// Generate title: "Type: Message" truncated to 200 chars
	title := payload.Error.Type + ": " + payload.Error.Message
	if len(title) > 200 {
		title = title[:200]
	}

	// Default breadcrumbs/context
	breadcrumbs := "[]"
	if len(payload.Breadcrumbs) > 0 {
		breadcrumbs = string(payload.Breadcrumbs)
	}
	ctx := "{}"
	if len(payload.Context) > 0 {
		ctx = string(payload.Context)
	}

	// Extract end-user identity from context.user (B2B tracking)
	type contextUser struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		AccountID   string `json:"account_id"`
		AccountName string `json:"account_name"`
	}
	var endUser contextUser
	if len(payload.Context) > 0 {
		var ctxObj struct {
			User *contextUser `json:"user"`
		}
		_ = json.Unmarshal(payload.Context, &ctxObj) // best-effort
		if ctxObj.User != nil && ctxObj.User.ID != "" {
			endUser = *ctxObj.User
		}
	}

	if d.Queries == nil {
		RecordIngestError("no_db")
		writeJSONError(w, http.StatusInternalServerError, "database unavailable")
		return
	}

	// Redact secrets before persistence. End-user identity was already extracted
	// from raw context above, so B2B tracking remains intact. RedactBreadcrumbs only
	// scrubs each crumb's "data" field, so layer RedactBody over the whole serialized
	// array to also catch bare tokens/JWTs in free-text fields (e.g. "message"),
	// matching the per-value coverage RedactContext already gives the context object.
	breadcrumbs = masking.RedactURL(masking.RedactBody(string(masking.RedactBreadcrumbs([]byte(breadcrumbs)))))
	ctx = string(masking.RedactContext([]byte(ctx)))

	result, err := d.Queries.InsertErrorEventAndGroup(r.Context(), db.IngestParams{
		ProjectID:          projectID,
		EnvironmentID:      environmentID,
		ErrorType:          payload.Error.Type,
		ErrorMessage:       payload.Error.Message,
		StackTraceRaw:      payload.Error.Stack,
		Fingerprint:        fingerprint,
		Title:              title,
		Breadcrumbs:        breadcrumbs,
		Context:            ctx,
		Release:            payload.Release,
		SessionID:          payload.SessionID,
		EndUserID:          endUser.ID,
		EndUserEmail:       endUser.Email,
		EndUserAccountID:   endUser.AccountID,
		EndUserAccountName: endUser.AccountName,
	})
	if err != nil {
		RecordIngestError("db_error")
		writeJSONError(w, http.StatusInternalServerError, "failed to process event")
		return
	}

	RecordEventIngested()
	if result.IsNew || result.Requeued {
		RecordJobEnqueued()
	}
	RecordIngestDuration(time.Since(start).Seconds())

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{
		"event_id":       result.EventID,
		"group_id":       result.GroupID,
		"error_group_id": result.GroupID,
	})
}
