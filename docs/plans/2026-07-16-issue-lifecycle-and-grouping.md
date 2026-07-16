# Issue Lifecycle & Grouping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Opslane issues group correctly and close on their own — fix over-splitting from cache-busting hashes, auto-resolve issues that stop happening, and reopen them only on a genuinely newer release (release-aware regression).

**Architecture:** Three independent workstreams, shippable as separate commits/PRs.
- **A — Grouping (Go/ingestion):** extend fingerprint normalization to collapse deploy-varying tokens (host, content-hashes, and the coordinates of hashed bundle frames) in the message *and* stack frames. New-events-only; existing groups age out via B.
- **B — Auto-resolve (Node/worker):** a periodic sweep that resolves stuck-open issues (`needs_human` / `investigated`) after `RESOLVE_AGE_DAYS` (default 14) of no new events, independent of any fix.
- **C — Release-aware regression (Go/ingestion + migration):** record the release an issue was resolved in (`resolved_in_release`); on recurrence, reopen only if the incoming `release` is that release *or newer* (ordered by first-seen time) **and both releases are known**. Reasons that are permanently unfixable never reopen.

**Tech Stack:** Go 1.24 (chi, pgx) for ingestion; Node 22 / TypeScript (Vitest) for worker; Postgres (append-only SQL migrations, next number `009`).

**Terminology (industry-aligned — see research):** `regression`/`regressed` (not "reopen/requeue/reactivate"), `resolved_in_release` (Rollbar/Sentry), `resolve_age` / auto-resolve (Sentry/Rollbar), `resolved_reason ∈ {auto_resolved, merged, manual}` (Sentry `SET_RESOLVED_BY_AGE`). Reopen-if-`>=`-resolved-version matches Rollbar/Raygun exactly.

**Out of scope (deliberately deferred):** merging existing split groups (new-events-only); `occurrence_count → times_seen` rename; a lifecycle/activity audit table; the mute-until-escalating substatus model.

---

## Decisions locked (revised after review 2026-07-16)

