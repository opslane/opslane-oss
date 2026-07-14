package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// buildMultipartRequest is a helper that constructs a multipart/form-data request
// with an optional "release" field and an optional file attachment.
func buildMultipartRequest(t *testing.T, release, filename string, fileContent []byte) *http.Request {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	if release != "" {
		if err := writer.WriteField("release", release); err != nil {
			t.Fatalf("write release field: %v", err)
		}
	}

	if filename != "" {
		part, err := writer.CreateFormFile("file", filename)
		if err != nil {
			t.Fatalf("create form file: %v", err)
		}
		if _, err := part.Write(fileContent); err != nil {
			t.Fatalf("write file content: %v", err)
		}
	}

	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest("POST", "/api/v1/sourcemaps", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func TestSourceMap_MissingProjectContext(t *testing.T) {
	deps := &Dependencies{}
	req := buildMultipartRequest(t, "v1.0.0", "app.js.map", []byte(`{"version":3}`))
	// No project context set

	w := httptest.NewRecorder()
	deps.UploadSourceMap(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing project context, got %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if !strings.Contains(resp["error"], "project") {
		t.Errorf("expected error about project context, got %q", resp["error"])
	}
}

func TestSourceMap_MissingRelease(t *testing.T) {
	deps := &Dependencies{}
	req := buildMultipartRequest(t, "", "app.js.map", []byte(`{"version":3}`))
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

	w := httptest.NewRecorder()
	deps.UploadSourceMap(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing release, got %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if !strings.Contains(resp["error"], "release") {
		t.Errorf("expected error about release, got %q", resp["error"])
	}
}

func TestSourceMap_MissingFile(t *testing.T) {
	deps := &Dependencies{}
	// Build request with release but no file
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	writer.WriteField("release", "v1.0.0")
	writer.Close()

	req := httptest.NewRequest("POST", "/api/v1/sourcemaps", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

	w := httptest.NewRecorder()
	deps.UploadSourceMap(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing file, got %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if !strings.Contains(resp["error"], "file") {
		t.Errorf("expected error about file, got %q", resp["error"])
	}
}

func TestSourceMap_InvalidFileExtension(t *testing.T) {
	deps := &Dependencies{}
	req := buildMultipartRequest(t, "v1.0.0", "app.js", []byte(`console.log("hello")`))
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

	w := httptest.NewRecorder()
	deps.UploadSourceMap(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid file extension, got %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if !strings.Contains(resp["error"], ".map") {
		t.Errorf("expected error about .map extension, got %q", resp["error"])
	}
}

func TestSourceMap_OversizedBody(t *testing.T) {
	deps := &Dependencies{}

	// Create a multipart body that exceeds 15MB.
	// We write a large file field to push past the limit.
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	writer.WriteField("release", "v1.0.0")

	part, err := writer.CreateFormFile("file", "huge.js.map")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}

	// Write in chunks to avoid allocating one large byte slice.
	chunk := bytes.Repeat([]byte("x"), 1<<20) // 1MB chunk
	for i := 0; i < 16; i++ {
		if _, err := part.Write(chunk); err != nil {
			// Write may fail if the underlying buffer limit is hit; that's fine
			break
		}
	}
	writer.Close()

	req := httptest.NewRequest("POST", "/api/v1/sourcemaps", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

	w := httptest.NewRecorder()
	deps.UploadSourceMap(w, req)

	// MaxBytesReader trips ParseMultipartForm; we map that to 413.
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413 for oversized body, got %d", w.Code)
	}
}

func TestSourceMap_InvalidMultipartForm(t *testing.T) {
	deps := &Dependencies{}

	// Send a non-multipart body with multipart content-type
	req := httptest.NewRequest("POST", "/api/v1/sourcemaps", strings.NewReader("not multipart"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=nonexistent")
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

	w := httptest.NewRecorder()
	deps.UploadSourceMap(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid multipart form, got %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if !strings.Contains(resp["error"], "multipart") {
		t.Errorf("expected error about multipart form, got %q", resp["error"])
	}
}

func TestSourceMap_FileExtensionValidation(t *testing.T) {
	// Table-driven test: only .map files should pass extension validation.
	// Tests invalid extensions through the handler; valid extensions are verified
	// by checking filepath.Ext directly (same logic the handler uses) since valid
	// files proceed past validation to MinIO which requires a live service.
	invalidCases := []string{
		"app.js",
		"app.map.js",
		"noext",
		"something.json",
		"file.txt",
	}

	for _, filename := range invalidCases {
		t.Run(fmt.Sprintf("reject_%s", filename), func(t *testing.T) {
			deps := &Dependencies{}
			req := buildMultipartRequest(t, "v1.0.0", filename, []byte(`{"version":3}`))
			req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))

			w := httptest.NewRecorder()
			deps.UploadSourceMap(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400 for file %q, got %d", filename, w.Code)
			}
			var resp map[string]string
			json.NewDecoder(w.Body).Decode(&resp)
			if !strings.Contains(resp["error"], ".map") {
				t.Errorf("expected error about .map extension for file %q, got %q", filename, resp["error"])
			}
		})
	}

	// Verify valid .map extensions are accepted by the same logic the handler uses.
	validCases := []string{"app.js.map", "main.css.map", "bundle.map"}
	for _, filename := range validCases {
		ext := filepath.Ext(filepath.Base(filename))
		if ext != ".map" {
			t.Errorf("expected .map extension for %q, got %q", filename, ext)
		}
	}
}
