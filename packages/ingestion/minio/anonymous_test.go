package minio_test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

// TestAnonymousGetIsForbidden asserts the replay bucket is not world-readable.
// Guards against a regression of #47: `mc anonymous set download` made every
// stored replay/chunk downloadable by anyone who could guess an object key.
func TestAnonymousGetIsForbidden(t *testing.T) {
	endpoint := os.Getenv("REPLAY_STORE_ENDPOINT")
	publicEndpoint := os.Getenv("REPLAY_STORE_PUBLIC_ENDPOINT")
	if endpoint == "" || publicEndpoint == "" {
		t.Skip("REPLAY_STORE_ENDPOINT/PUBLIC_ENDPOINT not set; skipping integration test")
	}

	client, err := minioPkg.New(
		endpoint, publicEndpoint,
		os.Getenv("REPLAY_STORE_ACCESS_KEY"), os.Getenv("REPLAY_STORE_SECRET_KEY"),
		os.Getenv("REPLAY_STORE_BUCKET"), os.Getenv("REPLAY_STORE_REGION"),
	)
	if err != nil {
		t.Fatalf("minio client: %v", err)
	}

	ctx := context.Background()
	key := fmt.Sprintf("test/anon-probe-%d.json", time.Now().UnixNano())
	t.Cleanup(func() { _ = client.RemoveObject(context.Background(), key) })
	if err := client.PutObject(ctx, key, []byte(`{"secret":"pii"}`), "application/json"); err != nil {
		t.Fatalf("seed object: %v", err)
	}

	// Unauthenticated GET straight at the storage host, bypassing ingestion.
	url := fmt.Sprintf("%s/%s/%s", publicEndpoint, os.Getenv("REPLAY_STORE_BUCKET"), key)
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("anonymous GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("anonymous GET returned %d, want 403 — bucket is publicly readable (#47)", resp.StatusCode)
	}
}