| # | Decision |
|---|---|
| A1 | New-events-only. No re-fingerprint/merge of existing groups. |
| A2 | Collapse deploy-varying tokens, but only in recognized URL/asset contexts: strip scheme+host; collapse a filename hash token **only when it looks like a hash** (length ≥ 8 **and** contains a digit), keeping the logical name (`index-<HASH>.js`); when a hashed asset carries a query string or `:line:col`, drop those too. **No global query-string strip.** Apply to message **and** top frames. |
| A3 | Frame coordinates (`:line:col`) are stripped **only for hashed bundle frames** (build-specific noise). Non-hashed source frames keep their coordinates — avoids over-merging distinct bugs in un-minified stacks. |
| B1 | Window = `RESOLVE_AGE_DAYS`, default **14**, measured against `last_seen`. |
| B2 | Eligible statuses: **`needs_human`, `investigated`** only. Excluded: active pipeline (`new`, `queued`, `analyzing`, `fixing`); terminal (`resolved`, `merged`, `archived`); **and `pr_created`** — see B3. |
| B3 | **`pr_created` is NOT eligible** (reversed after review). `ProcessPRWebhook` matches on `status='pr_created'` (`queries.go:1165`); auto-resolving it would orphan a later close/merge webhook (no `pr_outcomes` receipt; `recoverReopenedMerge` can't recover). |
| C1 | Rank releases by **first-seen time** = `min(error_events.created_at)` per `(project_id, release)`. Uses server-recorded `created_at`, NOT the client-supplied `timestamp` (issue #27): `timestamp` is attacker/clock-controllable, and one back-dated event would pin a release's `min()` to a bogus-old value and silently suppress a real regression. **One canonical ranking query used everywhere** (gate + stamp). No `releases` table, no backfill. |
| C2 | Store `resolved_in_release` = the **newest release by first-seen** in the project at resolve time (NOT the most-recent event's release). Reopen unless incoming release is **strictly older** than `resolved_in_release`. |
| C2a | **Release-absent policy:** gating applies **only when both the incoming release and `resolved_in_release` are non-empty**. If either is missing, fall back to current behaviour (reopen on any recurrence). Prod is 100% release-populated; release-less projects are no worse than today. |
| C3 | Permanence is defined **per reason code, not by prefix**. Add to the never-reopen set: `unfixable_infra`, `unfixable_third_party`, `unfixable_test_error`. **Do NOT** add `unfixable_no_sourcemap` (remediation says "upload source maps then retry" → must stay reopenable). Keep the existing set unchanged. |
| C4 | No new `regressed` enum state; reuse the existing requeue→`queued` path, now gated. Requeue must also clear `resolved_reason` and `resolved_in_release`. |
| Idx | Index `error_events(project_id, release, created_at)` for the ranking `min()`; partial index `error_groups(last_seen) WHERE status IN ('needs_human','investigated')` for the sweep. |
| Audit | Minimal: two new columns (`resolved_in_release`, `resolved_reason`). No history table. |

### Canonical release-ranking (single source of truth)

Every path that needs "newest release" or "is X older than Y" uses these two, both
served by `idx_error_events_project_release_created`. First-seen is `min(created_at)`
(server arrival), never the client-supplied `timestamp`:

```sql
-- Newest release in a project = the release whose FIRST event arrived most recently.
SELECT release FROM error_events
WHERE project_id = $1 AND release IS NOT NULL AND release <> ''
GROUP BY release ORDER BY min(created_at) DESC LIMIT 1;

-- First-seen of a specific release (for older/newer comparison).
SELECT min(created_at) FROM error_events
WHERE project_id = $1 AND release = $2;
```

---

## Workstream A — Grouping normalization (Go / ingestion)

Isolated to `packages/ingestion/grouping/`. No schema, no worker changes. Verify with `cd packages/ingestion && go test ./grouping`.

### Task A1: Failing tests — collapse hashes, but do NOT over-merge

**Files:**
- Test: `packages/ingestion/grouping/fingerprint_test.go` (create or extend)

**Step 1: Write failing tests (positive AND negative cases)**

```go
package grouping

import "testing"

// POSITIVE: same error, different per-deploy chunk hash -> one fingerprint.
func TestFingerprint_CollapsesContentHash(t *testing.T) {
	a := Fingerprint("TypeError", "Failed to fetch dynamically imported module: https://app.example.com/assets/index-DbQ2xY9p.js", "")
	b := Fingerprint("TypeError", "Failed to fetch dynamically imported module: https://app.example.com/assets/index-Zz88Aa10.js", "")
	if a != b {
		t.Fatalf("expected same fingerprint across deploy hashes, got %s vs %s", a, b)
	}
}

// POSITIVE: absolute vs relative URL of the same chunk -> one fingerprint.
func TestFingerprint_StripsHost(t *testing.T) {
	a := Fingerprint("Error", "Unable to preload CSS for https://app.example.com/assets/main-AbC12345.css", "")
	b := Fingerprint("Error", "Unable to preload CSS for /assets/main-Zx9Yq077.css", "")
	if a != b {
		t.Fatalf("expected host-independent fingerprint, got %s vs %s", a, b)
	}
}

// NEGATIVE: different logical modules stay distinct (no over-merge).
func TestFingerprint_KeepsLogicalName(t *testing.T) {
	idx := Fingerprint("TypeError", "Failed to fetch dynamically imported module: /assets/index-AbC12345.js", "")
	vnd := Fingerprint("TypeError", "Failed to fetch dynamically imported module: /assets/vendor-AbC12345.js", "")
	if idx == vnd {
		t.Fatalf("expected index and vendor to stay distinct")
	}
}

// NEGATIVE: ordinary hyphenated filenames are NOT hashes -> must stay distinct.
// "widget"/"button" are 6 letters, no digit: must not be collapsed.
func TestFingerprint_DoesNotCollapseOrdinaryNames(t *testing.T) {
	a := Fingerprint("TypeError", "Failed to import /assets/checkout-widget.js", "")
	b := Fingerprint("TypeError", "Failed to import /assets/checkout-button.js", "")
	if a == b {
		t.Fatalf("expected checkout-widget and checkout-button to stay distinct")
	}
}

// NEGATIVE: a '?' in ordinary prose must not be treated as a URL query.
func TestFingerprint_DoesNotManglePlainText(t *testing.T) {
	a := Fingerprint("Error", "Is the value correct? yes it was 5", "")
	b := Fingerprint("Error", "Is the value correct? no it was 9", "")
	// Differs only by the numbers, which reNum already collapses -> equal is fine.
	// The point: normalization must not throw an error or delete the words after '?'.
	if a != b {
		t.Fatalf("plain-text prose should normalize by numbers only; got %s vs %s", a, b)
	}
}

// POSITIVE: hashed bundle FRAMES with differing hash AND coordinates -> one fingerprint.
func TestFingerprint_NormalizesHashedFrameCoords(t *testing.T) {
	s1 := "at load (https://app.example.com/assets/index-DbQ2xY9p.js:1:100)\nat run (/assets/app-Abc12345.js:2:5)"
	s2 := "at load (https://app.example.com/assets/index-Zz88Aa10.js:9:842)\nat run (/assets/app-Zzz99999.js:7:311)"
	if Fingerprint("TypeError", "boom", s1) != Fingerprint("TypeError", "boom", s2) {
		t.Fatalf("expected hashed frame hash+coords to be normalized")
	}
}

// NEGATIVE: non-hashed source frames KEEP their coordinates (distinct bugs, same file).
func TestFingerprint_KeepsNonHashedFrameCoords(t *testing.T) {
	s1 := "at a (/src/app.js:42:1)"
	s2 := "at a (/src/app.js:99:1)"
	if Fingerprint("TypeError", "boom", s1) == Fingerprint("TypeError", "boom", s2) {
		t.Fatalf("expected non-hashed frames to keep line/col granularity")
	}
}
```

**Step 2: Run to verify they fail**

Run: `cd packages/ingestion && go test ./grouping -run TestFingerprint -v`
Expected: FAIL.

**Step 3: Commit failing tests**

```bash
git add packages/ingestion/grouping/fingerprint_test.go
git commit -m "test(grouping): hash-collapse with over-merge negatives (RED)"
```

### Task A2: Implement context-scoped, hash-aware normalization

**Files:**
- Modify: `packages/ingestion/grouping/fingerprint.go`

**Step 1: Add regexps + helpers**

```go
var (
	// scheme + host, e.g. https://app.example.com -> "" (keeps the path)
	reURL = regexp.MustCompile(`https?://[^/\s]+`)

	// A hashed asset token: name-HASH.ext with optional ?query and :line:col.
	//   group 1 = logical name, 2 = hash token, 3 = ext, 4 = query, 5 = coords
	// The hash-likeness of group 2 is checked in code (looksLikeHash), not the regex,
	// so ordinary names like "checkout-widget" are left alone.
	reAssetToken = regexp.MustCompile(
		`([A-Za-z0-9_.]+)-([A-Za-z0-9_]+)\.(js|mjs|cjs|css|map)(\?[^\s:'")]*)?(:\d+:\d+)?`)
)

// looksLikeHash: content hashes are long and mix letters with digits.
// "widget"/"button" (letters only) and short tokens are rejected.
func looksLikeHash(s string) bool {
	if len(s) < 8 {
		return false
	}
	for _, r := range s {
		if r >= '0' && r <= '9' {
			return true
		}
	}
	return false
}
```

**Step 2: Add the shared normalizer (message + frames)**

```go
// normalizeVolatile removes deploy-varying tokens that would fragment one error
// into many groups: URL host, and — only for hash-named bundle assets — the hash,
// any query string, and the :line:col coordinates. Ordinary text is untouched.
func normalizeVolatile(s string) string {
	s = reURL.ReplaceAllString(s, "") // drop scheme+host, keep path
	s = reAssetToken.ReplaceAllStringFunc(s, func(m string) string {
		sub := reAssetToken.FindStringSubmatch(m)
		if looksLikeHash(sub[2]) {
			return sub[1] + "-<HASH>." + sub[3] // drop hash(2), query(4), coords(5)
		}
		return m // ordinary filename: leave as-is
	})
	return s
}
```

**Step 3: Wire into `normalizeMessage` and `topFrames`**

`normalizeMessage` — run `normalizeVolatile` first, then the existing rules (`reAssetToken` protects `<HASH>` from `reNum`):

```go
func normalizeMessage(msg string) string {
	result := normalizeVolatile(msg)
	result = reHex.ReplaceAllString(result, "0xN")
	result = reUUID.ReplaceAllString(result, "<UUID>")
	result = rePathNum.ReplaceAllString(result, "/N")
	result = reNum.ReplaceAllString(result, "N")
	result = reQuoted.ReplaceAllString(result, `"..."`)
	result = reSpaces.ReplaceAllString(result, " ")
	return strings.ToLower(strings.TrimSpace(result))
}
```

`topFrames` — normalize each retained frame line:

```go
func topFrames(stack string, n int) []string {
	lines := strings.Split(stack, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	for i, l := range lines {
		lines[i] = normalizeVolatile(l)
	}
	return lines
}
```

**Step 4: Run tests, then build**

Run: `cd packages/ingestion && go test ./grouping -run TestFingerprint -v && go build ./...`
Expected: PASS (all cases, positive and negative).

**Step 5: Commit**

```bash
git add packages/ingestion/grouping/fingerprint.go
git commit -m "feat(grouping): context-scoped hash-aware fingerprint normalization (GREEN)"
```

---

## Workstream C — Schema + release-aware regression (Go / ingestion)

Do C before B: B writes the new columns the migration adds.

### Task C1: Migration 009 — columns + both indexes

**Files:**
- Create: `packages/ingestion/db/migrations/009_regression_lifecycle.sql`

**Step 1: Write the migration (idempotent, guarded)**

```sql
-- 009_regression_lifecycle.sql
-- Release-aware regression + resolution provenance. Append-only; safe to reapply.

ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS resolved_in_release TEXT;
-- Why an issue is in resolved: 'auto_resolved' (inactivity), 'merged' (fix), 'manual'.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS resolved_reason TEXT;

-- Serves the canonical release-ranking min(created_at) grouped by release.
CREATE INDEX IF NOT EXISTS idx_error_events_project_release_created
  ON error_events(project_id, release, created_at);

-- Serves the 15-minute inactivity sweep without a full-table scan.
CREATE INDEX IF NOT EXISTS idx_error_groups_inactivity
  ON error_groups(last_seen)
  WHERE status IN ('needs_human', 'investigated');
```

**Step 2: Apply to a disposable clean DB and reapply for idempotency**

> Use a throwaway DB — never the shared 5434 (see repo hazard notes).
```bash
cd packages/ingestion
psql "$DISPOSABLE_DB_URL" -f db/migrations/009_regression_lifecycle.sql
psql "$DISPOSABLE_DB_URL" -f db/migrations/009_regression_lifecycle.sql   # must be a no-op
```
Expected: both runs succeed.

**Step 3: Commit**

```bash
git add packages/ingestion/db/migrations/009_regression_lifecycle.sql
git commit -m "feat(db): resolved_in_release, resolved_reason, ranking + sweep indexes (009)"
```

### Task C2: Release-order gate + per-code permanence + provenance clear

**Files:**
- Modify: `packages/ingestion/db/queries.go` (`nonRetriableReasonCodes` ~185; `isRequeueEligible` ~216; requeue block ~467–509)
- Test: `packages/ingestion/db/regression_test.go` (create; model on `client_timestamp_test.go`)

**Step 1: Write failing tests — cover every branch**

Assert, with a seeded release history:
- resolved group + recurrence from a **strictly older** release → `Requeued == false`, status stays `resolved`.
- resolved group + recurrence from the **same** release → `Requeued == true` (same build re-erroring is real).
- resolved group + recurrence from a **newer** release → `Requeued == true`, status `queued`.
- **release absent** on the incoming event (empty) → `Requeued == true` (fallback), per C2a.
- **`resolved_in_release` empty** → `Requeued == true` (fallback), per C2a.
- resolved group whose `reason_code == 'unfixable_infra'` + newer release → `Requeued == false`.
- resolved group whose `reason_code == 'unfixable_no_sourcemap'` + newer release → `Requeued == true` (remediable).
- after a requeue, `resolved_reason IS NULL` and `resolved_in_release IS NULL`.
- **Table-driven test over the full reason-code catalog** asserting each code's permanence matches the map (guards against drift when a code is added).

Run: `cd packages/ingestion && go test ./db -run TestRegression -v`
Expected: FAIL. Commit RED.

**Step 2: Per-code permanence (NOT prefix-based)**

Add only the truly-permanent unfixables; leave `unfixable_no_sourcemap` reopenable:

```go
var nonRetriableReasonCodes = map[string]struct{}{
	// existing
	"policy_blocked":          {},
	"auth_invalid":            {},
	"unfixable_no_app_frames": {},
	"triage_unfixable":        {},
	"low_confidence_fix":      {},
	"tests_failed":            {},
	// added: permanently not app-fixable (per reason-codes.ts semantics)
	"unfixable_infra":       {}, // infra/network, not application code
	"unfixable_third_party": {}, // originates entirely in third-party code
	"unfixable_test_error":  {}, // deliberate test error; no fix needed
	// NOTE: unfixable_no_sourcemap is intentionally NOT here — remediable by
	// uploading source maps and retrying, so a newer release should reopen it.
}
```

`isRequeueEligible` — block known-unfixable regardless of status (so inactivity-resolved unfixables don't reopen):

```go
func isRequeueEligible(groupStatus string, reasonCode *string) bool {
	if _, ok := requeueStatuses[groupStatus]; !ok {
		return false
	}
	if reasonCode != nil {
		if _, nonRetriable := nonRetriableReasonCodes[*reasonCode]; nonRetriable {
			return false
		}
	}
	return true
}
```

**Step 3: Release-order helper (canonical ranking, both-known-only)**

```go
// releaseNotOlder reports whether candidate is the resolved release or newer,
// ranked by first-seen time. Per C2a, gating only applies when BOTH releases are
// known; an empty side returns true (fall back to reopen-on-recurrence).
func (q *Queries) releaseNotOlder(ctx context.Context, tx pgx.Tx, projectID, candidate, resolvedRelease string) (bool, error) {
	if candidate == "" || resolvedRelease == "" || candidate == resolvedRelease {
		return true, nil
	}
	const sql = `
		SELECT
			(SELECT min(created_at) FROM error_events WHERE project_id = $1 AND release = $2) AS cand,
			(SELECT min(created_at) FROM error_events WHERE project_id = $1 AND release = $3) AS resolved`
	var cand, resolved *time.Time
	if err := tx.QueryRow(ctx, sql, projectID, candidate, resolvedRelease).Scan(&cand, &resolved); err != nil {
		return true, err // conservative fallback
	}
	if cand == nil || resolved == nil {
		return true, nil // unknown first-seen -> reopen
	}
	return !cand.Before(*resolved), nil
}
```

**Step 4: Gate the requeue path + clear provenance**

In the requeue block (`queries.go:467`), extend the group read to include `resolved_in_release`, gate the reopen, and clear the new columns on requeue:

```go
var groupStatus, resolvedInRelease string
var reasonCode *string
err = tx.QueryRow(ctx,
	`SELECT status, reason_code, COALESCE(resolved_in_release, '')
	   FROM error_groups WHERE id = $1 AND project_id = $2`,
	groupID, p.ProjectID,
).Scan(&groupStatus, &reasonCode, &resolvedInRelease)
// ...
eligible := isRequeueEligible(groupStatus, reasonCode)
if eligible && (groupStatus == "resolved" || groupStatus == "merged") {
	notOlder, err := q.releaseNotOlder(ctx, tx, p.ProjectID, p.Release, resolvedInRelease)
	if err != nil {
		return nil, fmt.Errorf("release-order check: %w", err)
	}
	eligible = notOlder
}
if eligible {
	// ... existing job insert ...
	_, err = tx.Exec(ctx,
		`UPDATE error_groups
		 SET status = 'queued',
		     reason_code = NULL, reason_message = NULL, remediation = NULL,
		     root_cause = NULL, suggested_mitigation = NULL,
		     merged_at = NULL, resolved_at = NULL, archived_at = NULL,
		     resolved_in_release = NULL, resolved_reason = NULL,   -- NEW: clear provenance
		     updated_at = now()
		 WHERE id = $1`,
		groupID,
	)
	// ...
	requeued = true
}
```

**Step 5: Run tests to pass, then build**

Run: `cd packages/ingestion && go test ./db -run TestRegression -v && go build ./...`
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/db/regression_test.go
git commit -m "feat(regression): release-order gate, per-code permanence, provenance clear"
```

### Task C3: Stamp provenance on manual resolve (canonical newest release)

**Files:**
- Modify: `packages/ingestion/db/queries.go:1312` (`ResolveErrorGroup`)

**Step 1: Use the canonical newest-by-first-seen ranking (NOT most-recent event)**

```sql
UPDATE error_groups
SET status = 'resolved',
    resolved_at = now(),
    resolved_reason = 'manual',
    resolved_in_release = (
      SELECT release FROM error_events
      WHERE project_id = $1 AND release IS NOT NULL AND release <> ''
      GROUP BY release ORDER BY min(created_at) DESC LIMIT 1
    ),
    updated_at = now()
WHERE id = $2 AND project_id = $1 AND status <> 'archived'
```

**Step 2: Build + existing resolve tests, then commit**

Run: `cd packages/ingestion && go test ./db && go build ./...`
```bash
git add packages/ingestion/db/queries.go
git commit -m "feat(resolve): stamp resolved_reason=manual + newest resolved_in_release"
```

---

## Workstream B — Auto-resolve on inactivity (Node / worker)

Depends on migration 009. Verify with `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`.

### Task B1: Failing test for the inactivity sweep

**Files:**
- Test: `packages/worker/src/__tests__/resolveInactiveGroups.test.ts` (create)

**Step 1: Write failing tests**

Assert `resolveInactiveGroups(14)`:
- Resolves a `needs_human` group with `last_seen` 20 days ago → `resolved`, `resolved_reason='auto_resolved'`, `resolved_in_release` set to the newest release.
- Resolves an `investigated` group the same way.
- **Does NOT touch `pr_created`** (excluded — B3).
- Does not touch a group last seen 3 days ago.
- Does not touch `analyzing`/`queued`/`fixing`/`archived`/already-`resolved`.

Run: `pnpm --filter @opslane/worker test -- resolveInactiveGroups`
Expected: FAIL. Commit RED.

### Task B2: Implement the sweep

**Files:**
- Modify: `packages/worker/src/db.ts` (beside `resolveSilentMergedGroups` ~516)

```ts
/**
 * System-level background query: auto-resolves stuck-open issues not seen in
 * `ageDays` days, independent of any fix (Sentry/Rollbar inactivity auto-resolve).
 * pr_created is intentionally excluded — ProcessPRWebhook matches status='pr_created',
 * so auto-resolving it would orphan a later PR close/merge. Not tenant-scoped.
 */
export async function resolveInactiveGroups(ageDays: number): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE error_groups g
     SET status = 'resolved',
         resolved_at = now(),
         resolved_reason = 'auto_resolved',
         resolved_in_release = (
           SELECT release FROM error_events
           WHERE project_id = g.project_id AND release IS NOT NULL AND release <> ''
           GROUP BY release ORDER BY min(created_at) DESC LIMIT 1
         ),
         updated_at = now()
     WHERE g.status IN ('needs_human', 'investigated')
       AND g.last_seen < now() - ($1 || ' days')::interval
     RETURNING g.id`,
    [String(ageDays)]
  );
  return result.rows.map(r => r.id);
}
```

Run: `pnpm --filter @opslane/worker test -- resolveInactiveGroups` → PASS. Commit GREEN.

### Task B3: Schedule the sweep + config

**Files:**
- Modify: `packages/worker/src/index.ts` (config ~80; timers ~938–965)

```ts
const RESOLVE_AGE_DAYS = Number(process.env.RESOLVE_AGE_DAYS ?? 14);
const INACTIVITY_CHECK_INTERVAL_MS = Number(process.env.INACTIVITY_CHECK_INTERVAL_MS ?? 15 * 60 * 1000);

const inactivityTimer = setInterval(async () => {
  try {
    const ids = await resolveInactiveGroups(RESOLVE_AGE_DAYS);
    if (ids.length) log.info({ count: ids.length, ageDays: RESOLVE_AGE_DAYS }, 'auto-resolved inactive groups');
  } catch (err) {
    log.error({ err }, 'inactivity auto-resolve sweep failed');
  }
}, INACTIVITY_CHECK_INTERVAL_MS);
```

Add `clearInterval(inactivityTimer);` beside `clearInterval(silenceTimer);` in shutdown (~965).

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` → PASS. Commit.

### Task B4: Stamp provenance on the merged-silence path

**Files:**
- Modify: `packages/worker/src/db.ts:516` (`resolveSilentMergedGroups`)

Add to its existing UPDATE: `resolved_reason = 'merged'` and `resolved_in_release =` (the same canonical newest-release subquery as B2), so all three resolve paths populate the new columns consistently.

Run: `pnpm --filter @opslane/worker test` → PASS. Commit.

---

## Final verification (whole change)

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Live smoke (pipeline touched):** apply migrations incl. 009 to a disposable DB, seed `scripts/seed-e2e.sql`, rebuild ingestion + worker, then:
1. Send an event → new group.
2. Send the same error with a different chunk hash **and different `:line:col`** in a bundle-frame URL → **same group** (A: `occurrence_count` increments).
3. Send `checkout-widget.js` and `checkout-button.js` errors → **two groups** (A: no over-merge).
4. Manually resolve a group; send a recurrence with an **older** `release` → stays resolved; with a **newer** `release` → `queued` (C). Send one with **no** `release` → `queued` (C2a fallback).
5. Set a group's `last_seen` back 15 days → after the sweep it becomes `resolved`, `resolved_reason='auto_resolved'` (B). Confirm a `pr_created` group is untouched.

---

## Rollout notes

- **A** takes effect for new events immediately; existing split groups are cleaned up by **B** as they age past 14 days.
- **B** on first run resolves a large backlog (~800 stale groups in current prod). Intended one-time cleanup; `resolved_reason='auto_resolved'` makes it auditable and reversible via C on genuine (newer-release) recurrence.
- **C3 changes existing `needs_human` recurrence behaviour** for `unfixable_infra` / `unfixable_third_party` / `unfixable_test_error` (they stop re-investigating). `unfixable_no_sourcemap` intentionally still reopens. Confirm before shipping.
- **C2a:** projects that don't send `release` get no regression gating (same as today). Only affects release-less projects; prod sends release on 100% of events.
```
