# Batch 5 — The Ladder ("act on it") Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship issue #57: insight cards + Generate-fix from `awaiting_approval`, the per-project friction-autonomy ladder, idempotent + attributable PR receipts, honest Suggestion labeling in the PR body, and a conditional lift of the friction auto-fix gate.

**Architecture:** Batch 3 already shipped all the schema (`004_friction.sql`: `pr_outcomes`, `projects.friction_autonomy`, `error_group_jobs.triggered_by`, the `candidate`/`awaiting_approval`/`insight` statuses) and Suggestion PR titles/headings. Batch 5 is wiring: the Go webhook writes receipts *before* state transitions (keyed on GitHub's delivery id), the worker records the fix-job id on the group at PR creation and consults `friction_autonomy` before auto-fixing friction, the ingestion API exposes autonomy settings + a fix-stats aggregation, and the Vue dashboard grows the `awaiting_approval` Generate-fix affordance, the insight card, and the autonomy settings panel with receipts beside it.

**Tech Stack:** Go 1.24 + chi + pgx (`packages/ingestion`), Node 22 + TypeScript + Vitest (`packages/worker`), Vue 3 + Vite (`packages/dashboard`), Postgres migrations in `packages/ingestion/db/migrations/` applied by `scripts/run-migrations.sh`.

**Design source:** `docs/plans/2026-07-13-unified-incidents-replay-friction-design.md` §4 (ladder), §5 (receipts), Batch 5 definition. Issue: #57.

---

## Current state (verified 2026-07-15 — do NOT rebuild these)

| Piece | State | Where |
|---|---|---|
| Statuses `candidate`/`awaiting_approval`/`insight` | DONE | `004_friction.sql:10-12`; `candidate` hidden at `packages/ingestion/db/queries.go:541,728` |
| `pr_outcomes` table (UNIQUE `github_delivery_id`, `fix_job_id`) | DONE (schema only, zero writers) | `004_friction.sql:74-84` |
| `error_group_jobs.triggered_by` | DONE; `'human'` written by `TriggerFixJob` (`queries.go:803-804`), `'auto'` by `updateGroupAndCreateFixJob` (`packages/worker/src/db.ts:938-941`) | |
| `projects.friction_autonomy` (`ask_first`/`auto_fix`/`auto_fix_ux`) | DONE (column only; nothing reads or writes it) | `004_friction.sql:96-106` |
| TriggerFix accepts friction+`awaiting_approval`, error+`investigated` | DONE + tested | `queries.go:772-817`, `friction_test.go:101` |
| Worker friction investigate → `awaiting_approval`/`insight` | DONE | `packages/worker/src/index.ts:468,478` |
| Friction auto-fix hard gate | ACTIVE (unconditional) | `packages/worker/src/index.ts:545-549`, test `__tests__/index.test.ts:366` |
| Suggestion PR title + body heading | DONE + tested | `packages/worker/src/pr.ts:268-270,410-412`; `pr.test.ts:143,252` |
| Webhook handler | Transitions state, no receipts, no delivery id, `closed` always reverts to `investigated` (wrong for friction) | `packages/ingestion/handler/webhook.go` |
| Dashboard fix button | `investigated`-only | `IncidentDetail.vue:373` |
| Batch 4 (#56, auto-created friction incidents) | NOT LANDED | Batch 5 does not require it to implement; the organic dogfood gate does (Task 11 seeds manually) |

Branch: `abhishekray07/session-replay-batch-5` (this worktree). Commit after every task.

---

### Task 1: Migration 007 — `pr_fix_job_id` on `error_groups`

The design (v4-17) requires recording the fix-job id **at PR creation** so a later webhook outcome is attributable. `pr_outcomes.fix_job_id` exists but nothing can populate it — the group row must carry the link between PR creation and the webhook.

**Files:**
- Create: `packages/ingestion/db/migrations/007_receipts_wiring.sql`

**Step 1: Write the migration**

```sql
-- 007_receipts_wiring.sql — Batch 5 (epic #31, issue #57): attributable receipts.
-- Append-only after 001-006. IDEMPOTENCY IS MANDATORY: run-migrations.sh
-- re-applies every file on every start.
--
-- The fix job that produced a PR, recorded at PR creation (design v4-17) so the
-- merge/close webhook can copy it into pr_outcomes.fix_job_id. NULL for PRs
-- created before Batch 5 and for setup PRs. Cleared when a PR closes unmerged.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS pr_fix_job_id UUID
  REFERENCES error_group_jobs(id) ON DELETE SET NULL;
```

**Step 2: Verify idempotency against a disposable database**

Two traps here: `scripts/run-migrations.sh` defaults `MIGRATION_DIR` to `/app/db/migrations` and **exits 0 when that directory is absent** — so running it bare on the host succeeds without applying anything. And the Compose postgres keeps a retained `pgdata` volume, so it is not disposable. Create a scratch database inside the container and apply every migration there twice, running `psql` inside the container (the host may not have it):

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U opslane -d postgres \
  -c 'DROP DATABASE IF EXISTS migration_check;' -c 'CREATE DATABASE migration_check;'
for run in 1 2; do
  for f in packages/ingestion/db/migrations/*.sql; do
    echo "run $run: $f"
    docker compose exec -T postgres psql -U opslane -d migration_check -v ON_ERROR_STOP=1 < "$f" || exit 1
  done
done
docker compose exec -T postgres psql -U opslane -d postgres -c 'DROP DATABASE migration_check;'
```

Expected: both passes apply all 7 files with no errors (`ON_ERROR_STOP=1` makes any failure exit non-zero). The "representative existing database" check from ingestion `AGENTS.md` happens in Task 11's live smoke, where migrations run against the retained dev DB.

**Step 3: Verify Go still builds and db tests pass**

```bash
cd packages/ingestion && go build ./... && go test ./db
```

Expected: PASS (no code references the column yet).

**Step 4: Commit**

```bash
git add packages/ingestion/db/migrations/007_receipts_wiring.sql
git commit -m "feat: add pr_fix_job_id column for attributable PR receipts (#57)"
```

---

### Task 2: Worker records the fix-job id at PR creation

**Files:**
- Modify: `packages/worker/src/db.ts:380-450` (`updateGroupStatus`)
- Modify: `packages/worker/src/index.ts:766-770` (fix-job success path)
- Test: `packages/worker/src/__tests__/index.test.ts`
- Test (update): `packages/worker/src/__tests__/db-queries.test.ts:300-307` — this test pins `updateGroupStatus`'s parameter array by index (`[1][6]` = reason_code, `[1][7]`, `[1][8]`); the shift below moves those to `[1][7]/[1][8]/[1][9]`. Update the assertions or the suite fails mechanically.

**Step 1: Write the failing test**

In `index.test.ts`, find the `processFixJob` success-path test (the one that mocks `runPipeline` returning `{ status: 'pr_created', ... }`; if none exists, add one next to the `describe` at line 196 using the same `fixJob()`/mock helpers). Assert the new field:

```ts
it('records the fix job id on the group at PR creation', async () => {
  // arrange mocks so runPipeline resolves { status: 'pr_created', pr_url, pr_number, confidence }
  const job = fixJob();
  await processFixJob(job, new AbortController().signal);

  expect(mockUpdateGroupStatus).toHaveBeenCalledWith(
    'grp-1', 'proj-1', 'pr_created',
    expect.objectContaining({ pr_fix_job_id: job.id }),
    job,
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/worker test -- index.test.ts`
Expected: FAIL — `pr_fix_job_id` not in the call.

**Step 3: Implement**

In `db.ts` `updateGroupStatus`, add to the `fields` type:

```ts
    pr_fix_job_id?: string;
```

Rewrite the UPDATE so `pr_fix_job_id` becomes `$7` and everything after shifts by one (reason columns → `$8/$9/$10`, lease params in `ownedCte` → `$11/$12/$13`):

```ts
     UPDATE error_groups
     SET status = $3::error_group_status,
         confidence = $4,
         pr_url = $5,
         pr_number = $6,
         pr_fix_job_id = COALESCE($7, pr_fix_job_id),
         reason_code = $8,
         reason_message = $9,
         remediation = $10,
         updated_at = now()
```

(`COALESCE` so the many other `updateGroupStatus` callers that omit the field don't null out an existing link.) Add `fields?.pr_fix_job_id ?? null,` to the params array after `pr_number`, and update the three `ownedCte` placeholders (`$10/$11/$12` → `$11/$12/$13`).

In `index.ts:766`, add the field:

```ts
      await updateGroupStatus(job.errorGroupId, job.projectId, 'pr_created', {
        confidence: result.confidence,
        pr_url: result.pr_url,
        pr_number: result.pr_number,
        pr_fix_job_id: job.id,
      }, job);
```

(`job.id` for a fix job IS the fix-job id — the lease is the job row.)

**Step 4: Run tests**

Run: `pnpm --filter @opslane/worker test`
Expected: PASS (all worker tests, not just the new one — the param renumbering can silently break other `updateGroupStatus` paths).

**Step 5: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/index.ts packages/worker/src/__tests__/index.test.ts
git commit -m "feat: record fix job id on the group at PR creation (#57)"
```

---

### Task 3: `ProcessPRWebhook` — receipt before transition, idempotent, kind-aware

Replaces `TransitionOnPRMerge`/`TransitionOnPRClose` (`packages/ingestion/db/queries.go:1104-1155`) with one transactional method that (a) writes the `pr_outcomes` receipt **first**, (b) no-ops on a redelivered `github_delivery_id`, (c) sends a closed-unmerged **friction** group back to `awaiting_approval` (not `investigated` — today's close path is wrong for friction), and (d) clears `pr_fix_job_id` on close.

**Files:**
- Modify: `packages/ingestion/db/queries.go` (delete the two old methods, add `ProcessPRWebhook`)
- Test: `packages/ingestion/db/queries_test.go` (rewrite `TestTransitionOnPRMergeAndClose` at line 182)

**Step 0: Fix test cleanup first**

`cleanupTenant` (`packages/ingestion/db/testhelper_test.go:40`) deletes `error_group_jobs` and `error_groups` — but `pr_outcomes` has FKs to both, so any receipt-writing test would leave FK-protected rows and poison later runs. Add as the FIRST delete in the list:

```go
		`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
```

**Step 1: Write the failing tests**

Rewrite/replace `TestTransitionOnPRMergeAndClose` with tests for the new method. Reuse the existing seeding helpers in `queries_test.go`/`friction_test.go` (`createFrictionTestProject`, `insertIncident` — `friction_test.go:12-40`). Set `pr_number`/`status='pr_created'` with a direct `q.Pool().Exec` UPDATE, as `insertIncident` doesn't take PR fields.

```go
func TestProcessPRWebhook_ReceiptBeforeTransition_Idempotent(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "pr-webhook-merge")
	ctx := context.Background()
	groupID := insertIncident(t, q, projectID, "fp-webhook-1", "error", "pr_created")
	mustExec(t, q, `UPDATE error_groups SET pr_number = 41, pr_url = 'https://x/41' WHERE id = $1`, groupID)

	res, err := q.ProcessPRWebhook(ctx, "org/repo", 41, true, "delivery-aaa", time.Now())
	if err != nil || res.GroupID != groupID || res.Duplicate {
		t.Fatalf("ProcessPRWebhook = (%+v, %v), want group %s, not duplicate", res, err, groupID)
	}
	// Receipt exists with the right outcome
	var outcome string
	if err := q.Pool().QueryRow(ctx,
		`SELECT outcome FROM pr_outcomes WHERE error_group_id = $1 AND github_delivery_id = 'delivery-aaa'`,
		groupID).Scan(&outcome); err != nil || outcome != "merged" {
		t.Fatalf("receipt = (%q, %v), want merged", outcome, err)
	}
	// Group transitioned
	assertGroupStatus(t, q, groupID, "merged")

	// Redelivery: same delivery id → duplicate, still exactly one receipt
	res, err = q.ProcessPRWebhook(ctx, "org/repo", 41, true, "delivery-aaa", time.Now())
	if err != nil || !res.Duplicate {
		t.Fatalf("redelivery = (%+v, %v), want duplicate", res, err)
	}
	var n int
	q.Pool().QueryRow(ctx, `SELECT count(*) FROM pr_outcomes WHERE error_group_id = $1`, groupID).Scan(&n)
	if n != 1 {
		t.Fatalf("receipts = %d, want 1", n)
	}
}

func TestProcessPRWebhook_FrictionCloseAttributesAndReturnsToAwaitingApproval(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "pr-webhook-close")
	ctx := context.Background()
	groupID := insertIncident(t, q, projectID, "fp-webhook-2", "friction", "pr_created")

	// A real fix job, attached at "PR creation" — attribution must survive the webhook.
	var fixJob string
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		 VALUES ($1, $2, 'fix', 'human') RETURNING id`, groupID, projectID).Scan(&fixJob); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}
	mustExec(t, q, `UPDATE error_groups SET pr_number = 42, pr_url = 'https://x/42', pr_fix_job_id = $2 WHERE id = $1`,
		groupID, fixJob)

	res, err := q.ProcessPRWebhook(ctx, "org/repo", 42, false, "delivery-bbb", time.Now())
	if err != nil || res.GroupID != groupID {
		t.Fatalf("ProcessPRWebhook = (%+v, %v)", res, err)
	}
	// The receipt carries the exact fix job id (design v4-17: attributable).
	var receiptJob *string
	if err := q.Pool().QueryRow(ctx,
		`SELECT fix_job_id FROM pr_outcomes WHERE github_delivery_id = 'delivery-bbb'`).Scan(&receiptJob); err != nil {
		t.Fatalf("receipt: %v", err)
	}
	if receiptJob == nil || *receiptJob != fixJob {
		t.Fatalf("receipt fix_job_id = %v, want %s", receiptJob, fixJob)
	}
	// Friction returns to awaiting_approval (not investigated) and PR fields clear.
	assertGroupStatus(t, q, groupID, "awaiting_approval")
	var prURL, groupFixJob *string
	q.Pool().QueryRow(ctx, `SELECT pr_url, pr_fix_job_id FROM error_groups WHERE id = $1`, groupID).Scan(&prURL, &groupFixJob)
	if prURL != nil || groupFixJob != nil {
		t.Fatalf("pr fields not cleared: url=%v fixJob=%v", prURL, groupFixJob)
	}
}

func TestProcessPRWebhook_NoMatch(t *testing.T) {
	q, _ := createFrictionTestProject(t, "pr-webhook-nomatch")
	res, err := q.ProcessPRWebhook(context.Background(), "org/repo", 999, true, "delivery-ccc", time.Now())
	if err != nil || res.GroupID != "" {
		t.Fatalf("no-match = (%+v, %v), want empty group", res, err)
	}
}
```

Add small helpers `mustExec` / `assertGroupStatus` if they don't already exist in the test package (grep first). Keep the error-kind close case from the old test: error + close → `investigated`.

**Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./db -run TestProcessPRWebhook`
Expected: FAIL — `ProcessPRWebhook` undefined.

**Step 3: Implement**

Delete `TransitionOnPRMerge` and `TransitionOnPRClose`; add (near the "Resolution lifecycle" section, keeping the multi-project caveat comment):

```go
// PRWebhookResult reports how a pull_request webhook was applied.
type PRWebhookResult struct {
	GroupID   string
	Duplicate bool // receipt for this github_delivery_id already existed; no transition performed
}

// ProcessPRWebhook records an immutable pr_outcomes receipt and then transitions
// the matched group — receipt BEFORE state clearing, idempotent on GitHub's
// delivery id (design v4-17). A closed-unmerged friction group returns to
// awaiting_approval; an error group returns to investigated.
// Matches by github_repo + pr_number + status='pr_created' (see the
// multi-project-per-repo caveat that applied to the old transition methods).
//
// Idempotency MUST be checked against pr_outcomes before matching the group:
// the first delivery moves the group out of pr_created (or clears pr_number),
// so a redelivery would otherwise look like no_match and never reach the
// unique-constraint conflict. The ON CONFLICT on the insert remains as the
// backstop for two concurrent deliveries of the same id racing this check.
func (q *Queries) ProcessPRWebhook(ctx context.Context, githubRepo string, prNumber int, merged bool, deliveryID string, occurredAt time.Time) (PRWebhookResult, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Redelivery fast-path: this delivery id was already counted.
	var seenGroup string
	err = tx.QueryRow(ctx,
		`SELECT error_group_id FROM pr_outcomes WHERE github_delivery_id = $1`,
		deliveryID,
	).Scan(&seenGroup)
	if err == nil {
		return PRWebhookResult{GroupID: seenGroup, Duplicate: true}, nil // read-only; deferred rollback is fine
	}
	if err != pgx.ErrNoRows {
		return PRWebhookResult{}, fmt.Errorf("check delivery id: %w", err)
	}

	var groupID, projectID, kind string
	var fixJobID *string
	err = tx.QueryRow(ctx,
		`SELECT eg.id, eg.project_id, eg.kind, eg.pr_fix_job_id
		 FROM error_groups eg
		 JOIN projects p ON eg.project_id = p.id
		 WHERE p.github_repo = $1 AND eg.pr_number = $2 AND eg.status = 'pr_created'
		 FOR UPDATE OF eg`,
		githubRepo, prNumber,
	).Scan(&groupID, &projectID, &kind, &fixJobID)
	if err == pgx.ErrNoRows {
		return PRWebhookResult{}, nil
	}
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("match pr webhook group: %w", err)
	}

	outcome := "closed"
	if merged {
		outcome = "merged"
	}
	ct, err := tx.Exec(ctx,
		`INSERT INTO pr_outcomes (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (github_delivery_id) DO NOTHING`,
		groupID, projectID, prNumber, outcome, deliveryID, fixJobID, occurredAt,
	)
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("insert pr outcome: %w", err)
	}
	if ct.RowsAffected() == 0 {
		// Redelivered webhook: the outcome is already counted; do not transition again.
		if err := tx.Commit(ctx); err != nil {
			return PRWebhookResult{}, fmt.Errorf("commit tx: %w", err)
		}
		return PRWebhookResult{GroupID: groupID, Duplicate: true}, nil
	}

	if merged {
		_, err = tx.Exec(ctx,
			`UPDATE error_groups SET status = 'merged', merged_at = now(), updated_at = now() WHERE id = $1`,
			groupID)
	} else {
		_, err = tx.Exec(ctx,
			`UPDATE error_groups
			 SET status = CASE WHEN kind = 'friction'
			                   THEN 'awaiting_approval'::error_group_status
			                   ELSE 'investigated'::error_group_status END,
			     pr_url = NULL, pr_number = NULL, pr_fix_job_id = NULL, updated_at = now()
			 WHERE id = $1`,
			groupID)
	}
	if err != nil {
		return PRWebhookResult{}, fmt.Errorf("transition on pr %s: %w", outcome, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PRWebhookResult{}, fmt.Errorf("commit tx: %w", err)
	}
	return PRWebhookResult{GroupID: groupID}, nil
}
```

Note: `webhook.go` still calls the deleted methods — the package won't compile until Task 4. Do Task 4 before running the full build; run only `go vet ./db` here if needed, or fold Steps 4-5 of this task into Task 4's verification. Preferred: implement Task 3 + Task 4 code, then run tests for both.

**Step 4: Commit** (after Task 4's tests pass — single commit is fine, or commit both tasks together)

---

### Task 4: Webhook handler reads `X-GitHub-Delivery` and calls `ProcessPRWebhook`

**Files:**
- Modify: `packages/ingestion/handler/webhook.go`
- Test: `packages/ingestion/handler/webhook_test.go`

**Step 1: Write the failing test**

`webhook_test.go` currently only unit-tests `verifyWebhookSignature`. Add an httptest for the missing-delivery-id guard (no DB needed — the guard fires before any query):

```go
func TestHandleWebhook_MissingDeliveryID(t *testing.T) {
	t.Setenv("GITHUB_WEBHOOK_SECRET", "test-secret")
	payload := []byte(`{"action":"closed","pull_request":{"number":1,"merged":true},"repository":{"full_name":"org/repo"}}`)
	mac := hmac.New(sha256.New, []byte("test-secret"))
	mac.Write(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", bytes.NewReader(payload))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-GitHub-Event", "pull_request")
	// no X-GitHub-Delivery header

	rec := httptest.NewRecorder()
	(&Dependencies{}).HandleWebhook(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
```

**Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./handler -run TestHandleWebhook_MissingDeliveryID`
Expected: FAIL (currently processes without the header, panics on nil Queries or returns non-400).

**Step 3: Implement**

In `webhook.go`:

1. Add `"time"` to imports; extend the payload struct:

```go
type pullRequestEvent struct {
	Action      string `json:"action"`
	PullRequest struct {
		Number   int        `json:"number"`
		Merged   bool       `json:"merged"`
		ClosedAt *time.Time `json:"closed_at"`
	} `json:"pull_request"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
}
```

2. After the event-type check (line 57) and before unmarshal, read the delivery id:

```go
	deliveryID := r.Header.Get("X-GitHub-Delivery")
	if deliveryID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing X-GitHub-Delivery header")
		return
	}
```

3. Replace the entire merged/closed branch (lines 72-103) with one call:

```go
	repo := event.Repository.FullName
	prNumber := event.PullRequest.Number
	occurredAt := time.Now()
	if event.PullRequest.ClosedAt != nil {
		occurredAt = *event.PullRequest.ClosedAt
	}
	action := "closed"
	if event.PullRequest.Merged {
		action = "merged"
	}

	result, err := d.Queries.ProcessPRWebhook(r.Context(), repo, prNumber, event.PullRequest.Merged, deliveryID, occurredAt)
	if err != nil {
		slog.Error("webhook: process PR event failed", "repo", repo, "pr", prNumber, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process pull_request event")
		return
	}
	status := "processed"
	switch {
	case result.Duplicate:
		status = "duplicate"
	case result.GroupID == "":
		status = "no_match"
	}
	slog.Info("webhook: PR "+action, "repo", repo, "pr", prNumber, "group_id", result.GroupID, "status", status, "delivery_id", deliveryID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": status, "action": action, "group_id": result.GroupID})
```

**Step 4: Run tests to verify pass**

```bash
cd packages/ingestion && go build ./... && go test ./db ./handler
```
Expected: PASS, including Task 3's `TestProcessPRWebhook_*`.

**Step 5: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/queries_test.go packages/ingestion/handler/webhook.go packages/ingestion/handler/webhook_test.go
git commit -m "feat: idempotent, attributable PR receipts before state transitions (#57)"
```

---

### Task 5: Autonomy settings API (read + PATCH)

**Files:**
- Modify: `packages/ingestion/db/queries.go` (`Project` struct :58, `UpdateProject` :1539, and **every** query that scans a `Project` — grep `github_repo, default_branch, created_at` and add `friction_autonomy` to each RETURNING/SELECT + Scan: `CreateProject`, `GetProjectByID`, `ListProjectsByOrg`, `UpdateProject`, and any others the grep finds)
- Modify: `packages/ingestion/handler/read_api.go` (`projectJSON`/`toProjectJSON` :93-107, `UpdateProjectEndpoint` :426-456)
- Test: `packages/ingestion/db/friction_test.go`

**Step 1: Write the failing test**

```go
func TestUpdateProjectFrictionAutonomy(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "autonomy-settings")
	ctx := context.Background()

	var orgID string
	if err := q.Pool().QueryRow(ctx, `SELECT org_id FROM projects WHERE id = $1`, projectID).Scan(&orgID); err != nil {
		t.Fatalf("get org: %v", err)
	}

	// Default surfaces on the struct
	autoFix := "auto_fix"
	p, err := q.UpdateProject(ctx, orgID, projectID, nil, &autoFix)
	if err != nil || p == nil {
		t.Fatalf("UpdateProject: %v", err)
	}
	if p.FrictionAutonomy != "auto_fix" {
		t.Fatalf("FrictionAutonomy = %q, want auto_fix", p.FrictionAutonomy)
	}
	// Omitted field is preserved (COALESCE semantics)
	if p.GithubRepo == nil || *p.GithubRepo != "org/repo" {
		t.Fatalf("GithubRepo clobbered: %v", p.GithubRepo)
	}
	// CHECK constraint rejects garbage
	bad := "yolo"
	if _, err := q.UpdateProject(ctx, orgID, projectID, nil, &bad); err == nil {
		t.Fatal("expected CHECK violation for invalid autonomy value")
	}
}
```

**Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./db -run TestUpdateProjectFrictionAutonomy`
Expected: FAIL — `UpdateProject` takes 4 args; `FrictionAutonomy` undefined.

**Step 3: Implement**

`Project` struct gains `FrictionAutonomy string`. New `UpdateProject`:

```go
// UpdateProject updates a project's settings. Only non-nil fields are changed
// (COALESCE), so PATCH callers can send a single field. Tenant-scoped by orgID.
func (q *Queries) UpdateProject(ctx context.Context, orgID, projectID string, githubRepo, frictionAutonomy *string) (*Project, error) {
	var p Project
	err := q.pool.QueryRow(ctx,
		`UPDATE projects
		 SET github_repo = COALESCE($3, github_repo),
		     friction_autonomy = COALESCE($4, friction_autonomy)
		 WHERE id = $2 AND org_id = $1
		 RETURNING id, org_id, name, github_repo, default_branch, friction_autonomy, created_at`,
		orgID, projectID, githubRepo, frictionAutonomy,
	).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultBranch, &p.FrictionAutonomy, &p.CreatedAt)
	...
```

(Behavior note, deliberate: `github_repo` can no longer be nulled via PATCH — the dashboard never does that; document in the commit message.)

Update every other `Project` scan site found by the grep the same way. `projectJSON`:

```go
type projectJSON struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	GithubRepo       *string `json:"github_repo"`
	FrictionAutonomy string  `json:"friction_autonomy"`
	CreatedAt        string  `json:"created_at"`
}
```

`UpdateProjectEndpoint` request + validation (validate in the handler so the client gets a 400, not a 500 from the CHECK):

```go
	var req struct {
		GithubRepo       *string `json:"github_repo"`
		FrictionAutonomy *string `json:"friction_autonomy"`
	}
	...
	if req.FrictionAutonomy != nil {
		switch *req.FrictionAutonomy {
		case "ask_first", "auto_fix", "auto_fix_ux":
		default:
			writeJSONError(w, http.StatusBadRequest, "friction_autonomy must be one of ask_first, auto_fix, auto_fix_ux")
			return
		}
	}
	project, err := d.Queries.UpdateProject(r.Context(), orgID, projectID, req.GithubRepo, req.FrictionAutonomy)
```

**Step 4: Handler-layer test (validation + serialization)**

A DB-backed httptest harness already exists in this package — read `packages/ingestion/handler/read_api_test.go` and follow its setup pattern (Dependencies + real Queries + authenticated session). Add to it:

```go
// TestUpdateProjectEndpoint_FrictionAutonomy:
//  1. PATCH {"friction_autonomy":"yolo"}      → 400 (handler validation, not a 500 from the CHECK)
//  2. PATCH {"friction_autonomy":"auto_fix"}  → 200; response JSON has "friction_autonomy":"auto_fix"
//  3. PATCH {"github_repo":"org/other"}       → 200; response still has "friction_autonomy":"auto_fix" (COALESCE preserved)
```

**Step 5: Run tests**

```bash
cd packages/ingestion && go build ./... && go test ./db ./handler
```
Expected: PASS (fix any other `UpdateProject` caller the compiler flags, e.g. in `Settings`/onboarding paths — pass `nil` for autonomy).

**Step 6: Commit**

```bash
git add packages/ingestion
git commit -m "feat: expose friction_autonomy on the project settings API (#57)"
```

---

### Task 6: Fix-stats endpoint (receipts beside the toggle)

Design §5: per category — generated (by `triggered_by`) → merged/closed (from `pr_outcomes`).

**Files:**
- Modify: `packages/ingestion/db/queries.go` (add `FixStats` + `GetFixStats`)
- Modify: `packages/ingestion/handler/read_api.go` (add `GetFixStatsEndpoint`)
- Modify: `packages/ingestion/handler/routes.go` (add route near line 117)
- Test: `packages/ingestion/db/friction_test.go`

**Step 1: Write the failing test**

```go
func TestGetFixStats(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "fix-stats")
	ctx := context.Background()

	errGroup := insertIncident(t, q, projectID, "fp-stats-err", "error", "merged")
	fricGroup := insertIncident(t, q, projectID, "fp-stats-fric", "friction", "pr_created")

	var errJob, fricJob string
	q.Pool().QueryRow(ctx, `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		VALUES ($1, $2, 'fix', 'auto') RETURNING id`, errGroup, projectID).Scan(&errJob)
	q.Pool().QueryRow(ctx, `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		VALUES ($1, $2, 'fix', 'human') RETURNING id`, fricGroup, projectID).Scan(&fricJob)
	mustExec(t, q, `INSERT INTO pr_outcomes (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at)
		VALUES ($1, $2, 41, 'merged', 'stats-d1', $3, now())`, errGroup, projectID, errJob)
	mustExec(t, q, `INSERT INTO pr_outcomes (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at)
		VALUES ($1, $2, 42, 'closed', 'stats-d2', $3, now())`, fricGroup, projectID, fricJob)

	stats, err := q.GetFixStats(ctx, projectID)
	if err != nil {
		t.Fatalf("GetFixStats: %v", err)
	}
	if s := stats["error"]; s.GeneratedAuto != 1 || s.PRsMerged != 1 {
		t.Fatalf("error stats = %+v", s)
	}
	if s := stats["friction"]; s.GeneratedHuman != 1 || s.PRsClosed != 1 {
		t.Fatalf("friction stats = %+v", s)
	}
}
```

**Step 2: Run to verify failure** — `go test ./db -run TestGetFixStats` → FAIL, undefined.

**Step 3: Implement**

```go
// FixStats are the receipts shown beside each autonomy toggle (design §5).
type FixStats struct {
	GeneratedAuto  int `json:"generated_auto"`
	GeneratedHuman int `json:"generated_human"`
	PRsMerged      int `json:"prs_merged"`
	PRsClosed      int `json:"prs_closed"`
}

// GetFixStats aggregates fix generation and PR outcomes per incident kind. Tenant-scoped.
func (q *Queries) GetFixStats(ctx context.Context, projectID string) (map[string]FixStats, error) {
	stats := map[string]FixStats{"error": {}, "friction": {}}

	rows, err := q.pool.Query(ctx,
		`SELECT eg.kind, j.triggered_by, count(*)
		 FROM error_group_jobs j JOIN error_groups eg ON j.error_group_id = eg.id
		 WHERE j.project_id = $1 AND j.job_type IN ('fix', 'error_fix') AND j.triggered_by IS NOT NULL
		 GROUP BY 1, 2`, projectID)
	if err != nil {
		return nil, fmt.Errorf("fix stats jobs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind, trigger string
		var n int
		if err := rows.Scan(&kind, &trigger, &n); err != nil {
			return nil, fmt.Errorf("scan fix stats jobs: %w", err)
		}
		s := stats[kind]
		if trigger == "human" {
			s.GeneratedHuman = n
		} else {
			s.GeneratedAuto = n
		}
		stats[kind] = s
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate fix stats jobs: %w", err)
	}

	rows2, err := q.pool.Query(ctx,
		`SELECT eg.kind, o.outcome, count(*)
		 FROM pr_outcomes o JOIN error_groups eg ON o.error_group_id = eg.id
		 WHERE o.project_id = $1
		 GROUP BY 1, 2`, projectID)
	if err != nil {
		return nil, fmt.Errorf("fix stats outcomes: %w", err)
	}
	defer rows2.Close()
	for rows2.Next() {
		var kind, outcome string
		var n int
		if err := rows2.Scan(&kind, &outcome, &n); err != nil {
			return nil, fmt.Errorf("scan fix stats outcomes: %w", err)
		}
		s := stats[kind]
		if outcome == "merged" {
			s.PRsMerged = n
		} else {
			s.PRsClosed = n
		}
		stats[kind] = s
	}
	if err := rows2.Err(); err != nil {
		return nil, fmt.Errorf("iterate fix stats outcomes: %w", err)
	}
	return stats, nil
}
```

Handler (mirror `ListEnvironmentsEndpoint`'s shape, `read_api.go:459+`):

```go
// GetFixStatsEndpoint returns per-kind fix generation and PR outcome counts.
// GET /api/v1/projects/{projectID}/fix-stats
func (d *Dependencies) GetFixStatsEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	stats, err := d.Queries.GetFixStats(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load fix stats")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}
```

Route (`routes.go`, with the other project GETs): `r.With(deps.AuthenticateSession).Get("/projects/{projectID}/fix-stats", deps.GetFixStatsEndpoint)`

**Step 4: Handler-layer test** — in the `read_api_test.go`-style harness: `GET /projects/{id}/fix-stats` returns 200 with both `"error"` and `"friction"` keys and all four counters (assert the JSON shape, not just status), and an unauthenticated request is rejected. This also proves the route is actually wired in `routes.go`.

**Step 5: Run** — `go build ./... && go test ./db ./handler` → PASS.

**Step 6: Commit** — `git commit -m "feat: fix-stats receipts aggregation endpoint (#57)"`

---

### Task 7: Worker lifts the friction auto-fix gate behind the autonomy ladder

Two touch points: (a) the friction **investigate** path auto-triggers a fix for code-caused, high-confidence friction when autonomy allows; (b) the **fix-job** gate (`index.ts:545-549`) re-checks autonomy at execution time (settings may change between enqueue and claim) instead of refusing unconditionally. `auto_fix_ux` behaves like `auto_fix` for now — there is no UX-suggestion fix category yet (`insight` never gets a PR); the rung exists so opting in is a one-time setting.

**Files:**
- Modify: `packages/worker/src/db.ts:551-566` (`ProjectData` + `getProject`), `:504-524` (`ErrorGroupData` + `getErrorGroup` gain `confidence`)
- Modify: `packages/worker/src/index.ts:465-490` (friction investigate routing), `:545-549` (gate)
- Test: `packages/worker/src/__tests__/index.test.ts` (new cases + update the existing refusal test at :366, which expects `undefined` fields)

**Pre-existing bug fixed in passing:** today's refusal path (`index.ts:546`) passes `undefined` fields to `updateGroupStatus`, which writes `confidence = NULL` (`db.ts:425,439`) — so refusing a job erases the investigation's confidence. The gate below preserves it. This matters for the settings-change race: autonomy can be downgraded to `ask_first` between enqueue and claim, and the refusal must not degrade the parked incident.

**Step 1: Write the failing tests**

First extend the `db.getProject` mock's default return with `friction_autonomy: 'ask_first'` (find the existing mock; every existing test must keep passing on the ask-first default — including the line-366 refusal test). Then:

```ts
it('auto-triggers a friction fix when autonomy is auto_fix and confidence is high', async () => {
  mockGetProject.mockResolvedValue({ ...baseProject, friction_autonomy: 'auto_fix' });
  // arrange investigateFriction mock → { codeCause: true, confidence: 'high', reason, remediation }
  await processInvestigateJob(makeFrictionJob(), new AbortController().signal);

  expect(db.updateGroupAndCreateFixJob).toHaveBeenCalledWith(
    'grp-1', 'proj-1',
    expect.objectContaining({ confidence: 'high' }),
    expect.anything(),
  );
  expect(db.updateGroupInvestigation).not.toHaveBeenCalledWith(
    'grp-1', 'proj-1', 'awaiting_approval', expect.anything(), expect.anything(),
  );
});

it('parks medium-confidence friction in awaiting_approval even with auto_fix autonomy', async () => {
  mockGetProject.mockResolvedValue({ ...baseProject, friction_autonomy: 'auto_fix' });
  // investigateFriction mock → { codeCause: true, confidence: 'medium', ... }
  await processInvestigateJob(makeFrictionJob(), new AbortController().signal);

  expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
    'grp-1', 'proj-1', 'awaiting_approval', expect.anything(), expect.anything(),
  );
  expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
});

it('processes an auto friction fix job when autonomy allows it', async () => {
  mockGetProject.mockResolvedValue({ ...baseProject, friction_autonomy: 'auto_fix' });
  const job = { ...makeJob(), jobType: 'fix' as const, triggeredBy: 'auto' as const };

  await processFixJob(job, new AbortController().signal);

  expect(mockCloneRepo).toHaveBeenCalled(); // gate did not refuse
});

it('still refuses an auto friction fix job under ask_first, preserving confidence', async () => {
  // The settings-change race: autonomy was auto_fix at enqueue, downgraded before claim.
  mockGetProject.mockResolvedValue({ ...baseProject, friction_autonomy: 'ask_first' });
  mockGetErrorGroup.mockResolvedValue({ ...baseFrictionGroup, confidence: 'high' });
  const job = { ...makeJob(), jobType: 'fix' as const, triggeredBy: 'auto' as const };

  await processFixJob(job, new AbortController().signal);

  expect(mockUpdateGroupStatus).toHaveBeenCalledWith(
    'grp-1', 'proj-1', 'awaiting_approval',
    expect.objectContaining({ confidence: 'high' }), // NOT undefined — see pre-existing bug note
    job,
  );
  expect(mockCloneRepo).not.toHaveBeenCalled();
});
```

Also update the existing refusal test (`index.test.ts:366-375`): its `toHaveBeenCalledWith(..., 'awaiting_approval', undefined, job)` expectation becomes the fields object above.

Adapt helper names (`makeJob`, `fixJob`, mock handles) to what the file actually uses — read the existing friction tests around lines 330-380 first.

**Step 2: Run to verify failure** — `pnpm --filter @opslane/worker test -- index.test.ts` → new tests FAIL.

**Step 3: Implement**

`db.ts`:

```ts
export type FrictionAutonomy = 'ask_first' | 'auto_fix' | 'auto_fix_ux';

export interface ProjectData {
  id: string;
  name: string;
  github_repo: string;
  default_branch: string;
  friction_autonomy: FrictionAutonomy;
}
```
and add `friction_autonomy` to `getProject`'s SELECT. Also add `confidence` to `ErrorGroupData` and `getErrorGroup`'s SELECT (`db.ts:504-524`) so the gate can preserve it:

```ts
export interface ErrorGroupData {
  // ...existing fields...
  confidence: ConfidenceLevel | null;
}
```

`index.ts` — friction investigate routing (the `result.codeCause` branch at :467; `project` is already in scope from :425):

```ts
    if (result.codeCause) {
      // Autonomy ladder (design §4): code-caused, high-confidence friction may
      // route straight to a fix once the project has opted past ask-first.
      // auto_fix_ux currently behaves like auto_fix — insight never gets a PR,
      // so there is no separate UX-suggestion fix category yet.
      if (result.confidence === 'high' && project.friction_autonomy !== 'ask_first') {
        const fixJobId = await updateGroupAndCreateFixJob(job.errorGroupId, job.projectId, {
          rootCause: result.reason,
          suggestedMitigation: result.remediation,
          confidence: result.confidence,
        }, job);
        logger.info('Friction investigation: auto-triggering fix (autonomy ladder)', {
          job_id: job.id, fix_job_id: fixJobId, autonomy: project.friction_autonomy,
        });
      } else {
        await updateGroupInvestigation(job.errorGroupId, job.projectId, 'awaiting_approval', {
          rootCause: result.reason,
          suggestedMitigation: result.remediation,
          confidence: result.confidence,
        }, job);
        logger.info('Friction investigation: awaiting human approval', {
          job_id: job.id, confidence: result.confidence,
        });
      }
    } else {
```

(`updateGroupAndCreateFixJob` requires the group to be in `analyzing` — it is: `processInvestigateJob` sets `analyzing` at `index.ts:202` before branching into the friction path. It inserts the fix job with `triggered_by='auto'`.)

`index.ts` — the gate in `processFixJob` (:545):

```ts
  if (group.kind === 'friction' && job.triggeredBy !== 'human') {
    // Re-check autonomy at execution time: settings may have changed between
    // enqueue and claim, and legacy jobs (triggeredBy null) are never auto-run.
    const gateProject = await db.getProject(job.projectId);
    const autonomy = gateProject?.friction_autonomy ?? 'ask_first';
    if (job.triggeredBy !== 'auto' || autonomy === 'ask_first') {
      // Preserve the investigation's confidence — updateGroupStatus writes
      // omitted fields as NULL (db.ts:425,439).
      await updateGroupStatus(job.errorGroupId, job.projectId, 'awaiting_approval', {
        confidence: group.confidence ?? undefined,
      }, job);
      logger.warn('Refused non-human friction fix job', { job_id: job.id, autonomy });
      return;
    }
  }
```

**Step 4: Run all worker tests** — `pnpm --filter @opslane/worker test` → PASS (the pre-existing refusal test must still pass via the ask-first default mock).

**Step 5: Commit** — `git commit -m "feat: lift the friction auto-fix gate behind the autonomy ladder (#57)"`

---

### Task 8: Honest Suggestion line in the friction PR body

The title/heading already say Suggestion; the body's confidence line (`packages/worker/src/pr.ts:278`) still claims `✅ Tests passing` identically for both kinds. Design: the gate proves "nothing broke," not "the friction is gone."

**Files:**
- Modify: `packages/worker/src/pr.ts:278` area (`buildPRBody`)
- Test: `packages/worker/src/__tests__/pr.test.ts`

**Step 1: Write the failing test** (next to the existing friction tests at :143):

```ts
it('marks the friction body as unverified against the original friction', () => {
  const body = buildPRBody({ ...baseInput, kind: 'friction' });
  expect(body).toContain('friction itself was not re-verified');
  expect(body).not.toContain('**Confidence:** High · ✅ Tests passing');
});
```

(Adapt `baseInput` to the fixture the file already uses.)

**Step 2: Run to verify failure** — `pnpm --filter @opslane/worker test -- pr.test.ts` → FAIL.

**Step 3: Implement** — read `pr.ts:270-285`, then branch the line:

```ts
  const confidenceLine = input.kind === 'friction'
    ? '**Confidence:** Suggestion · ✅ Repo tests passing · ⚠️ The friction itself was not re-verified — review before merging'
    : '**Confidence:** High · ✅ Tests passing';
```

and use `confidenceLine` where the literal was.

**Step 4: Run** — `pnpm --filter @opslane/worker test -- pr.test.ts` → PASS (all, including the two existing Suggestion tests).

**Step 5: Commit** — `git commit -m "feat: friction PR body states the suggestion is unverified (#57)"`

---

### Task 9: Dashboard — Generate fix from `awaiting_approval` + insight card

**Files:**
- Modify: `packages/dashboard/src/views/IncidentDetail.vue` (root-cause card :347, fix button :371-405)

No component test harness exists for the dashboard; verification is typecheck/build (Step 3) plus the live smoke in Task 11.

**Step 1: Root-cause card also renders for `awaiting_approval`**

Change the `v-if` at :348 to:

```
v-if="(incident.status === 'investigated' || incident.status === 'awaiting_approval' || incident.status === 'fixing' || incident.status === 'needs_human') && incident.root_cause"
```

**Step 2: Add the insight card and extend the fix button**

Insert after the root-cause card (before the Find Fix block):

```html
        <!-- Insight card (friction, no code cause — terminal, never a PR; design v4-4) -->
        <div
          v-if="incident.status === 'insight'"
          class="p-4 bg-purple-500/10 border border-purple-500/20 border-l-2 border-l-purple-500 rounded-lg space-y-3"
        >
          <p class="text-sm font-medium text-purple-400">Insight — no code cause</p>
          <p class="text-xs text-text-muted">
            Opslane investigated this friction and found no code change that would fix it.
            No PR will be created; use the findings below to guide a product or UX change.
          </p>
          <div v-if="incident.root_cause">
            <p class="text-xs font-medium text-purple-400 uppercase tracking-wide">What users hit</p>
            <pre
              class="mt-1 text-sm bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre-wrap text-text"
              v-text="incident.root_cause"
            ></pre>
          </div>
        </div>
```

Change the fix block's `v-if` (:373) and button label:

```
v-if="incident.status === 'investigated' || incident.status === 'awaiting_approval'"
```

Inside the block, above the guidance label, add the Suggestion note:

```html
          <p v-if="incident.status === 'awaiting_approval'" class="text-xs text-text-muted">
            This friction fix has a code cause and is waiting for your approval.
            It will open a <strong>Suggestion</strong> PR — repo tests must pass,
            but the friction itself is not re-verified.
          </p>
```

and the button text:

```html
              <span v-if="fixLoading">Triggering...</span>
              <span v-else>{{ incident.status === 'awaiting_approval' ? 'Generate fix' : 'Find Fix' }}</span>
```

`handleTriggerFix` and the polling logic need no changes — the backend already accepts friction+`awaiting_approval` (`queries.go:785-789`).

**Step 3: Verify build/typecheck**

Run: `pnpm --filter @opslane/dashboard build` (check the exact package name in `packages/dashboard/package.json` first)
Expected: builds clean.

**Step 4: Commit** — `git commit -m "feat: insight card and Generate-fix from awaiting_approval (#57)"`

---

### Task 10: Dashboard — autonomy settings with receipts beside the toggle

**Files:**
- Modify: `packages/dashboard/src/api.ts` (`Project` :143, `updateProject` :209; add `FixStats` + `getFixStats`)
- Modify: `packages/dashboard/src/views/Settings.vue`

**Step 1: API client**

```ts
export interface Project {
  id: string;
  name: string;
  github_repo: string | null;
  friction_autonomy: 'ask_first' | 'auto_fix' | 'auto_fix_ux';
  created_at: string;
}

export function updateProject(
  projectId: string,
  data: { github_repo?: string; friction_autonomy?: Project['friction_autonomy'] }
): Promise<Project> {
  return patchJSON<Project>(`/projects/${projectId}`, data);
}

export interface FixStats {
  generated_auto: number;
  generated_human: number;
  prs_merged: number;
  prs_closed: number;
}

export function getFixStats(projectId: string): Promise<Record<'error' | 'friction', FixStats>> {
  return fetchJSON<Record<'error' | 'friction', FixStats>>(`/projects/${projectId}/fix-stats`);
}
```

**Step 2: Settings panel**

Read `Settings.vue` fully first and copy its existing card/section markup and save-feedback pattern. Important: the view has **no `selectedProject` object** — only `projects: Ref<Project[]>` and `selectedProjectId: Ref<string>` (`Settings.vue:26-28`), and the ID can be a manually-typed one that isn't in the list. Add a computed, a watcher-driven loader with a stale-request guard, and per-option receipts (the design says stats beside **each** toggle, not one summary line):

```html
    <!-- Friction autonomy (Batch 5, issue #57) -->
    <section class="p-4 bg-surface border border-border rounded-lg space-y-3">
      <div>
        <h2 class="text-sm font-medium text-text">Friction autonomy</h2>
        <p class="mt-1 text-xs text-text-muted">
          How Opslane acts on friction incidents (rage clicks, dead clicks, form abandonment)
          that have a code cause. Error fixes are unaffected.
        </p>
      </div>
      <p v-if="!selectedProject" class="text-xs text-text-faint">
        Select one of your projects above to manage autonomy.
        (Manually entered project IDs can't be managed here.)
      </p>
      <div v-else class="space-y-2">
        <label
          v-for="opt in autonomyOptions"
          :key="opt.value"
          class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer"
          :class="autonomy === opt.value ? 'border-teal bg-teal-500/5' : 'border-border'"
        >
          <input
            type="radio"
            name="friction-autonomy"
            class="mt-0.5"
            :value="opt.value"
            :checked="autonomy === opt.value"
            :disabled="autonomySaving"
            @change="saveAutonomy(opt.value)"
          />
          <span>
            <span class="block text-sm text-text">{{ opt.label }}</span>
            <span class="block text-xs text-text-muted">{{ opt.description }}</span>
            <!-- Receipts beside each toggle (design §5) -->
            <span v-if="fixStats" class="block mt-1 text-xs text-text-faint">{{ optionStats(opt.value) }}</span>
          </span>
        </label>
      </div>
      <p v-if="autonomyError" class="text-sm text-red" v-text="autonomyError"></p>
    </section>
```

Script additions (adapt to the file's existing composition-API style and selected-project ref):

```ts
const autonomyOptions = [
  { value: 'ask_first', label: 'Ask first (default)', description: 'Friction fixes wait in awaiting-approval until you click Generate fix.' },
  { value: 'auto_fix', label: 'Auto-fix', description: 'High-confidence, code-caused friction goes straight to a Suggestion PR.' },
  { value: 'auto_fix_ux', label: 'Auto-fix incl. UX suggestions', description: 'Same as auto-fix today; reserved for UX-suggestion fixes when they ship.' },
] as const;

const selectedProject = computed(() =>
  projects.value.find((p) => p.id === selectedProjectId.value) ?? null,
);

const autonomy = ref<Project['friction_autonomy']>('ask_first');
const autonomySaving = ref(false);
const autonomyError = ref('');
const fixStats = ref<Record<'error' | 'friction', FixStats> | null>(null);
let statsRequestToken = 0; // stale-response guard when switching projects quickly

watch(selectedProjectId, loadAutonomyAndStats, { immediate: true });
// projects load async on mount — re-derive the toggle once they arrive
watch(projects, () => {
  autonomy.value = selectedProject.value?.friction_autonomy ?? 'ask_first';
});

async function loadAutonomyAndStats() {
  autonomyError.value = '';
  fixStats.value = null;
  autonomy.value = selectedProject.value?.friction_autonomy ?? 'ask_first';
  const id = selectedProjectId.value;
  if (!id || !selectedProject.value) return; // manual IDs: card shows the hint instead
  const token = ++statsRequestToken;
  try {
    const stats = await getFixStats(id);
    if (token === statsRequestToken) fixStats.value = stats; // drop stale responses
  } catch {
    // stats are best-effort; the toggle works without them
  }
}

async function saveAutonomy(value: Project['friction_autonomy']) {
  if (!selectedProject.value) return;
  const prev = autonomy.value;
  autonomy.value = value;
  autonomySaving.value = true;
  autonomyError.value = '';
  try {
    const updated = await updateProject(selectedProject.value.id, { friction_autonomy: value });
    // keep the local list in sync so switching away and back shows the saved value
    projects.value = projects.value.map((p) => (p.id === updated.id ? updated : p));
  } catch (err) {
    autonomy.value = prev; // roll back the optimistic flip
    autonomyError.value = err instanceof Error ? err.message : 'Failed to save autonomy setting';
  } finally {
    autonomySaving.value = false;
  }
}

function optionStats(value: Project['friction_autonomy']): string {
  const f = fixStats.value?.friction;
  if (!f) return '';
  switch (value) {
    case 'ask_first':
      return `${f.generated_human} friction fixes generated on request`;
    case 'auto_fix':
      return `${f.generated_auto} auto-generated · ${f.prs_merged} merged · ${f.prs_closed} closed without merge`;
    case 'auto_fix_ux':
      return 'No UX-suggestion fixes yet';
  }
}
```

(Import `computed`/`watch` from `vue` if the file doesn't already; import `getFixStats` and the `FixStats` type from `../api`.)

**Step 3: Verify** — `pnpm --filter @opslane/dashboard build` → clean.

**Step 4: Commit** — `git commit -m "feat: autonomy ladder settings with fix receipts (#57)"`

---### Task 11: Full gate, live smoke, and the dogfood gate

**Step 1: Full repository gate** (AGENTS.md order — fix at each step):

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Step 2: Live smoke (required — pipeline behavior changed).** Two setup traps: Compose defaults `GITHUB_WEBHOOK_SECRET` to empty (`docker-compose.yml:65`), which makes the webhook return 500 — export a secret **before** starting; and there is no host-side `DATABASE_URL`/psql — run SQL through the container. Migrations apply on ingestion container start (that's the "representative existing database" check from ingestion `AGENTS.md`).

```bash
export GITHUB_WEBHOOK_SECRET=smoke-secret
docker compose up -d --build
docker compose exec -T postgres psql -U opslane -d opslane < scripts/seed-e2e.sql
```

Then exercise the four new paths against the running stack:

1. **TriggerFix from awaiting_approval:** insert a friction group (`kind='friction'`, `status='awaiting_approval'`, a `root_cause`) for the seeded project via psql; open the dashboard incident page → the Suggestion note + **Generate fix** button render; click it → group flips to `fixing`, an `error_group_jobs` row exists with `triggered_by='human'`. (Keyless worker will land it in `needs_human` with `missing_llm_key` — that still proves the route.)
2. **Webhook receipts:** insert a group with `status='pr_created'`, `pr_number`, a real fix-job row and its id in `pr_fix_job_id`; POST a signed `pull_request` closed payload (HMAC with `smoke-secret`, recipe in `webhook_test.go`) with an `X-GitHub-Delivery` header → `pr_outcomes` has one row with that delivery id **and that fix job id**; POST the identical payload again → response `"status":"duplicate"`, still one row; friction group is back in `awaiting_approval`.
3. **Autonomy settings:** in Settings, flip the project to Auto-fix → PATCH succeeds, per-option receipt lines render from `/fix-stats`; confirm `projects.friction_autonomy='auto_fix'` in psql.
4. **The auto_fix gate path (the headline behavior — must be smoked, not just unit-tested):** with the project set to `auto_fix`, insert a friction group and a pending fix job with `triggered_by='auto'` → the keyless worker passes the gate (log shows no "Refused non-human friction fix job") and proceeds until the missing LLM key lands it in `needs_human` — proving the gate opens. Flip the project back to `ask_first`, repeat → the job is refused, the group returns to `awaiting_approval`, and its `confidence` is unchanged in psql (the settings-change race).

**Step 3: The issue #57 gate — do not check it off from seeded data.** Issue #57 names #56 (Batch 4) as a dependency and its gate demands a **real dogfood** friction incident. Two runs:
- **Implementation proof (now, seeded):** with `ANTHROPIC_API_KEY` + a GitHub-connected repo, seed `friction_signals` from a real `test-fixtures/vue-app` rage-click session (the `test-e2e/friction-smoke.test.ts` flow), create the friction group by hand, run the keyed worker: investigation → `awaiting_approval` → click **Generate fix** → a PR titled `[Opslane] Suggestion: …` with the unverified-friction line and the tests+judge gate intact. Comment the PR link on #57 as implementation evidence.
- **Gate check-off (after #56 lands):** re-run organically — real detection creates the incident, no manual SQL — and only then check off #57's gate. If Abhishek decides seeded proof should suffice instead, amend the issue text explicitly; don't quietly reinterpret the gate.

**Step 4: Update docs if drift-checked.** Run `node scripts/check-docs-drift.mjs` (CI runs it); update `docs/contracts/` or package `AGENTS.md` files if the webhook response shape or settings API is documented there (grep `docs/contracts` for `webhook`, `projects`).

**Step 5: Final commit + PR**

```bash
git push -u origin abhishekray07/session-replay-batch-5
gh pr create --title "Batch 5 — The ladder: act on friction (#57)" --body "Closes #57. ..."
```

---

## Verification strategy while Batch 4 (#56) is developed in parallel

Batch 5 consumes incidents in `awaiting_approval`/`insight`; Batch 4 only automates *producing* them. So nothing here waits on Batch 4:

1. **Unit layer (no Batch 4):** worker Vitest proves gate/autonomy/labeling/attribution logic; Go tests against real Postgres prove the receipts guarantees (receipt-before-transition, delivery-id idempotency, kind-aware close) — these are DB semantics and are fully provable now.
2. **Live smoke (seeded):** insert `awaiting_approval` friction groups by SQL — the same bridge `test-e2e/friction-smoke.test.ts` already uses for the missing scheduler. Observe the button → `fixing` → `triggered_by='human'`; signed webhook curl → one receipt, duplicate redelivery → still one; settings PATCH → column + stats.
3. **Dogfood proof (keyed, seeded):** the full `awaiting_approval` → Suggestion-PR flow runs today with a seeded incident — implementation evidence, posted to #57. It is **not** the issue's gate: #57 names #56 as a dependency and demands a real dogfood incident.
4. **Gate check-off (post-merge, both branches):** organic path — rage-click fixture → Batch 4 creates the incident → Batch 5 affordances, zero manual SQL. Only this run checks off #57's gate (or Abhishek explicitly amends the issue to accept seeded proof).

Coordination with the Batch 4 branch:
- **Migration numbers:** this plan claims `007_receipts_wiring.sql`. Agree now that Batch 4 takes `008+`; whoever merges second renumbers (runner applies lexically).
- **`packages/worker/src/index.ts`:** both branches touch it (Batch 5: investigate routing + fix gate; Batch 4: enqueueing upstream). Expect textual conflicts; rebase before merge and re-run the full worker suite after resolving.
- **Safety across the merge gap:** the gate is autonomy-aware with `ask_first` as the column default, so if Batch 4's detection turns on before or after Batch 5 merges, nothing auto-PRs until a project explicitly opts in. Merge order does not matter for safety.

## Out of scope (deliberately)

- **Batch 4 (#56)** adjudicate→fold→aggregate and auto-created friction incidents — separate issue; Batch 5 works against manually-seeded incidents.
- **Kind badges on the inbox** — Batch 4 scope (design §6).
- **Pricing decision** ("does a friction fix bill like an error fix") — flagged in the design as decide-before-Batch-5; a product call, not code. Raise it with Abhishek before shipping the autonomy toggle publicly.
- **A distinct behavior for `auto_fix_ux`** — no UX-suggestion fix category exists yet (`insight` never produces a PR); the rung is settings-only until then.
