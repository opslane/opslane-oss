package handler_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

const maxInlineChunkBytesForTest = 64 << 10

func storageEnv(primary, legacy string) string {
	if value := os.Getenv(primary); value != "" {
		return value
	}
	return os.Getenv(legacy)
}

func testDepsWithStorage(t *testing.T) (*handler.Dependencies, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	endpoint := storageEnv("REPLAY_STORE_ENDPOINT", "MINIO_ENDPOINT")
	if dsn == "" || endpoint == "" {
		t.Skip("DATABASE_URL / REPLAY_STORE_ENDPOINT not set; skipping session integration test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	mc, err := minioPkg.New(
		endpoint,
		storageEnv("REPLAY_STORE_PUBLIC_ENDPOINT", "MINIO_PUBLIC_ENDPOINT"),
		storageEnv("REPLAY_STORE_ACCESS_KEY", "MINIO_ACCESS_KEY"),
		storageEnv("REPLAY_STORE_SECRET_KEY", "MINIO_SECRET_KEY"),
		storageEnv("REPLAY_STORE_BUCKET", "MINIO_BUCKET"),
		storageEnv("REPLAY_STORE_REGION", "MINIO_REGION"),
	)
	if err != nil {
		t.Fatalf("minio client: %v", err)
	}
	return &handler.Dependencies{Queries: db.New(pool), MinIO: mc}, pool
}

func seedTenantWithKey(t *testing.T, pool *pgxpool.Pool) (projectID, envID, apiKey string) {
	t.Helper()
	_, projectID, envID, apiKey = seedTenant(t, db.New(pool))
	return projectID, envID, apiKey
}

func newTestRouter(t *testing.T, deps *handler.Dependencies, pool *pgxpool.Pool) http.Handler {
	t.Helper()
	return handler.NewRouterWithPool(deps, pool)
}

func initSession(t *testing.T, router http.Handler, apiKey, sessionID string) {
	t.Helper()
	body := fmt.Sprintf(`{"session_id":%q,"started_at":%q,"page_url":"https://app.example.com/"}`,
		sessionID, time.Now().UTC().Format(time.RFC3339))
	req := httptest.NewRequest("POST", "/api/v1/sessions/init", strings.NewReader(body))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("session init returned %d: %s", w.Code, w.Body.String())
	}
}

