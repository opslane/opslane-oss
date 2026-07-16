package db_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

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

func TestProcessPRWebhook_ReceiptBeforeTransition_Idempotent(t *testing.T) {
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

	result, err := q.ProcessPRWebhook(ctx, "org/pr-lifecycle", 7, true, "delivery-merge", time.Now())
	if err != nil || result.GroupID != groupID || result.Duplicate {
		t.Fatalf("ProcessPRWebhook = (%+v, %v), want group %s, not duplicate", result, err, groupID)
	}
	if got := groupStatus(t, pool, groupID); got != "merged" {
		t.Fatalf("group status = %q, want merged", got)
	}

	var outcome string
	if err := pool.QueryRow(ctx,
		`SELECT outcome FROM pr_outcomes
		 WHERE error_group_id = $1 AND github_delivery_id = 'delivery-merge'`,
		groupID,
	).Scan(&outcome); err != nil || outcome != "merged" {
		t.Fatalf("receipt = (%q, %v), want merged", outcome, err)
	}

	result, err = q.ProcessPRWebhook(ctx, "org/pr-lifecycle", 7, true, "delivery-merge", time.Now())
	if err != nil || !result.Duplicate || result.GroupID != groupID {
		t.Fatalf("redelivery = (%+v, %v), want duplicate for group %s", result, err, groupID)
	}
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM pr_outcomes WHERE error_group_id = $1`, groupID,
	).Scan(&count); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if count != 1 {
		t.Fatalf("receipts = %d, want 1", count)
	}
}

func TestProcessPRWebhook_ConcurrentRedeliveryReportsDuplicate(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, _, groupID := seedGroup(t, pool, q, "pr-webhook-concurrent")
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups
		 SET status = 'pr_created', pr_number = 71, pr_url = 'https://example.test/pull/71'
		 WHERE id = $1`,
		groupID,
	); err != nil {
		t.Fatalf("set PR fields: %v", err)
	}

	type callResult struct {
		result db.PRWebhookResult
		err    error
	}
	start := make(chan struct{})
	results := make(chan callResult, 2)
	for range 2 {
		go func() {
			<-start
			result, err := q.ProcessPRWebhook(
				ctx, "org/pr-webhook-concurrent", 71, true, "delivery-concurrent", time.Now(),
			)
			results <- callResult{result: result, err: err}
		}()
	}
	close(start)

	duplicates := 0
	processed := 0
	for range 2 {
		call := <-results
		if call.err != nil {
			t.Fatalf("ProcessPRWebhook: %v", call.err)
		}
		if call.result.GroupID != groupID {
			t.Fatalf("result group = %q, want %q", call.result.GroupID, groupID)
		}
		if call.result.Duplicate {
			duplicates++
		} else {
			processed++
		}
	}
	if processed != 1 || duplicates != 1 {
		t.Fatalf("processed=%d duplicates=%d, want one of each", processed, duplicates)
	}

	var receiptCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM pr_outcomes WHERE github_delivery_id = 'delivery-concurrent'`,
	).Scan(&receiptCount); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if receiptCount != 1 {
		t.Fatalf("receipt count = %d, want 1", receiptCount)
	}
}

func TestProcessPRWebhook_FrictionCloseAttributesAndReturnsToAwaitingApproval(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "pr-webhook-friction-close")
	ctx := context.Background()
	groupID := insertIncident(t, q, projectID, "fp-webhook-friction-close", "friction", "pr_created")

	var fixJobID string
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		 VALUES ($1, $2, 'fix', 'human') RETURNING id`,
		groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}
	if _, err := q.Pool().Exec(ctx,
		`UPDATE error_groups
		 SET pr_number = 42, pr_url = 'https://github.com/org/repo/pull/42', pr_fix_job_id = $2
		 WHERE id = $1`,
		groupID, fixJobID,
	); err != nil {
		t.Fatalf("set PR fields: %v", err)
	}

	result, err := q.ProcessPRWebhook(ctx, "org/repo", 42, false, "delivery-friction-close", time.Now())
	if err != nil || result.GroupID != groupID || result.Duplicate {
		t.Fatalf("ProcessPRWebhook = (%+v, %v), want group %s", result, err, groupID)
	}
	if got := groupStatus(t, q.Pool(), groupID); got != "awaiting_approval" {
		t.Fatalf("group status = %q, want awaiting_approval", got)
	}

	var receiptJobID *string
	if err := q.Pool().QueryRow(ctx,
		`SELECT fix_job_id FROM pr_outcomes WHERE github_delivery_id = 'delivery-friction-close'`,
	).Scan(&receiptJobID); err != nil {
		t.Fatalf("query receipt: %v", err)
	}
	if receiptJobID == nil || *receiptJobID != fixJobID {
		t.Fatalf("receipt fix_job_id = %v, want %s", receiptJobID, fixJobID)
	}

	var prURL *string
	var prNumber *int
	var groupFixJobID *string
	if err := q.Pool().QueryRow(ctx,
		`SELECT pr_url, pr_number, pr_fix_job_id FROM error_groups WHERE id = $1`, groupID,
	).Scan(&prURL, &prNumber, &groupFixJobID); err != nil {
		t.Fatalf("query PR fields: %v", err)
	}
	if prURL != nil || prNumber != nil || groupFixJobID != nil {
		t.Fatalf("PR fields not cleared: url=%v number=%v fix_job_id=%v", prURL, prNumber, groupFixJobID)
	}
}

