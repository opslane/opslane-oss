package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestMembershipLifecycle(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "membership-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	user, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("membership-%d@example.com", time.Now().UnixNano()), "Member", time.Now().UnixNano(), "member", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, org.ID, "owner"); err != nil {
		t.Fatalf("CreateMembership: %v", err)
	}
	role, err := q.GetMembership(ctx, user.ID, org.ID)
	if err != nil || role != "owner" {
		t.Fatalf("role=%q err=%v", role, err)
	}
	memberships, err := q.ListMembershipsByUser(ctx, user.ID)
	if err != nil || len(memberships) != 1 || memberships[0].OrgName != org.Name {
		t.Fatalf("memberships=%+v err=%v", memberships, err)
	}
	if err := q.SetMembershipRole(ctx, user.ID, org.ID, "member"); err != nil {
		t.Fatalf("SetMembershipRole: %v", err)
	}
	if err := q.DeleteMembership(ctx, user.ID, org.ID); err != nil {
		t.Fatalf("DeleteMembership: %v", err)
	}
	role, err = q.GetMembership(ctx, user.ID, org.ID)
	if err != nil || role != "" {
		t.Fatalf("deleted role=%q err=%v", role, err)
	}
	if !auth.RoleSatisfies("owner", "admin") || auth.RoleSatisfies("member", "admin") {
		t.Fatal("unexpected role hierarchy")
	}
}
