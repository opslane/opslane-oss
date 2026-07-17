package db_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestUpsertAndLookupIdentity(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "identity-test")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	user, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("identity-%d@example.com", time.Now().UnixNano()), "Identity", time.Now().UnixNano(), "identity", "")
	if err != nil {
		t.Fatalf("CreateUserGitHub: %v", err)
	}
	if err := q.UpsertIdentityDetails(ctx, user.ID, "workos", "user_abc", "Identity@Example.com", true); err != nil {
		t.Fatalf("UpsertIdentityDetails: %v", err)
	}
	if err := q.UpsertIdentityDetails(ctx, user.ID, "workos", "user_abc", "identity@example.com", true); err != nil {
		t.Fatalf("UpsertIdentityDetails repeat: %v", err)
	}
	got, err := q.GetUserIDByIdentity(ctx, "workos", "user_abc")
	if err != nil || got != user.ID {
		t.Fatalf("identity user=%q err=%v, want %q", got, err, user.ID)
	}
	missing, err := q.GetUserIDByIdentity(ctx, "workos", "missing")
	if err != nil || missing != "" {
		t.Fatalf("missing identity user=%q err=%v", missing, err)
	}

	other, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("other-%d@example.com", time.Now().UnixNano()), "Other", time.Now().UnixNano(), "other", "")
	if err != nil {
		t.Fatalf("CreateUserGitHub(other): %v", err)
	}
	if err := q.UpsertIdentity(ctx, other.ID, "workos", "user_abc"); !errors.Is(err, db.ErrIdentityConflict) {
		t.Fatalf("conflict error=%v, want ErrIdentityConflict", err)
	}
}
