package handler

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestEnvironmentResolverTenantScopedTTLAndBound(t *testing.T) {
	now := time.Date(2026, 7, 19, 0, 0, 0, 0, time.UTC)
	calls := map[string]int{}
	resolver := newEnvironmentResolver(func(_ context.Context, projectID, name string) (string, error) {
		key := projectID + "/" + name
		calls[key]++
		if name == "missing" {
			return "", nil
		}
		return projectID + "-" + name, nil
	}, func() time.Time { return now })
	resolver.capacity = 2

	ctx := context.Background()
	if got, _ := resolver.resolve(ctx, "p1", "production"); got != "p1-production" {
		t.Fatalf("resolve p1 = %q", got)
	}
	if got, _ := resolver.resolve(ctx, "p2", "production"); got != "p2-production" {
		t.Fatalf("resolve p2 = %q", got)
	}
	_, _ = resolver.resolve(ctx, "p1", "production")
	if calls["p1/production"] != 1 {
		t.Fatalf("positive cache calls = %d, want 1", calls["p1/production"])
	}

	_, _ = resolver.resolve(ctx, "p1", "missing")
	_, _ = resolver.resolve(ctx, "p1", "missing")
	if calls["p1/missing"] != 1 {
		t.Fatalf("negative cache calls = %d, want 1", calls["p1/missing"])
	}
	now = now.Add(6 * time.Second)
	_, _ = resolver.resolve(ctx, "p1", "missing")
	if calls["p1/missing"] != 2 {
		t.Fatalf("expired negative cache calls = %d, want 2", calls["p1/missing"])
	}
	if resolver.lru.Len() > 2 {
		t.Fatalf("cache size = %d, want <= 2", resolver.lru.Len())
	}
	now = now.Add(55 * time.Second)
	_, _ = resolver.resolve(ctx, "p1", "production")
	if calls["p1/production"] != 2 {
		t.Fatalf("expired positive cache calls = %d, want 2", calls["p1/production"])
	}
}

func TestEnvironmentNameValidation(t *testing.T) {
	valid := []string{"production", "prod.us_1", "A-1", fmt.Sprintf("%064s", "x")}
	invalid := []string{"", "has space", "prod/slash", fmt.Sprintf("%065s", "x")}
	for _, name := range valid {
		if !environmentNamePattern.MatchString(name) {
			t.Errorf("valid name rejected: %q", name)
		}
	}
	for _, name := range invalid {
		if environmentNamePattern.MatchString(name) {
			t.Errorf("invalid name accepted: %q", name)
		}
	}
}
