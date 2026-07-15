package db_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// seedGroup creates an org/project/environment hierarchy plus one ingested
// error group and returns the pieces tests need.
func seedGroup(t *testing.T, pool *pgxpool.Pool, q *db.Queries, name string) (orgID, projectID, envID, groupID string) {
	t.Helper()
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, name)
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	proj, err := q.CreateProject(ctx, org.ID, name+"-proj", ptrStr("org/"+name))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:     proj.ID,
		EnvironmentID: env.ID,
		ErrorType:     "TypeError",
		ErrorMessage:  "boom",
		StackTraceRaw: "at app.js:1:1",
		Fingerprint:   "fp-" + name,
		Title:         "TypeError: boom",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}
	return org.ID, proj.ID, env.ID, result.GroupID
}

func setGroupStatus(t *testing.T, pool *pgxpool.Pool, groupID, status string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups SET status = $2::error_group_status WHERE id = $1`, groupID, status); err != nil {
		t.Fatalf("set group status: %v", err)
	}
}

func groupStatus(t *testing.T, pool *pgxpool.Pool, groupID string) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM error_groups WHERE id = $1`, groupID).Scan(&status); err != nil {
		t.Fatalf("query group status: %v", err)
	}
	return status
}

func TestUpdateErrorGroupStatus_NeedsHumanRequiresReasonFields(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "status-reason")

	// Missing reason fields must be rejected before touching the row.
	err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: projID,
		GroupID:   groupID,
		Status:    "needs_human",
	})
	if err == nil || !strings.Contains(err.Error(), "needs_human requires") {
		t.Fatalf("expected needs_human validation error, got %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "queued" {
		t.Fatalf("group status changed to %q despite validation error", got)
	}

	// Complete needs_human update succeeds.
	err = q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID:     projID,
		GroupID:       groupID,
		Status:        "needs_human",
		ReasonCode:    ptrStr("low_confidence_fix"),
		ReasonMessage: ptrStr("The fix did not pass the confidence gate."),
		Remediation:   ptrStr("Review the investigation writeup."),
	})
	if err != nil {
		t.Fatalf("UpdateErrorGroupStatus: %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "needs_human" {
		t.Fatalf("group status = %q, want needs_human", got)
	}
}

func TestUpdateErrorGroupStatus_IsTenantScoped(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, _, groupID := seedGroup(t, pool, q, "status-tenant-a")
	_, otherProjID, _, _ := seedGroup(t, pool, q, "status-tenant-b")

	err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: otherProjID, // wrong tenant for groupID
		GroupID:   groupID,
		Status:    "pr_created",
		PrURL:     ptrStr("https://github.com/org/repo/pull/1"),
	})
	if err == nil || !strings.Contains(err.Error(), "no matching row") {
		t.Fatalf("expected cross-tenant update to fail, got %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "queued" {
		t.Fatalf("cross-tenant update mutated group: status = %q", got)
	}
}

func TestTriggerFixJob_OnlyFromInvestigated(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "trigger-fix")

	// Not yet investigated: refused.
	if _, err := q.TriggerFixJob(ctx, projID, groupID, ""); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("expected ErrNotInvestigated for queued group, got %v", err)
	}

	setGroupStatus(t, pool, groupID, "investigated")

	jobID, err := q.TriggerFixJob(ctx, projID, groupID, "focus on the null check")
	if err != nil {
		t.Fatalf("TriggerFixJob: %v", err)
	}
	if jobID == "" {
		t.Fatal("expected non-empty job ID")
	}
	if got := groupStatus(t, pool, groupID); got != "fixing" {
		t.Fatalf("group status = %q, want fixing", got)
	}

	var jobType, jobStatus, guidance string
	if err := pool.QueryRow(ctx,
		`SELECT job_type, status, COALESCE(guidance, '') FROM error_group_jobs WHERE id = $1`, jobID,
	).Scan(&jobType, &jobStatus, &guidance); err != nil {
		t.Fatalf("query job: %v", err)
	}
	if jobType != "fix" || jobStatus != "pending" || guidance != "focus on the null check" {
		t.Fatalf("job = (%q, %q, %q), want (fix, pending, guidance)", jobType, jobStatus, guidance)
	}

	// Already fixing: a second trigger is refused (no double-queue).
	if _, err := q.TriggerFixJob(ctx, projID, groupID, ""); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("expected ErrNotInvestigated on double trigger, got %v", err)
	}
}

