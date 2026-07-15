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
