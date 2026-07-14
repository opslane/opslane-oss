package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
)

// maxSourceMapBytes caps a single sourcemap upload. 50 MB was a DoS vector;
// 15 MB comfortably covers large SPA bundle maps.
const maxSourceMapBytes = 15 << 20

// UploadSourceMap handles POST /api/v1/sourcemaps.
// Accepts a multipart form with "release" (required) and "file" (.map file).
// Stores in MinIO and records in source_maps table.
func (d *Dependencies) UploadSourceMap(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSourceMapBytes)

	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}

	if err := r.ParseMultipartForm(maxSourceMapBytes); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "source map exceeds size limit")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	release := r.FormValue("release")
	if release == "" {
		writeJSONError(w, http.StatusBadRequest, "release is required")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	filename := filepath.Base(header.Filename)
	if filepath.Ext(filename) != ".map" {
		writeJSONError(w, http.StatusBadRequest, "file must be a .map file")
		return
	}

	data, err := io.ReadAll(file)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read file")
		return
	}

	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "source map storage not configured")
		return
	}

	objectKey := fmt.Sprintf("sourcemaps/%s/%s/%s", projectID, release, filename)

	if err := d.MinIO.PutObject(r.Context(), objectKey, data, "application/json"); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to upload source map")
		return
	}

	if err := d.Queries.InsertSourceMap(r.Context(), projectID, release, filename, objectKey); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to record source map")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "uploaded", "object_key": objectKey})
}
