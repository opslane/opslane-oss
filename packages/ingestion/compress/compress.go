// Package compress provides bounded gzip handling for stored session chunks.
package compress

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
)

// ErrTooLarge is returned when decompressed output would exceed the ceiling.
var ErrTooLarge = errors.New("decompressed size exceeds limit")

// InflateLimited gunzips r while reading at most one byte beyond maxBytes.
func InflateLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("maxBytes must be positive, got %d", maxBytes)
	}

	zr, err := gzip.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("open gzip stream: %w", err)
	}
	defer zr.Close()

	out, err := io.ReadAll(io.LimitReader(zr, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("inflate: %w", err)
	}
	if int64(len(out)) > maxBytes {
		return out[:maxBytes], ErrTooLarge
	}
	return out, nil
}

// Deflate gzips data for durable chunk storage.
func Deflate(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(data); err != nil {
		return nil, fmt.Errorf("gzip write: %w", err)
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("gzip close: %w", err)
	}
	return buf.Bytes(), nil
}
