package db_test

import (
	"context"
	"sync"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestProvisionProjectIsIdempotentAndRotatesTheOneTimeKey(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "project-provision-idempotent")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	first, err := q.ProvisionProject(ctx, org.ID, "Checkout", ptrStr("acme/checkout"), "attempt-1")
	if err != nil {
		t.Fatalf("first ProvisionProject: %v", err)
	}
	second, err := q.ProvisionProject(ctx, org.ID, "ignored retry name", nil, "attempt-1")
	if err != nil {
		t.Fatalf("second ProvisionProject: %v", err)
	}

	if first.Project.ID != second.Project.ID || first.Environment.ID != second.Environment.ID {
		t.Fatalf("retry changed provisioned identity: first=%+v second=%+v", first, second)
	}
	if second.Project.Name != "Checkout" || second.Project.GithubRepo == nil || *second.Project.GithubRepo != "acme/checkout" {
		t.Fatalf("retry overwrote original project fields: %+v", second.Project)
	}
	if first.APIKey.ID == second.APIKey.ID || first.APIKey.RawKey == second.APIKey.RawKey {
		t.Fatalf("retry did not mint a fresh one-time key: first=%+v second=%+v", first.APIKey, second.APIKey)
	}
	if _, err := q.LookupAPIKey(ctx, first.APIKey.RawKey); err == nil {
		t.Fatal("prior provisioning key remains active after retry")
	}
	if lookup, err := q.LookupAPIKey(ctx, second.APIKey.RawKey); err != nil || lookup.ProjectID != second.Project.ID {
		t.Fatalf("fresh key lookup = (%+v, %v)", lookup, err)
	}

	var projectCount, activeKeyCount int
	var provisioningKeyID string
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM projects WHERE org_id = $1 AND idempotency_token = 'attempt-1'`, org.ID,
	).Scan(&projectCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM environment_api_keys ak
		JOIN environments e ON e.id = ak.environment_id
		WHERE e.project_id = $1 AND ak.revoked_at IS NULL`, second.Project.ID,
	).Scan(&activeKeyCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT provisioning_key_id FROM projects WHERE id = $1`, second.Project.ID,
	).Scan(&provisioningKeyID); err != nil {
		t.Fatal(err)
	}
	if projectCount != 1 || activeKeyCount != 1 || provisioningKeyID != second.APIKey.ID {
		t.Fatalf("project_count=%d active_keys=%d provisioning_key=%s want 1,1,%s",
			projectCount, activeKeyCount, provisioningKeyID, second.APIKey.ID)
	}
}

func TestProvisionProjectConcurrentSameTokenCreatesOneProject(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "project-provision-concurrent")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	const callers = 8
	results := make(chan *db.ProjectProvisioning, callers)
	errors := make(chan error, callers)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for range callers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, callErr := q.ProvisionProject(context.Background(), org.ID,
				"Concurrent", nil, "same-concurrent-attempt")
			if callErr != nil {
				errors <- callErr
				return
			}
			results <- result
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	close(errors)
	for callErr := range errors {
		t.Errorf("ProvisionProject: %v", callErr)
	}

	projectIDs := map[string]struct{}{}
	for result := range results {
		projectIDs[result.Project.ID] = struct{}{}
	}
	if len(projectIDs) != 1 {
		t.Fatalf("concurrent project ids = %#v, want one", projectIDs)
	}
	var projectCount, environmentCount, activeKeyCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM projects WHERE org_id = $1 AND idempotency_token = 'same-concurrent-attempt'`, org.ID,
	).Scan(&projectCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM environments e
		JOIN projects p ON p.id = e.project_id
		WHERE p.org_id = $1 AND p.idempotency_token = 'same-concurrent-attempt'`, org.ID,
	).Scan(&environmentCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM environment_api_keys ak
		JOIN environments e ON e.id = ak.environment_id
		JOIN projects p ON p.id = e.project_id
		WHERE p.org_id = $1 AND p.idempotency_token = 'same-concurrent-attempt'
		  AND ak.revoked_at IS NULL`, org.ID,
	).Scan(&activeKeyCount); err != nil {
		t.Fatal(err)
	}
	if projectCount != 1 || environmentCount != 1 || activeKeyCount != 1 {
		t.Fatalf("projects=%d environments=%d active_keys=%d, want 1/1/1",
			projectCount, environmentCount, activeKeyCount)
	}
}
