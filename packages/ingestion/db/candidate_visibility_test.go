package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// Batch 4 (issue #56): ordinary candidates are invisible workflow records;
// the only visible candidate is an exhausted 'unchecked' diagnostic, and no
// candidate ever exposes affected users.
func TestCandidateVisibility(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "test-candidate-visibility")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	proj, err := q.CreateProject(ctx, org.ID, "cand-vis", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	mustInsert := func(fingerprint, status, kind string, adjudication *string) string {
		var id string
		err := pool.QueryRow(ctx,
			`INSERT INTO error_groups
			   (project_id, environment_id, fingerprint, title, first_seen, last_seen,
			    occurrence_count, affected_users_count, status, kind, adjudication_status)
			 VALUES ($1, $2, $3, $3, now(), now(), 0, 0, $4::error_group_status, $5, $6)
			 RETURNING id`,
			proj.ID, env.ID, fingerprint, status, kind, adjudication,
		).Scan(&id)
		if err != nil {
			t.Fatalf("insert group %s: %v", fingerprint, err)
		}
		return id
	}

	unchecked := "unchecked"
	ordinaryID := mustInsert("friction:env:fp-ordinary", "candidate", "friction", nil)
	uncheckedID := mustInsert("friction-unchecked:gen-1", "candidate", "friction", &unchecked)
	publishedID := mustInsert("friction:env:fp-published", "queued", "friction", nil)

	groups, err := q.ListErrorGroups(ctx, proj.ID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups: %v", err)
	}
	seen := map[string]bool{}
	for _, g := range groups {
		seen[g.ID] = true
		if g.ID == uncheckedID {
			if g.AdjudicationStatus == nil || *g.AdjudicationStatus != "unchecked" {
				t.Errorf("unchecked candidate must carry adjudication_status")
			}
			if g.EnvironmentID == nil || *g.EnvironmentID != env.ID {
				t.Errorf("friction incidents must carry environment_id")
			}
		}
	}
	if seen[ordinaryID] {
		t.Error("ordinary candidate leaked into the list API")
	}
	if !seen[uncheckedID] {
		t.Error("unchecked diagnostic candidate must be visible in the list")
	}
	if !seen[publishedID] {
		t.Error("published friction incident missing from the list")
	}

	if g, err := q.GetErrorGroup(ctx, proj.ID, ordinaryID); err != nil || g != nil {
		t.Errorf("ordinary candidate detail must be inaccessible, got %v (%v)", g, err)
	}
	if g, err := q.GetErrorGroup(ctx, proj.ID, uncheckedID); err != nil || g == nil {
		t.Errorf("unchecked candidate detail must be accessible, got %v (%v)", g, err)
	}

	users, err := q.ListAffectedUsers(ctx, proj.ID, uncheckedID)
	if err != nil {
		t.Fatalf("ListAffectedUsers: %v", err)
	}
	if len(users) != 0 {
		t.Errorf("candidates must expose no affected users, got %d", len(users))
	}
}
