package minio_test

import (
	"bytes"
	"context"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

func testClient(t *testing.T) *minioPkg.Client {
	t.Helper()
	endpoint := os.Getenv("REPLAY_STORE_ENDPOINT")
	if endpoint == "" {
		t.Skip("REPLAY_STORE_ENDPOINT not set; skipping integration test")
	}
	c, err := minioPkg.New(
		endpoint, os.Getenv("REPLAY_STORE_PUBLIC_ENDPOINT"),
		os.Getenv("REPLAY_STORE_ACCESS_KEY"), os.Getenv("REPLAY_STORE_SECRET_KEY"),
		os.Getenv("REPLAY_STORE_BUCKET"), os.Getenv("REPLAY_STORE_REGION"),
	)
	if err != nil {
		t.Fatalf("minio client: %v", err)
	}
	return c
}

// postForm performs the browser-side half of a presigned POST policy upload:
// every signed form field, then the file field last.
func postForm(t *testing.T, url string, formData map[string]string, body []byte) int {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range formData {
		if err := w.WriteField(k, v); err != nil {
			t.Fatalf("write field %s: %v", k, err)
		}
	}
	fw, err := w.CreateFormFile("file", "chunk.json.gz")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fw.Write(body); err != nil {
		t.Fatalf("write body: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	resp, err := http.Post(url, w.FormDataContentType(), &buf)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func TestPresignedPostPolicy_WithinCapSucceeds(t *testing.T) {
	c := testClient(t)
	ctx := context.Background()
	key := fmt.Sprintf("test/policy-ok-%d.gz", time.Now().UnixNano())
	t.Cleanup(func() { _ = c.RemoveObject(context.Background(), key) })

	payload := []byte(strings.Repeat("a", 500))
	url, formData, err := c.PresignedPostPolicy(ctx, key, "application/gzip", int64(len(payload)), 5*time.Minute)
	if err != nil {
		t.Fatalf("presign: %v", err)
	}

	if code := postForm(t, url, formData, payload); code != http.StatusNoContent && code != http.StatusOK {
		t.Fatalf("upload within cap returned %d, want 204/200", code)
	}

	size, err := c.StatObject(ctx, key)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if size != int64(len(payload)) {
		t.Fatalf("stored size %d, want %d", size, len(payload))
	}
}

func TestPresignedPostPolicy_OverCapRejectedByStorage(t *testing.T) {
	c := testClient(t)
	ctx := context.Background()
	key := fmt.Sprintf("test/policy-toobig-%d.gz", time.Now().UnixNano())
	t.Cleanup(func() { _ = c.RemoveObject(context.Background(), key) })

	// Sign for 500 bytes, then try to upload 5000. Storage must refuse.
	url, formData, err := c.PresignedPostPolicy(ctx, key, "application/gzip", 500, 5*time.Minute)
	if err != nil {
		t.Fatalf("presign: %v", err)
	}

	code := postForm(t, url, formData, []byte(strings.Repeat("a", 5000)))
	if code < 400 {
		t.Fatalf("oversize upload returned %d, want 4xx — storage is not enforcing content-length-range (#48)", code)
	}

	// And it must not have landed.
	if _, err := c.StatObject(ctx, key); err == nil {
		t.Fatal("oversize object exists in storage; the policy did not reject it")
	}
}

func TestRemoveObject(t *testing.T) {
	c := testClient(t)
	ctx := context.Background()
	key := fmt.Sprintf("test/remove-%d.json", time.Now().UnixNano())

	if err := c.PutObject(ctx, key, []byte(`{}`), "application/json"); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := c.StatObject(ctx, key); err != nil {
		t.Fatalf("stat before remove: %v", err)
	}
	if err := c.RemoveObject(ctx, key); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := c.StatObject(ctx, key); err == nil {
		t.Fatal("object still exists after RemoveObject")
	}
}

// Retention deletes keys that may already be gone (crash mid-sweep, concurrent
// replica). That must not be an error, or the sweep wedges permanently.
func TestRemoveObject_MissingKeyIsNotAnError(t *testing.T) {
	c := testClient(t)
	key := fmt.Sprintf("test/never-existed-%d.json", time.Now().UnixNano())
	if err := c.RemoveObject(context.Background(), key); err != nil {
		t.Fatalf("removing a missing key returned %v, want nil (retention must be idempotent)", err)
	}
}

func TestRemovePrefix(t *testing.T) {
	c := testClient(t)
	ctx := context.Background()
	base := fmt.Sprintf("test/prefix-%d", time.Now().UnixNano())
	inside := []string{base + "/a.gz", base + "/nested/b.gz"}
	outside := base + "-other/c.gz"
	for _, key := range append(inside, outside) {
		if err := c.PutObject(ctx, key, []byte("x"), "application/gzip"); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}
	t.Cleanup(func() { _ = c.RemoveObject(context.Background(), outside) })

	if err := c.RemovePrefix(ctx, base+"/"); err != nil {
		t.Fatalf("remove prefix: %v", err)
	}
	for _, key := range inside {
		if _, err := c.StatObject(ctx, key); err == nil {
			t.Fatalf("object %s survived prefix removal", key)
		}
	}
	if _, err := c.StatObject(ctx, outside); err != nil {
		t.Fatalf("neighboring prefix was removed: %v", err)
	}
}
