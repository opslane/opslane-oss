package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestPersistInstallationRefreshesDefaultBranchCache(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "branch-cache-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	stale, err := q.CreateProject(ctx, org.ID, "stale", ptrStr("Owner/Stale"))
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := q.CreateProject(ctx, org.ID, "unknown", ptrStr("owner/unknown"))
	if err != nil {
		t.Fatal(err)
	}
	unmatched, err := q.CreateProject(ctx, org.ID, "unmatched", ptrStr("owner/other"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE projects SET default_branch = CASE
		   WHEN id = $1 THEN 'main'
		   WHEN id = $2 THEN NULL
		   WHEN id = $3 THEN 'develop'
		 END
		 WHERE id IN ($1, $2, $3)`,
		stale.ID, unknown.ID, unmatched.ID); err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = q.PersistInstallation(ctx, tx, db.PersistInstallationParams{
		InstallationID: time.Now().UnixNano(),
		GitHubOrgName:  "owner",
		GitHubOrgID:    time.Now().UnixNano() + 1,
		OrgID:          org.ID,
		Repos: []db.InstallationRepo{
			{FullName: "owner/stale", DefaultBranch: "master"},
			{FullName: "owner/unknown", DefaultBranch: "trunk"},
		},
	})
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	for _, check := range []struct {
		id   string
		want string
	}{
		{id: stale.ID, want: "master"},
		{id: unknown.ID, want: "trunk"},
		{id: unmatched.ID, want: "develop"},
	} {
		var got *string
		if err := pool.QueryRow(ctx,
			`SELECT default_branch FROM projects WHERE id = $1`,
			check.id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got == nil || *got != check.want {
			t.Errorf("project %s default_branch = %v, want %q", check.id, got, check.want)
		}
	}
}
