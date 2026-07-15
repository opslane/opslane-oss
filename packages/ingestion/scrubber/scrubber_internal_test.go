package scrubber

import "testing"

func TestChunkEventBounds(t *testing.T) {
	tests := []struct {
		name      string
		plain     string
		wantFirst *int64
		wantLast  *int64
	}{
		{name: "ordered bounds", plain: `{"events":[{"type":4,"timestamp":1000},{"type":2,"timestamp":5000}]}`, wantFirst: int64Ptr(1000), wantLast: int64Ptr(5000)},
		{name: "uses min and max", plain: `{"events":[{"timestamp":5000},{"timestamp":1000},{"timestamp":3000}]}`, wantFirst: int64Ptr(1000), wantLast: int64Ptr(5000)},
		{name: "empty events", plain: `{"events":[]}`},
		{name: "malformed entries are isolated", plain: `{"events":[{"type":2},{"timestamp":"x"},{"type":3,"timestamp":2000}]}`, wantFirst: int64Ptr(2000), wantLast: int64Ptr(2000)},
		{name: "invalid envelope", plain: `{`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			first, last := chunkEventBounds([]byte(tt.plain))
			assertOptionalInt64(t, "first", first, tt.wantFirst)
			assertOptionalInt64(t, "last", last, tt.wantLast)
		})
	}
}

func int64Ptr(value int64) *int64 { return &value }

func assertOptionalInt64(t *testing.T, field string, got, want *int64) {
	t.Helper()
	if got == nil || want == nil {
		if got != nil || want != nil {
			t.Fatalf("%s = %v, want %v", field, got, want)
		}
		return
	}
	if *got != *want {
		t.Fatalf("%s = %d, want %d", field, *got, *want)
	}
}
