package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestRefreshTokenCarriesOrg(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "refresh-org")
	if err != nil {
		t.Fatal(err)
	}
	otherOrg, err := q.CreateOrg(ctx, "refresh-other-org")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupTenant(t, pool, org.ID)
		cleanupTenant(t, pool, otherOrg.ID)
	})
	user, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("refresh-%d@example.com", time.Now().UnixNano()), "Refresh", time.Now().UnixNano(), "refresh", "")
	if err != nil {
		t.Fatal(err)
	}
	raw, hash, err := auth.GenerateRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := q.StoreRefreshToken(ctx, user.ID, hash, "00000000-0000-0000-0000-000000000001", org.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("StoreRefreshToken: %v", err)
	}
	gotUser, gotFamily, gotOrg, err := q.ConsumeRefreshToken(ctx, auth.HashToken(raw))
	if err != nil || gotUser != user.ID || gotFamily != "00000000-0000-0000-0000-000000000001" || gotOrg != org.ID {
		t.Fatalf("got (%q,%q,%q) err=%v", gotUser, gotFamily, gotOrg, err)
	}
	rawOther, hashOther, _ := auth.GenerateRefreshToken()
	if err := q.StoreRefreshToken(ctx, user.ID, hashOther, "00000000-0000-0000-0000-000000000002", otherOrg.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	_, _, gotOtherOrg, err := q.ConsumeRefreshToken(ctx, auth.HashToken(rawOther))
	if err != nil || gotOtherOrg != otherOrg.ID {
		t.Fatalf("second device org=%q err=%v, want %q", gotOtherOrg, err, otherOrg.ID)
	}
}