func requestUploadURL(t *testing.T, router http.Handler, apiKey, sessionID string, seq int, size int64) (int, map[string]any) {
	t.Helper()
	body := fmt.Sprintf(`{"seq":%d,"size_bytes":%d,"has_full_snapshot":true}`, seq, size)
	req := httptest.NewRequest("POST",
		fmt.Sprintf("/api/v1/sessions/%s/chunks/upload-url", sessionID), strings.NewReader(body))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func gzipBytes(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

func postForm(t *testing.T, uploadURL string, fields map[string]string, payload []byte) int {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := w.WriteField(key, value); err != nil {
			t.Fatalf("write form field: %v", err)
		}
	}
	part, err := w.CreateFormFile("file", "chunk.json.gz")
	if err != nil {
		t.Fatalf("create file field: %v", err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatalf("write file field: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, uploadURL, &body)
	if err != nil {
		t.Fatalf("new storage request: %v", err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("storage request: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func uploadToPolicy(t *testing.T, out map[string]any, payload []byte) {
	t.Helper()
	uploadURL, _ := out["upload_url"].(string)
	rawForm, _ := out["form_data"].(map[string]any)
	form := make(map[string]string, len(rawForm))
	for key, value := range rawForm {
		form[key], _ = value.(string)
	}
	if code := postForm(t, uploadURL, form, payload); code >= 400 {
		t.Fatalf("storage upload returned %d", code)
	}
}

func commitChunk(t *testing.T, router http.Handler, apiKey, sessionID string, seq int) int {
	t.Helper()
	req := httptest.NewRequest("POST",
		fmt.Sprintf("/api/v1/sessions/%s/chunks/%d/commit", sessionID, seq), strings.NewReader(`{}`))
	req.Header.Set("X-API-Key", apiKey)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w.Code
}

func postInlineChunk(t *testing.T, router http.Handler, apiKey, sessionID string, seq int, payload []byte) int {
	t.Helper()
	req := httptest.NewRequest("POST",
		fmt.Sprintf("/api/v1/sessions/%s/chunks/%d/inline", sessionID, seq), bytes.NewReader(payload))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/gzip")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w.Code
}

func TestChunkUploadURL_DuplicateSeqReturns409(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	if code, _ := requestUploadURL(t, router, apiKey, sid, 0, 1024); code != http.StatusOK {
		t.Fatalf("first upload-url returned %d, want 200", code)
	}
	if code, _ := requestUploadURL(t, router, apiKey, sid, 0, 1024); code != http.StatusConflict {
		t.Fatalf("duplicate seq returned %d, want 409", code)
	}
}

func TestChunkUploadURL_RejectsOversizeDeclaration(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	code, _ := requestUploadURL(t, router, apiKey, sid, 0, 50<<20)
	if code != http.StatusRequestEntityTooLarge && code != http.StatusBadRequest {
		t.Fatalf("50MiB declaration returned %d, want 413/400", code)
	}
}

func TestChunkUploadURL_UnknownSessionReturns404(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	code, _ := requestUploadURL(t, router, apiKey, "sess_neverregistered", 0, 1024)
	if code != http.StatusNotFound {
		t.Fatalf("unknown session returned %d, want 404", code)
	}
}

func TestChunkUploadURL_CrossTenantReturns404(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKeyA := seedTenantWithKey(t, pool)
	_, _, apiKeyB := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKeyA, sid)
	code, _ := requestUploadURL(t, router, apiKeyB, sid, 0, 1024)
	if code != http.StatusNotFound {
		t.Fatalf("cross-tenant upload-url returned %d, want 404", code)
	}
}

func TestChunkCommit_MissingObjectReturns409(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	if code, _ := requestUploadURL(t, router, apiKey, sid, 0, 1024); code != http.StatusOK {
		t.Fatal("upload-url failed")
	}
	if code := commitChunk(t, router, apiKey, sid, 0); code != http.StatusConflict {
		t.Fatalf("commit of a never-uploaded chunk returned %d, want 409", code)
	}
}

func TestChunkCommit_RecordsServerObservedSize(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	code, out := requestUploadURL(t, router, apiKey, sid, 0, int64(len(payload)))
	if code != http.StatusOK {
		t.Fatalf("upload-url returned %d", code)
	}
	uploadToPolicy(t, out, payload)
	if code := commitChunk(t, router, apiKey, sid, 0); code != http.StatusOK {
		t.Fatalf("commit returned %d, want 200", code)
	}

	var size int64
	var scrubbedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT size_bytes, scrubbed_at FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
	).Scan(&size, &scrubbedAt); err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	if size != int64(len(payload)) {
		t.Fatalf("recorded size %d, want %d", size, len(payload))
	}
	if scrubbedAt != nil {
		t.Fatal("commit set scrubbed_at")
	}
}

func TestChunkCommit_IsIdempotent(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	_, out := requestUploadURL(t, router, apiKey, sid, 0, int64(len(payload)))
	uploadToPolicy(t, out, payload)
	commitChunk(t, router, apiKey, sid, 0)
	commitChunk(t, router, apiKey, sid, 0)

	var chunkCount int
	var bytesStored int64
	if err := pool.QueryRow(context.Background(),
		`SELECT chunk_count, bytes_stored FROM sessions WHERE id=$1`, sid,
	).Scan(&chunkCount, &bytesStored); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if chunkCount != 1 || bytesStored != int64(len(payload)) {
		t.Fatalf("double commit rollup = count %d, bytes %d", chunkCount, bytesStored)
	}
}

func TestChunkInline_StoresAndCommitsInOneCall(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	payload := gzipBytes(t, []byte(`{"events":[{"type":2}]}`))
	if code := postInlineChunk(t, router, apiKey, sid, 0, payload); code != http.StatusOK {
		t.Fatalf("inline flush returned %d, want 200", code)
	}

	var size int64
	var uploadedAt, scrubbedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT size_bytes, uploaded_at, scrubbed_at FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
	).Scan(&size, &uploadedAt, &scrubbedAt); err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	if size != int64(len(payload)) || uploadedAt == nil || scrubbedAt != nil {
		t.Fatalf("inline chunk = size %d, uploaded %v, scrubbed %v", size, uploadedAt, scrubbedAt)
	}
}

func TestChunkInline_RejectsOversizeBody(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	if code := postInlineChunk(t, router, apiKey, sid, 0, make([]byte, maxInlineChunkBytesForTest+1)); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize inline body returned %d, want 413", code)
	}
}

func TestChunkInline_RejectsNonGzipBody(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	if code := postInlineChunk(t, router, apiKey, sid, 0, []byte("this is not gzip at all")); code != http.StatusBadRequest {
		t.Fatalf("non-gzip body returned %d, want 400", code)
	}
}

func TestSessionInit_RecordingDisabledDoesNotCreateSession(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	if _, err := pool.Exec(context.Background(),
		`UPDATE projects SET recording_enabled = FALSE WHERE id = $1`, projectID); err != nil {
		t.Fatalf("disable recording: %v", err)
	}
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	body := fmt.Sprintf(`{"session_id":%q,"started_at":%q}`, sid, time.Now().UTC().Format(time.RFC3339))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/init", strings.NewReader(body))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"recording":false`) {
		t.Fatalf("disabled init returned %d: %s", w.Code, w.Body.String())
	}
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1`, sid).Scan(&count); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if count != 0 {
		t.Fatalf("disabled init created %d sessions, want 0", count)
	}
}

func TestSessionInit_TombstoneReturns410(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO session_tombstones (session_id, project_id) VALUES ($1, $2)`, sid, projectID); err != nil {
		t.Fatalf("seed tombstone: %v", err)
	}
	router := newTestRouter(t, deps, pool)
	body := fmt.Sprintf(`{"session_id":%q}`, sid)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/init", strings.NewReader(body))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusGone {
		t.Fatalf("tombstoned init returned %d: %s, want 410", w.Code, w.Body.String())
	}
}

func TestChunkUploadURL_RecordingDisabledReturns403(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	if _, err := pool.Exec(context.Background(),
		`UPDATE projects SET recording_enabled = FALSE WHERE id = $1`, projectID); err != nil {
		t.Fatalf("disable recording: %v", err)
	}
	if code, _ := requestUploadURL(t, router, apiKey, sid, 0, 1024); code != http.StatusForbidden {
		t.Fatalf("upload-url while disabled returned %d, want 403", code)
	}
}