func TestTriggerFixJob_IsTenantScoped(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, _, groupID := seedGroup(t, pool, q, "trigger-tenant-a")
	_, otherProjID, _, _ := seedGroup(t, pool, q, "trigger-tenant-b")

	setGroupStatus(t, pool, groupID, "investigated")

	if _, err := q.TriggerFixJob(ctx, otherProjID, groupID, ""); !errors.Is(err, db.ErrNotInvestigated) {
		t.Fatalf("expected cross-tenant trigger to be refused, got %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "investigated" {
		t.Fatalf("cross-tenant trigger mutated group: status = %q", got)
	}
}

func TestTransitionOnPRMergeAndClose(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "pr-lifecycle")

	// Put the group into pr_created with a PR number.
	if err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: projID,
		GroupID:   groupID,
		Status:    "pr_created",
		PrURL:     ptrStr("https://github.com/org/pr-lifecycle/pull/7"),
	}); err != nil {
		t.Fatalf("UpdateErrorGroupStatus: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET pr_number = 7 WHERE id = $1`, groupID); err != nil {
		t.Fatalf("set pr_number: %v", err)
	}

	// Wrong repo/PR: no transition, no error.
	if id, err := q.TransitionOnPRMerge(ctx, "org/other-repo", 7); err != nil || id != "" {
		t.Fatalf("TransitionOnPRMerge(wrong repo) = (%q, %v), want empty", id, err)
	}
	if id, err := q.TransitionOnPRMerge(ctx, "org/pr-lifecycle", 999); err != nil || id != "" {
		t.Fatalf("TransitionOnPRMerge(wrong PR) = (%q, %v), want empty", id, err)
	}

	// Matching merge transitions to merged.
	id, err := q.TransitionOnPRMerge(ctx, "org/pr-lifecycle", 7)
	if err != nil {
		t.Fatalf("TransitionOnPRMerge: %v", err)
	}
	if id != groupID {
		t.Fatalf("TransitionOnPRMerge returned %q, want %q", id, groupID)
	}
	if got := groupStatus(t, pool, groupID); got != "merged" {
		t.Fatalf("group status = %q, want merged", got)
	}

	// A merged group is terminal for the PR lifecycle: close is a no-op.
	if id, err := q.TransitionOnPRClose(ctx, "org/pr-lifecycle", 7); err != nil || id != "" {
		t.Fatalf("TransitionOnPRClose after merge = (%q, %v), want empty", id, err)
	}
}

func TestTransitionOnPRClose_RevertsToInvestigated(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "pr-close")

	if err := q.UpdateErrorGroupStatus(ctx, db.StatusUpdate{
		ProjectID: projID,
		GroupID:   groupID,
		Status:    "pr_created",
		PrURL:     ptrStr("https://github.com/org/pr-close/pull/3"),
	}); err != nil {
		t.Fatalf("UpdateErrorGroupStatus: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET pr_number = 3 WHERE id = $1`, groupID); err != nil {
		t.Fatalf("set pr_number: %v", err)
	}

	id, err := q.TransitionOnPRClose(ctx, "org/pr-close", 3)
	if err != nil {
		t.Fatalf("TransitionOnPRClose: %v", err)
	}
	if id != groupID {
		t.Fatalf("TransitionOnPRClose returned %q, want %q", id, groupID)
	}
	if got := groupStatus(t, pool, groupID); got != "investigated" {
		t.Fatalf("group status = %q, want investigated", got)
	}

	var prURL *string
	var prNumber *int
	if err := pool.QueryRow(ctx,
		`SELECT pr_url, pr_number FROM error_groups WHERE id = $1`, groupID).Scan(&prURL, &prNumber); err != nil {
		t.Fatalf("query pr fields: %v", err)
	}
	if prURL != nil || prNumber != nil {
		t.Fatalf("PR fields not cleared on close: pr_url=%v pr_number=%v", prURL, prNumber)
	}
}

func TestResolveArchiveUnarchiveLifecycle(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, projID, _, groupID := seedGroup(t, pool, q, "lifecycle")

	if err := q.ResolveErrorGroup(ctx, projID, groupID); err != nil {
		t.Fatalf("ResolveErrorGroup: %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "resolved" {
		t.Fatalf("group status = %q, want resolved", got)
	}

	if err := q.ArchiveErrorGroup(ctx, projID, groupID); err != nil {
		t.Fatalf("ArchiveErrorGroup: %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "archived" {
		t.Fatalf("group status = %q, want archived", got)
	}

	// Archived groups cannot be resolved; they must be unarchived first.
	if err := q.ResolveErrorGroup(ctx, projID, groupID); err == nil {
		t.Fatal("expected ResolveErrorGroup on archived group to fail")
	}

	if err := q.UnarchiveErrorGroup(ctx, projID, groupID); err != nil {
		t.Fatalf("UnarchiveErrorGroup: %v", err)
	}
	if got := groupStatus(t, pool, groupID); got != "investigated" {
		t.Fatalf("group status = %q, want investigated", got)
	}

	// Unarchiving a non-archived group fails.
	if err := q.UnarchiveErrorGroup(ctx, projID, groupID); err == nil {
		t.Fatal("expected UnarchiveErrorGroup on non-archived group to fail")
	}
}

func TestLookupAPIKey_ResolvesTenantChainAndHonorsRevocation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	orgID, projID, envID, _ := seedGroup(t, pool, q, "api-key")

	key, err := q.CreateAPIKey(ctx, envID)
	if err != nil {
		t.Fatalf("CreateAPIKey: %v", err)
	}
	if !strings.HasPrefix(key.RawKey, "def_") {
		t.Fatalf("raw key %q missing def_ prefix", key.RawKey)
	}

	lookup, err := q.LookupAPIKey(ctx, key.RawKey)
	if err != nil {
		t.Fatalf("LookupAPIKey: %v", err)
	}
	if lookup.OrgID != orgID || lookup.ProjectID != projID || lookup.EnvironmentID != envID {
		t.Fatalf("lookup = %+v, want org=%s project=%s env=%s", lookup, orgID, projID, envID)
	}

	// Unknown key is rejected.
	if _, err := q.LookupAPIKey(ctx, "def_not-a-real-key"); err == nil {
		t.Fatal("expected unknown key lookup to fail")
	}

	// Revoked key is rejected.
	if _, err := pool.Exec(ctx,
		`UPDATE environment_api_keys SET revoked_at = now() WHERE id = $1`, key.ID); err != nil {
		t.Fatalf("revoke key: %v", err)
	}
	if _, err := q.LookupAPIKey(ctx, key.RawKey); err == nil {
		t.Fatal("expected revoked key lookup to fail")
	}
}
