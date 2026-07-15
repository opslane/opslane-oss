package handler

import "testing"

func TestByteBudget_AllowsUpToLimit(t *testing.T) {
	b := newByteBudget(1000)
	if !b.allow("proj-1", 600) {
		t.Fatal("first 600 bytes rejected, want allowed")
	}
	if !b.allow("proj-1", 400) {
		t.Fatal("second 400 bytes rejected, want allowed (total exactly at limit)")
	}
}

func TestByteBudget_RejectsOverLimit(t *testing.T) {
	b := newByteBudget(1000)
	if !b.allow("proj-1", 900) {
		t.Fatal("900 bytes rejected, want allowed")
	}
	if b.allow("proj-1", 200) {
		t.Fatal("200 bytes allowed after 900 of a 1000 budget, want rejected")
	}
}

// A rejected reservation must not consume budget, or one oversized request
// starves everything behind it.
func TestByteBudget_RejectedReservationDoesNotConsume(t *testing.T) {
	b := newByteBudget(1000)
	if b.allow("proj-1", 5000) {
		t.Fatal("5000 bytes allowed against a 1000 budget, want rejected")
	}
	if !b.allow("proj-1", 900) {
		t.Fatal("900 bytes rejected after a failed oversize reservation; the reject consumed budget")
	}
}

func TestByteBudget_IsPerProject(t *testing.T) {
	b := newByteBudget(1000)
	if !b.allow("proj-1", 1000) {
		t.Fatal("proj-1 full budget rejected")
	}
	if !b.allow("proj-2", 1000) {
		t.Fatal("proj-2 rejected; budgets are leaking across projects")
	}
}

func TestByteBudget_ResetsOnWindowRollover(t *testing.T) {
	b := newByteBudget(1000)
	if !b.allow("proj-1", 1000) {
		t.Fatal("full budget rejected")
	}
	if b.allow("proj-1", 1) {
		t.Fatal("1 byte allowed over budget, want rejected")
	}
	b.forceRollover()
	if !b.allow("proj-1", 1000) {
		t.Fatal("budget not reset after window rollover")
	}
}

// Mirrors rateLimiter's 10k-entry DDoS guard: an attacker rotating project keys
// must not grow the map without bound.
func TestByteBudget_EvictsWhenMapGrowsUnbounded(t *testing.T) {
	b := newByteBudget(1000)
	b.maxEntries = 3
	for _, p := range []string{"a", "b", "c", "d"} {
		b.allow(p, 10)
	}
	if len(b.used) > 3 {
		t.Fatalf("map holds %d entries, want <= 3", len(b.used))
	}
}
