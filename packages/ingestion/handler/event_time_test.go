package handler

import (
	"testing"
	"time"
)

// resolveEventTime turns the SDK's client-side ISO timestamp into the event
// time we persist. Contract (issue #27): valid past timestamps are kept,
// missing/garbage falls back to server time, absurd future skew is clamped.
func TestResolveEventTime(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name string
		raw  string
		want time.Time
	}{
		{
			name: "valid timestamp 90s in the past is kept",
			raw:  now.Add(-90 * time.Second).Format(time.RFC3339Nano),
			want: now.Add(-90 * time.Second),
		},
		{
			name: "toISOString millisecond format is kept",
			raw:  "2026-07-15T11:58:30.123Z",
			want: time.Date(2026, 7, 15, 11, 58, 30, 123_000_000, time.UTC),
		},
		{
			name: "empty falls back to server time",
			raw:  "",
			want: now,
		},
		{
			name: "garbage falls back to server time",
			raw:  "not-a-timestamp",
			want: now,
		},
		{
			name: "epoch-style number falls back to server time",
			raw:  "1752580800000",
			want: now,
		},
		{
			name: "slight future skew (30s) is kept",
			raw:  now.Add(30 * time.Second).Format(time.RFC3339Nano),
			want: now.Add(30 * time.Second),
		},
		{
			name: "absurd future skew (10m) is clamped to server time",
			raw:  now.Add(10 * time.Minute).Format(time.RFC3339Nano),
			want: now,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveEventTime(tc.raw, now)
			if !got.Equal(tc.want) {
				t.Errorf("resolveEventTime(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}