func TestProcessPRWebhook_ErrorCloseRevertsToInvestigated(t *testing.T) {
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

	result, err := q.ProcessPRWebhook(ctx, "org/pr-close", 3, false, "delivery-error-close", time.Now())
	if err != nil || result.GroupID != groupID {
		t.Fatalf("ProcessPRWebhook = (%+v, %v), want group %s", result, err, groupID)
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

func TestProcessPRWebhook_ReopenedMergeRecoversViaReceipt(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "pr-webhook-reopen-merge")
	ctx := context.Background()
	groupID := insertIncident(t, q, projectID, "fp-webhook-reopen", "friction", "pr_created")

	var fixJobID string
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		 VALUES ($1, $2, 'fix', 'human') RETURNING id`,
		groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}
	if _, err := q.Pool().Exec(ctx,
		`UPDATE error_groups
		 SET pr_number = 55, pr_url = 'https://github.com/org/repo/pull/55', pr_fix_job_id = $2
		 WHERE id = $1`,
		groupID, fixJobID,
	); err != nil {
		t.Fatalf("set PR fields: %v", err)
	}

	// Close unmerged: receipt written, PR fields cleared, group parked.
	if _, err := q.ProcessPRWebhook(ctx, "org/repo", 55, false, "delivery-reopen-close", time.Now()); err != nil {
		t.Fatalf("close delivery: %v", err)
	}
	if got := groupStatus(t, q.Pool(), groupID); got != "awaiting_approval" {
		t.Fatalf("group status after close = %q, want awaiting_approval", got)
	}

	// Reopen + merge: no pr_created match remains, but the close receipt still
	// links repo+pr_number to the group — the merge must be recovered.
	mergedAt := time.Now().Add(-2 * time.Minute).UTC().Truncate(time.Second)
	result, err := q.ProcessPRWebhook(ctx, "org/repo", 55, true, "delivery-reopen-merge", mergedAt)
	if err != nil || result.GroupID != groupID || result.Duplicate {
		t.Fatalf("recovered merge = (%+v, %v), want group %s", result, err, groupID)
	}
	if got := groupStatus(t, q.Pool(), groupID); got != "merged" {
		t.Fatalf("group status after recovered merge = %q, want merged", got)
	}

	// The recovered receipt keeps the fix-job attribution and the PR's actual
	// merge time (not webhook-processing time) lands in merged_at.
	var receiptJobID *string
	if err := q.Pool().QueryRow(ctx,
		`SELECT fix_job_id FROM pr_outcomes WHERE github_delivery_id = 'delivery-reopen-merge'`,
	).Scan(&receiptJobID); err != nil {
		t.Fatalf("query recovered receipt: %v", err)
	}
	if receiptJobID == nil || *receiptJobID != fixJobID {
		t.Fatalf("recovered receipt fix_job_id = %v, want %s", receiptJobID, fixJobID)
	}
	var mergedAtDB time.Time
	if err := q.Pool().QueryRow(ctx,
		`SELECT merged_at FROM error_groups WHERE id = $1`, groupID,
	).Scan(&mergedAtDB); err != nil {
		t.Fatalf("query merged_at: %v", err)
	}
	if !mergedAtDB.UTC().Truncate(time.Second).Equal(mergedAt) {
		t.Fatalf("merged_at = %v, want %v", mergedAtDB.UTC(), mergedAt)
	}

	// Redelivery of the recovered merge stays idempotent.
	result, err = q.ProcessPRWebhook(ctx, "org/repo", 55, true, "delivery-reopen-merge", time.Now())
	if err != nil || !result.Duplicate || result.GroupID != groupID {
		t.Fatalf("recovered-merge redelivery = (%+v, %v), want duplicate", result, err)
	}
	var receipts int
	if err := q.Pool().QueryRow(ctx,
		`SELECT count(*) FROM pr_outcomes WHERE error_group_id = $1`, groupID,
	).Scan(&receipts); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if receipts != 2 {
		t.Fatalf("receipts = %d, want 2 (close + recovered merge)", receipts)
	}
}

func TestProcessPRWebhook_NoMatch(t *testing.T) {
	q, _ := createFrictionTestProject(t, "pr-webhook-no-match")
	result, err := q.ProcessPRWebhook(
		context.Background(), "org/repo", 999, true, "delivery-no-match", time.Now(),
	)
	if err != nil || result.GroupID != "" || result.Duplicate {
		t.Fatalf("no match = (%+v, %v), want empty result", result, err)
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
