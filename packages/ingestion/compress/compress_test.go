package compress_test

import (
	"bytes"
	"compress/gzip"
	"errors"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/compress"
)

func mustGzip(t *testing.T, raw []byte) []byte {
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

func TestInflateLimited_RoundTrip(t *testing.T) {
	original := []byte(`{"events":[{"type":2,"data":{}}]}`)
	got, err := compress.InflateLimited(bytes.NewReader(mustGzip(t, original)), 1<<20)
	if err != nil {
		t.Fatalf("inflate: %v", err)
	}
	if !bytes.Equal(got, original) {
		t.Fatalf("round trip mismatch: got %q, want %q", got, original)
	}
}

func TestInflateLimited_AtExactlyTheLimitSucceeds(t *testing.T) {
	original := bytes.Repeat([]byte("a"), 1000)
	got, err := compress.InflateLimited(bytes.NewReader(mustGzip(t, original)), 1000)
	if err != nil || len(got) != 1000 {
		t.Fatalf("inflate at limit: len=%d err=%v", len(got), err)
	}
}

func TestInflateLimited_RejectsGzipBomb(t *testing.T) {
	bomb := mustGzip(t, bytes.Repeat([]byte("A"), 100<<20))
	got, err := compress.InflateLimited(bytes.NewReader(bomb), 1<<20)
	if !errors.Is(err, compress.ErrTooLarge) {
		t.Fatalf("inflate returned %v, want ErrTooLarge", err)
	}
	if len(got) > 1<<20 {
		t.Fatalf("returned %d bytes despite ceiling", len(got))
	}
}

func TestInflateLimited_RejectsNonGzip(t *testing.T) {
	if _, err := compress.InflateLimited(strings.NewReader("plain text"), 1<<20); err == nil {
		t.Fatal("non-gzip input inflated without error")
	}
}

func TestDeflate_RoundTripsThroughInflate(t *testing.T) {
	original := []byte(strings.Repeat(`{"k":"v"},`, 500))
	gz, err := compress.Deflate(original)
	if err != nil {
		t.Fatalf("deflate: %v", err)
	}
	back, err := compress.InflateLimited(bytes.NewReader(gz), 1<<20)
	if err != nil || !bytes.Equal(back, original) {
		t.Fatalf("round trip failed: %v", err)
	}
}
