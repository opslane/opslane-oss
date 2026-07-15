package retention

import (
	"testing"
	"time"
)

// The sweep interval is the caller's to choose. A previous version clamped it
// down to deletionGrace, so main.go's time.Hour silently became one minute and
// every replica ran a full retention scan 60x more often than intended.
// deletionGrace is a floor on how long a session waits before purge
// (SessionsReadyForPurge), not a ceiling on how often the sweep runs.
func TestResolveInterval(t *testing.T) {
	tests := []struct {
		name string
		in   time.Duration
		want time.Duration
	}{
		{"caller's hour is honored", time.Hour, time.Hour},
		{"main.go's actual argument", time.Hour, time.Hour},
		{"a sub-grace interval is honored too", 30 * time.Second, 30 * time.Second},
		{"an interval above grace is not clamped", 5 * time.Minute, 5 * time.Minute},
		{"zero falls back to the default", 0, defaultInterval},
		{"negative falls back to the default", -time.Second, defaultInterval},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveInterval(tt.in); got != tt.want {
				t.Fatalf("resolveInterval(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// defaultInterval must be reachable. The clamp made it dead code: it was set
// on the zero path and then immediately overwritten with deletionGrace.
func TestResolveInterval_DefaultIsReachable(t *testing.T) {
	if got := resolveInterval(0); got != time.Hour {
		t.Fatalf("resolveInterval(0) = %v, want %v (defaultInterval is unreachable)", got, time.Hour)
	}
}
