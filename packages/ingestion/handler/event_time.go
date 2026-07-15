package handler

import "time"

// futureSkewTolerance bounds how far ahead of server time a client clock may
// claim before we distrust it entirely. Small positive skew is normal
// (unsynced client clocks); minutes ahead means the clock is broken.
const futureSkewTolerance = 5 * time.Minute

// resolveEventTime turns the SDK's client-side ISO timestamp into the event
// time to persist (issue #27). Valid past timestamps are kept so queued or
// offline-buffered events land at the moment they happened in the browser;
// missing or unparseable values fall back to server arrival time; timestamps
// beyond futureSkewTolerance are clamped to server time.
//
// Known tradeoff: clamping desyncs the error time from replay/friction
// timestamps, which keep the raw browser clock. For a clock more than
// futureSkewTolerance fast, same-session time correlation (e.g. a ±30s
// error/friction fold) will miss. Accepted for now: it only affects broken
// clocks, and before issue #27 every event was server-stamped and desynced.
// If it matters later, treat clamped events as correlation-ineligible there.
func resolveEventTime(raw string, now time.Time) time.Time {
	if raw == "" {
		return now
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return now
	}
	if t.After(now.Add(futureSkewTolerance)) {
		return now
	}
	return t
}
