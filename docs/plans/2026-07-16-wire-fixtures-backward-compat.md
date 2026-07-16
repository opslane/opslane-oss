# SDK↔Event-API Backward-Compatibility Gate — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Pin the `POST /api/v1/events` wire contract from both ends so old SDKs keep working against new servers forever, enforced in CI.

**Architecture:** Freeze the exact JSON the SDK emits as immutable, per-SDK-version fixtures under `test-fixtures/wire/events/`. Replay every fixture against ingestion in a Go test (asserting `202` + full field round-trip + stable grouping), assert the SDK still emits the current fixture pair through its *real transport path* in a vitest test, and guard the fixtures with a trusted-base `pull_request_target` workflow so a frozen fixture can only change as a deliberate, labeled human act — and the guard itself can't be weakened in the same PR.

**Tech Stack:** Go 1.24 (chi, pgx, `httptest`), TypeScript SDK (vitest, `node --test`), Node ESM check script (`node:` builtins), GitHub Actions.

**Design doc:** `docs/plans/2026-07-16-wire-fixtures-backward-compat-design.md`

## Verified facts this plan relies on

- Ingestion decoder `packages/ingestion/handler/error_event.go:56-74` uses plain `json.Unmarshal` (no `DisallowUnknownFields`) → unknown fields already tolerated. Response is `202` with `{event_id, group_id, error_group_id}` (`:177-184`). `sdk_version` is decoded (`:65`) but **never persisted** — assert acceptance only, not DB round-trip.
- `error_events` columns (`db/migrations/001_baseline.sql`): `id, project_id, environment_id, error_group_id, "timestamp", error_type, error_message, stack_trace_raw, breadcrumbs (jsonb), context (jsonb), session_id, release, end_user_id (uuid fk → end_users)`. Client timestamp is persisted verbatim (`TestIngestEvent_PersistsClientTimestamp`). Benign values survive server redaction unchanged (`TestIngest_RedactsBreadcrumbsAndContextBeforePersist` preserves end-user email).
- `end_users` columns: `external_user_id, external_account_id, account_name, email, display_name` (unique on `project_id, external_user_id`). Handler maps `EndUserID→external_user_id, EndUserEmail→email, EndUserAccountID→external_account_id, EndUserAccountName→account_name`.
- Go test helpers in `packages/ingestion/handler/error_event_test.go`: `testDeps(t)` (`:25`, skips without `DATABASE_URL`), `seedTenant(t,q)` (`:46`), in-process drive via `httptest.NewRecorder` + `handler.NewRouter(deps).ServeHTTP` (`:143-144`).
- SDK real wire path: `enqueueEvent` (`transport.ts:48`) samples, throttles, `scrubEvent`s, runs `beforeSend`, queues; `flushEvents` (`:91`) late-binds `getCurrentUser()` into `context.user`, then `JSON.stringify`s and POSTs (`:110-126`). Testing `buildPayload` alone skips scrub/beforeSend/late-bind — capture the mocked `fetch` body instead.
- SDK internals: `buildPayload` (`core.ts:62-94`) always `addBreadcrumb`s the passed crumb; `maxBreadcrumbs: 0` evicts it so `breadcrumbs: []` is reachable (`breadcrumbs.ts:33-44`); `release`/`session_id` are returned as `undefined` keys and dropped by `JSON.stringify`. `getSessionId()` returns `''` when state is null but `clearUser()` *creates* a session — so the minimal (no-`session_id`) shape requires `resetSessionId()` after `clearUser()` (`session.ts:106-108,146-157`). `shouldThrottle` returns `false` when `windowMs <= 0` (`throttle.ts:13`), so `errorThrottleMs: 0` disables throttling. `scrubEvent` is a no-op on benign values (no query strings, no secret patterns; `context.user` untouched) (`scrub.ts:62-81`).
- Exports available: `buildPayload, setUser, clearUser` (`core.ts`), `loadConfig` (`config.ts`), `clearBreadcrumbs` (`breadcrumbs.ts`), `resetSessionId, ensureSessionID` (`session.ts`), `enqueueEvent, flushEvents, _resetQueue` (`transport.ts`), `_resetThrottle` (`throttle.ts`), `SDK_VERSION` (`version.ts`).
- Existing check-script pattern: `scripts/check-action-pins.mjs`. The `checkout` SHA pin used across CI is `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0` (`ci.yml:58`).
- A GitHub job's *required-status-check context* is the job's `name` (falls back to job id when unset). Set `name: wire-fixtures` so the context is stable.

**Working directory:** repo root unless a step says otherwise. Branch is already `abhishekray07/ci-enforce-sdk-event-api-backward-compatibility`.

**Database note:** run the Go tests against a *disposable* Postgres (repo memory: port 5434 is shared across worktree sessions — do not assume a clean DB). Apply migrations first: from `packages/ingestion`, `MIGRATION_DIR=db/migrations ../../scripts/run-migrations.sh` with `DATABASE_URL` pointed at the disposable DB.

---

## Task 1: Frozen wire fixtures + README

The shared input for Tasks 2 and 5. Values are benign so both SDK-side (`scrubEvent`) and server-side redaction are no-ops and the JSON round-trips cleanly.

**Files:**
- Create: `test-fixtures/wire/events/v1.0.0-minimal.json`
- Create: `test-fixtures/wire/events/v1.0.0-full.json`
- Create: `test-fixtures/wire/events/README.md`

**Step 1: Create the minimal fixture**

`test-fixtures/wire/events/v1.0.0-minimal.json`:

```json
{
  "timestamp": "2026-07-16T00:00:00.000Z",
  "error": {
    "type": "TypeError",
    "message": "Cannot read properties of null (reading 'name')",
    "stack": "TypeError: Cannot read properties of null (reading 'name')\n    at UserCard (https://app.example.com/assets/index.js:8:20)"
  },
  "breadcrumbs": [],
  "context": {
    "url": "https://app.example.com/dashboard",
    "user_agent": "Mozilla/5.0"
  },
  "sdk_version": "1.0.0"
}
```

**Step 2: Create the full fixture**

`test-fixtures/wire/events/v1.0.0-full.json`:

```json
{
  "timestamp": "2026-07-16T00:00:00.000Z",
  "error": {
    "type": "TypeError",
    "message": "Cannot read properties of null (reading 'name')",
    "stack": "TypeError: Cannot read properties of null (reading 'name')\n    at UserCard (https://app.example.com/assets/index.js:8:20)"
  },
  "breadcrumbs": [
    {
      "type": "navigation",
      "timestamp": "2026-07-16T00:00:00.000Z",
      "category": "navigation",
      "message": "https://app.example.com/dashboard"
    }
  ],
  "context": {
    "url": "https://app.example.com/dashboard",
    "user_agent": "Mozilla/5.0",
    "user": {
      "id": "user-123",
      "email": "jane@example.com",
      "account_id": "acct-42",
      "account_name": "Example Inc"
    }
  },
  "sdk_version": "1.0.0",
  "release": "web@2026.07.16",
  "session_id": "sess-abc"
}
```

**Step 3: Create the README**

`test-fixtures/wire/events/README.md`:

```markdown
# Frozen event wire fixtures

Each file is the exact JSON body an `@opslane/shared` `ErrorEventPayload` reaches
the wire as, for one released SDK payload shape. They lock the
`POST /api/v1/events` contract in both directions:

- **Ingestion** (`packages/ingestion/handler/wire_compat_test.go`) replays *every*
  file here and asserts the server still accepts and stores it.
- **SDK** (`packages/sdk/src/__tests__/wire-shape.test.ts`) asserts the SDK still
  emits the *current* version's pair through its real transport path.

## Rule: append-only

**Never edit or delete an existing file.** Add optional fields by adding a *new*
`v<version>-*.json` pair and keeping the field optional server-side; old fixtures
must still pass. A modify/delete is a contract break and fails the `wire-fixtures`
CI check unless the PR carries the `contract-change` label (a deliberate,
reviewed break). See `docs/contracts/events.md`.

## How each file was produced

- `v1.0.0-minimal.json` — SDK configured `maxBreadcrumbs: 0`, no user, no session,
  no `release`. `release`/`session_id` keys are absent because the SDK drops
  `undefined` keys at serialize.
- `v1.0.0-full.json` — user set, `release` set, session established, one
  navigation breadcrumb.

Values are benign so SDK and server redaction are no-ops. `sdk_version` is on the
wire and accepted by the server but not persisted.
```

**Step 4: Verify JSON is valid**

Run: `node -e "for (const f of ['minimal','full']) JSON.parse(require('fs').readFileSync('test-fixtures/wire/events/v1.0.0-'+f+'.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

**Step 5: Commit**

```bash
git add test-fixtures/wire/events/
git commit -m "test: freeze v1.0.0 event wire fixtures (append-only)"
```

---

## Task 2: Ingestion backward-compat Go test

Replay every fixture; assert `202`, **full** field round-trip (timestamp, error fields, release, session_id, semantic breadcrumbs + context, both group aliases, all user fields), stable grouping, and unknown-field tolerance.

**Files:**
- Create: `packages/ingestion/handler/wire_compat_test.go`

**Step 1: Write the test file**

`packages/ingestion/handler/wire_compat_test.go`:

```go
package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

// wireFixtureDir is the frozen-fixture dir relative to this package
// (packages/ingestion/handler -> repo root is ../../..).
const wireFixtureDir = "../../../test-fixtures/wire/events"

type wireFixture struct {
	Timestamp string `json:"timestamp"`
	Error     struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		Stack   string `json:"stack"`
	} `json:"error"`
	Breadcrumbs json.RawMessage `json:"breadcrumbs"`
	Context     json.RawMessage `json:"context"`
	SDKVersion  string          `json:"sdk_version"`
	Release     string          `json:"release"`
	SessionID   string          `json:"session_id"`
	ContextUser *struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		AccountID   string `json:"account_id"`
		AccountName string `json:"account_name"`
	} `json:"-"`
}

func fixturePaths(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(wireFixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}
	var paths []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			paths = append(paths, filepath.Join(wireFixtureDir, e.Name()))
		}
	}
	if len(paths) == 0 {
		t.Fatalf("no wire fixtures found in %s", wireFixtureDir)
	}
	return paths
}

func readFixture(t *testing.T, path string) ([]byte, wireFixture) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fx wireFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	// Pull context.user separately (it lives under context).
	var ctxObj struct {
		User *struct {
			ID          string `json:"id"`
			Email       string `json:"email"`
			AccountID   string `json:"account_id"`
			AccountName string `json:"account_name"`
		} `json:"user"`
	}
	_ = json.Unmarshal(fx.Context, &ctxObj)
	if ctxObj.User != nil {
		fx.ContextUser = ctxObj.User
	}
	return raw, fx
}

func postFixture(t *testing.T, deps *handler.Dependencies, rawKey string, body []byte) map[string]string {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/v1/events", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", rawKey)
	w := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d (%s)", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}

// semanticJSONEqual compares stored JSONB text against expected raw JSON,
// ignoring key order and whitespace (Postgres reserializes JSONB).
func semanticJSONEqual(t *testing.T, label, gotText string, want json.RawMessage) {
	t.Helper()
	if len(want) == 0 {
		return
	}
	var got, exp any
	if err := json.Unmarshal([]byte(gotText), &got); err != nil {
		t.Fatalf("%s: unmarshal stored: %v", label, err)
	}
	if err := json.Unmarshal(want, &exp); err != nil {
		t.Fatalf("%s: unmarshal fixture: %v", label, err)
	}
	if !reflect.DeepEqual(got, exp) {
		t.Errorf("%s mismatch:\n stored=%s\n fixture=%s", label, gotText, string(want))
	}
}

// TestWireFixtures_AcceptedAndStored replays every frozen fixture and asserts the
// full contract round-trips. sdk_version is accepted (implicit in the 202) but is
// not persisted by ingestion, so it is intentionally not asserted against the DB.
func TestWireFixtures_AcceptedAndStored(t *testing.T) {
	deps, pool := testDeps(t)

	for _, path := range fixturePaths(t) {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			_, _, _, rawKey := seedTenant(t, deps.Queries)
			raw, fx := readFixture(t, path)

			resp := postFixture(t, deps, rawKey, raw)
			eventID := resp["event_id"]
			if eventID == "" || resp["group_id"] == "" {
				t.Fatalf("missing ids in response: %v", resp)
			}
			// Both response aliases must be present and equal.
			if resp["error_group_id"] != resp["group_id"] {
				t.Errorf("error_group_id %q != group_id %q", resp["error_group_id"], resp["group_id"])
			}

			var (
				ts                                          time.Time
				errType, errMsg, stack, release, sessionID  string
				bcText, ctxText, groupID                    string
				endUserID                                   *string
			)
			if err := pool.QueryRow(context.Background(), `
				SELECT "timestamp", error_type, error_message, stack_trace_raw,
				       COALESCE(release,''), COALESCE(session_id,''),
				       breadcrumbs::text, context::text,
				       error_group_id::text, end_user_id::text
				FROM error_events WHERE id = $1`, eventID).
				Scan(&ts, &errType, &errMsg, &stack, &release, &sessionID, &bcText, &ctxText, &groupID, &endUserID); err != nil {
				t.Fatalf("query stored event: %v", err)
			}

			// Timestamp round-trip (client-supplied, persisted verbatim).
			wantTS, err := time.Parse(time.RFC3339, fx.Timestamp)
			if err != nil {
				t.Fatalf("parse fixture timestamp: %v", err)
			}
			if !ts.Equal(wantTS) {
				t.Errorf("timestamp = %v, want %v", ts, wantTS)
			}
			// Scalar error fields (empty type defaults to "Error").
			wantType := fx.Error.Type
			if wantType == "" {
				wantType = "Error"
			}
			if errType != wantType {
				t.Errorf("error_type = %q, want %q", errType, wantType)
			}
			if errMsg != fx.Error.Message {
				t.Errorf("error_message = %q, want %q", errMsg, fx.Error.Message)
			}
			if stack != fx.Error.Stack {
				t.Errorf("stack_trace_raw = %q, want %q", stack, fx.Error.Stack)
			}
			if release != fx.Release {
				t.Errorf("release = %q, want %q", release, fx.Release)
			}
			if sessionID != fx.SessionID {
				t.Errorf("session_id = %q, want %q", sessionID, fx.SessionID)
			}
			if groupID != resp["group_id"] {
				t.Errorf("stored error_group_id %q != response group_id %q", groupID, resp["group_id"])
			}
			// Semantic JSON round-trip (benign values survive redaction).
			semanticJSONEqual(t, "breadcrumbs", bcText, fx.Breadcrumbs)
			semanticJSONEqual(t, "context", ctxText, fx.Context)

			// User extraction: all end_user fields for a fixture with context.user.
			if fx.ContextUser != nil {
				if endUserID == nil {
					t.Fatalf("expected end_user_id set for fixture with context.user")
				}
				var extID, extAcct, acctName, email string
				if err := pool.QueryRow(context.Background(), `
					SELECT external_user_id, COALESCE(external_account_id,''),
					       COALESCE(account_name,''), COALESCE(email,'')
					FROM end_users WHERE id = $1`, *endUserID).
					Scan(&extID, &extAcct, &acctName, &email); err != nil {
					t.Fatalf("query end_user: %v", err)
				}
				if extID != fx.ContextUser.ID {
					t.Errorf("external_user_id = %q, want %q", extID, fx.ContextUser.ID)
				}
				if email != fx.ContextUser.Email {
					t.Errorf("end_user email = %q, want %q", email, fx.ContextUser.Email)
				}
				if extAcct != fx.ContextUser.AccountID {
					t.Errorf("external_account_id = %q, want %q", extAcct, fx.ContextUser.AccountID)
				}
				if acctName != fx.ContextUser.AccountName {
					t.Errorf("account_name = %q, want %q", acctName, fx.ContextUser.AccountName)
				}
			}
		})
	}
}

// TestWireFixtures_StableGrouping posts the same fixture twice and asserts the
// same group is reused — proves grouping, not just storage.
func TestWireFixtures_StableGrouping(t *testing.T) {
	deps, _ := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	raw, _ := readFixture(t, filepath.Join(wireFixtureDir, "v1.0.0-full.json"))
	first := postFixture(t, deps, rawKey, raw)
	second := postFixture(t, deps, rawKey, raw)
	if first["group_id"] != second["group_id"] {
		t.Errorf("group_id drifted across identical posts: %q vs %q", first["group_id"], second["group_id"])
	}
}

// TestWireFixtures_UnknownFieldsTolerated injects unknown fields and asserts 202.
// Locks in forward-compat: nobody may add DisallowUnknownFields to /api/v1/events.
func TestWireFixtures_UnknownFieldsTolerated(t *testing.T) {
	deps, _ := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	raw, _ := readFixture(t, filepath.Join(wireFixtureDir, "v1.0.0-minimal.json"))
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	obj["future_field"] = "from a newer SDK"
	obj["error"].(map[string]any)["future_error_field"] = 123
	augmented, _ := json.Marshal(obj)

	resp := postFixture(t, deps, rawKey, augmented)
	if resp["event_id"] == "" {
		t.Errorf("unknown-field payload not stored: %v", resp)
	}
}
```

**Step 2: Run the tests (green against current server)**

Run: `cd packages/ingestion && go test ./handler -run TestWireFixtures -v`
Expected: PASS (with `DATABASE_URL` set + migrations applied). Guard tests pass against today's correct server.

**Step 3: Prove the guard bites (non-destructive sabotage)**

Back up, then make the decoder strict:

```bash
cp packages/ingestion/handler/error_event.go /tmp/error_event.go.bak
```

In `packages/ingestion/handler/error_event.go`, replace `json.Unmarshal(body, &payload)` (`:70`) with:

```go
dec := json.NewDecoder(strings.NewReader(string(body)))
dec.DisallowUnknownFields()
if err := dec.Decode(&payload); err != nil {
```

Run: `cd packages/ingestion && go test ./handler -run TestWireFixtures_UnknownFieldsTolerated -v`
Expected: FAIL (server now 400s the unknown field).

**Step 4: Restore from backup (no git ops)**

```bash
cp /tmp/error_event.go.bak packages/ingestion/handler/error_event.go && rm /tmp/error_event.go.bak
cd packages/ingestion && go test ./handler -run TestWireFixtures -v
```
Expected: PASS again.

**Step 5: Commit**

```bash
git add packages/ingestion/handler/wire_compat_test.go
git commit -m "test(ingestion): replay frozen wire fixtures (full round-trip + unknown-field tolerance)"
```

---

## Task 3: Fixture immutability check script + unit test

A `node:`-only script whose diff-parsing core is a pure, unit-tested function — so we verify it without any destructive git operations.

**Files:**
- Create: `scripts/check-wire-fixtures.mjs`
- Create: `scripts/check-wire-fixtures.test.mjs`

**Step 1: Write the script (pure parser + thin runner)**

`scripts/check-wire-fixtures.mjs`:

```js
#!/usr/bin/env node
/**
 * Enforce that frozen wire fixtures under test-fixtures/wire/ are append-only.
 * Fails if a diff modifies (M), deletes (D), or renames (R) an existing fixture.
 * Additions (A) are allowed. A `contract-change` PR label bypasses this at the
 * workflow level (.github/workflows/wire-fixtures.yml).
 *
 * Diffs BASE_SHA...HEAD_SHA (three-dot = merge base). Defaults suit local runs.
 *
 * Usage: node scripts/check-wire-fixtures.mjs
 */
import { execFileSync } from 'node:child_process';

export const GUARDED_PREFIX = 'test-fixtures/wire/';

/**
 * Pure: given `git diff --name-status` output, return human-readable violations.
 * Renaming a guarded file is a delete of the frozen path, so it fails.
 */
export function findViolations(diffOutput, guarded = GUARDED_PREFIX) {
  const problems = [];
  for (const line of diffOutput.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0]; // A, M, D, R, C
    const affected = parts.slice(1).filter((p) => p.startsWith(guarded));
    if (affected.length === 0) continue;
    if (status === 'M' || status === 'D' || status === 'R') {
      const verb = { M: 'modified', D: 'deleted', R: 'renamed' }[status];
      for (const p of affected) problems.push(`${p} was ${verb} (fixtures are append-only)`);
    }
  }
  return problems;
}

function main() {
  const base = process.env.BASE_SHA || 'origin/main';
  const head = process.env.HEAD_SHA || 'HEAD';
  let out;
  try {
    out = execFileSync('git', ['diff', '--name-status', `${base}...${head}`], { encoding: 'utf8' });
  } catch (err) {
    console.error(`Wire-fixture check could not run git diff (${base}...${head}): ${err.message}`);
    console.error('In CI ensure fetch-depth: 0 and that BASE_SHA/HEAD_SHA are set.');
    process.exit(1);
  }
  const problems = findViolations(out);
  if (problems.length > 0) {
    console.error('Wire-fixture immutability check FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    console.error('Frozen fixtures under test-fixtures/wire/ may only be ADDED, never');
    console.error('changed. If this edit is a deliberate, reviewed contract change, add');
    console.error('the `contract-change` label to the PR. See docs/contracts/events.md.');
    process.exit(1);
  }
  console.log(`Wire-fixture check OK: no modified/deleted fixtures under ${GUARDED_PREFIX}.`);
}

// Run only when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) main();
```

**Step 2: Write the unit test (no git mutation)**

`scripts/check-wire-fixtures.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations } from './check-wire-fixtures.mjs';

test('additions are allowed', () => {
  const diff = 'A\ttest-fixtures/wire/events/v1.1.0-minimal.json';
  assert.deepEqual(findViolations(diff), []);
});

test('modifying an existing fixture fails', () => {
  const diff = 'M\ttest-fixtures/wire/events/v1.0.0-minimal.json';
  assert.equal(findViolations(diff).length, 1);
  assert.match(findViolations(diff)[0], /was modified/);
});

test('deleting an existing fixture fails', () => {
  const diff = 'D\ttest-fixtures/wire/events/v1.0.0-full.json';
  assert.match(findViolations(diff)[0], /was deleted/);
});

test('renaming an existing fixture fails', () => {
  const diff = 'R100\ttest-fixtures/wire/events/v1.0.0-full.json\ttest-fixtures/wire/events/renamed.json';
  assert.match(findViolations(diff)[0], /was renamed/);
});

test('changes outside the guarded prefix are ignored', () => {
  const diff = 'M\tpackages/sdk/src/core.ts\nA\ttest-fixtures/wire/events/v1.2.0-full.json';
  assert.deepEqual(findViolations(diff), []);
});
```

**Step 3: Run the unit test**

Run: `node --test scripts/check-wire-fixtures.test.mjs`
Expected: `# pass 5`.

**Step 4: Make the script executable and smoke-run it**

Run: `chmod +x scripts/check-wire-fixtures.mjs && node scripts/check-wire-fixtures.mjs`
Expected: prints `Wire-fixture check OK: ...` (no fixture edits vs origin/main on a clean tree).

**Step 5: Commit**

```bash
git add scripts/check-wire-fixtures.mjs scripts/check-wire-fixtures.test.mjs
git commit -m "ci: add append-only wire-fixture check with unit-tested diff parser"
```

---

## Task 4: Trusted-base wire-fixtures workflow

Run the check from the **base branch** via `pull_request_target`, reading only the PR's file-change list — never checking out or executing PR code. This closes the self-bypass hole: a PR cannot weaken the workflow or the script in the same PR, because both come from the trusted base.

**Files:**
- Create: `.github/workflows/wire-fixtures.yml`

**Step 1: Write the workflow**

`.github/workflows/wire-fixtures.yml`:

```yaml
name: Wire fixtures

# SECURITY: pull_request_target runs the workflow AND scripts from the BASE
# branch (trusted). A PR therefore cannot weaken this gate by editing the
# workflow or the checker in the same PR. We only READ the PR's changed-file
# list via git metadata (diff --name-status). NEVER add a step that checks out
# or executes the PR head's working tree here — that would run untrusted code in
# this trigger's elevated context.
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read

jobs:
  wire-fixtures:
    name: wire-fixtures # required-status-check context = this name
    runs-on: ubuntu-latest
    timeout-minutes: 5
    # Skip (green) only when a human has consciously labeled a contract change.
    if: ${{ !contains(github.event.pull_request.labels.*.name, 'contract-change') }}
    steps:
      - name: Check out base branch (trusted workflow + script)
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false
          fetch-depth: 0
      - name: Fetch PR head commit (metadata only; never checked out)
        run: git fetch --no-tags origin "refs/pull/${{ github.event.pull_request.number }}/head"
      - name: Wire-fixture immutability
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: node scripts/check-wire-fixtures.mjs
```

**Step 2: Lint the workflow locally**

Run: `node scripts/check-action-pins.mjs`
Expected: `Action-pin check OK` (the new `checkout` is SHA-pinned).

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/wire-fixtures.yml','utf8'); for (const s of ['pull_request_target','labeled','contract-change','name: wire-fixtures']) if(!y.includes(s)) throw new Error('missing '+s); if(/checkout.*head|pull.*\/merge/.test(y)) throw new Error('must not check out PR code'); console.log('workflow wiring ok')"`
Expected: `workflow wiring ok`.

**Step 3: Commit**

```bash
git add .github/workflows/wire-fixtures.yml
git commit -m "ci: add trusted-base wire-fixtures gate (pull_request_target, label-bypass)"
```

**Note:** this becomes a *gate* only once it is a required status check on `main` and the `contract-change` label exists (Task 7).

---

## Task 5: SDK wire-shape vitest (real transport path)

Capture the SDK's true wire body (through `enqueueEvent` → scrub → `beforeSend` → late-bind → `flushEvents` serialize via a mocked `fetch`), then assert normalized deep equality against the current-release fixture pair.

**Files:**
- Create: `packages/sdk/src/__tests__/wire-shape.test.ts`

**Step 1: Write the test**

`packages/sdk/src/__tests__/wire-shape.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Breadcrumb } from '@opslane/shared';
import { buildPayload, setUser, clearUser } from '../core';
import { loadConfig } from '../config';
import { clearBreadcrumbs } from '../breadcrumbs';
import { resetSessionId } from '../session';
import { enqueueEvent, flushEvents, _resetQueue } from '../transport';
import { _resetThrottle } from '../throttle';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as { version: string };
const version = pkg.version;
const fixtureDir = join(here, '../../../../test-fixtures/wire/events');

function loadFixture(kind: 'minimal' | 'full'): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, `v${version}-${kind}.json`), 'utf8'));
}

const FIXTURE_MESSAGE = "Cannot read properties of null (reading 'name')";
const FIXTURE_STACK =
  "TypeError: Cannot read properties of null (reading 'name')\n    at UserCard (https://app.example.com/assets/index.js:8:20)";

// Replace values that legitimately vary between the fixture's authored
// environment and this node test run. Structure (every key, nesting, array
// shape) is still compared exactly by toEqual.
const SENTINEL = '<volatile>';
function normalize(input: unknown): unknown {
  const v = structuredClone(input) as Record<string, unknown>;
  const err = v.error as Record<string, unknown> | undefined;
  const ctx = v.context as Record<string, unknown> | undefined;
  if (typeof v.timestamp === 'string') v.timestamp = SENTINEL;
  if (typeof v.sdk_version === 'string') v.sdk_version = SENTINEL;
  if (typeof v.session_id === 'string') v.session_id = SENTINEL;
  if (err && typeof err.stack === 'string') err.stack = SENTINEL;
  if (ctx && typeof ctx.url === 'string') ctx.url = SENTINEL;
  if (ctx && typeof ctx.user_agent === 'string') ctx.user_agent = SENTINEL;
  if (Array.isArray(v.breadcrumbs)) {
    for (const b of v.breadcrumbs as Array<Record<string, unknown>>) {
      if (b && typeof b.timestamp === 'string') b.timestamp = SENTINEL;
    }
  }
  return v;
}

// Enqueue the SDK-built event, then flush with fetch mocked, and return the
// parsed wire body. This exercises the real transport path, not just buildPayload.
async function captureWire(event: ReturnType<typeof buildPayload>): Promise<unknown> {
  let body = '';
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    body = init.body;
    return { ok: true } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    enqueueEvent(event);
    await flushEvents();
  } finally {
    vi.unstubAllGlobals();
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return JSON.parse(body);
}

describe('SDK emits the frozen wire shape', () => {
  beforeEach(() => {
    _resetQueue();
    _resetThrottle();
    clearBreadcrumbs();
    clearUser();
  });

  it('minimal payload matches the frozen fixture', async () => {
    resetSessionId(); // after clearUser: drop session so session_id is omitted
    loadConfig({
      apiKey: 'sk-test', endpoint: 'https://api.test',
      maxBreadcrumbs: 0, maxBatchSize: 100, errorThrottleMs: 0, release: '',
    });
    const crumb: Breadcrumb = { type: 'error', timestamp: new Date().toISOString(), category: 'error', message: 'boot' };
    const event = buildPayload('TypeError', FIXTURE_MESSAGE, FIXTURE_STACK, crumb);

    const wire = await captureWire(event);
    expect(normalize(wire)).toEqual(normalize(loadFixture('minimal')));
  });

  it('full payload matches the frozen fixture', async () => {
    loadConfig({
      apiKey: 'sk-test', endpoint: 'https://api.test',
      maxBatchSize: 100, errorThrottleMs: 0, release: 'web@2026.07.16',
    });
    setUser({ id: 'user-123', email: 'jane@example.com', account: { id: 'acct-42', name: 'Example Inc' } });
    const crumb: Breadcrumb = {
      type: 'navigation', timestamp: new Date().toISOString(),
      category: 'navigation', message: 'https://app.example.com/dashboard',
    };
    const event = buildPayload('TypeError', FIXTURE_MESSAGE, FIXTURE_STACK, crumb);

    const wire = await captureWire(event);
    expect(normalize(wire)).toEqual(normalize(loadFixture('full')));
  });
});
```

**Step 2: Run the test**

Run: `pnpm --filter @opslane/sdk test -- wire-shape`
Expected: PASS (2 tests). A failure here means the SDK's real wire shape drifted from the frozen fixture — investigate before touching the fixture.

**Step 3: Prove it bites (non-destructive)**

```bash
cp packages/sdk/src/core.ts /tmp/core.ts.bak
```
In `packages/sdk/src/core.ts`, add a stray key to the object returned by `buildPayload` (e.g. `extra_field: 'x',` near `sdk_version: SDK_VERSION,` at `:90`).
Run: `pnpm --filter @opslane/sdk test -- wire-shape`
Expected: FAIL (emitted has a key the fixture lacks — deep equality catches it).
Restore: `cp /tmp/core.ts.bak packages/sdk/src/core.ts && rm /tmp/core.ts.bak` and re-run → PASS.

**Step 4: Commit**

```bash
git add packages/sdk/src/__tests__/wire-shape.test.ts
git commit -m "test(sdk): assert real wire output matches the frozen v1.0.0 shape"
```

---

## Task 6: Written contract rule

**Files:**
- Create: `docs/contracts/events.md`
- Modify: `AGENTS.md` (Guardrails section)

**Step 1: Write the contract doc**

`docs/contracts/events.md`:

```markdown
# Event API contract

`POST /api/v1/events` is **append-only and backward-compatible, forever.**

The SDK ships to npm and runs in customers' apps on their upgrade schedule; the
ingestion API deploys on ours. Old SDK versions POST to our newest server
indefinitely and we cannot force-upgrade them. A break is a silent customer
outage we cannot hotfix.

## Rules

- **Add only optional fields.** Never remove a field the SDK may send, never make
  an existing field required, never stop reading a field an old SDK sends.
- **Never tighten decoding.** The events decoder must keep tolerating unknown
  fields (no `DisallowUnknownFields`) so a *newer* SDK's extra fields are ignored,
  not rejected.
- **Fixtures are frozen.** `test-fixtures/wire/events/` holds the exact wire JSON
  per released SDK shape. Add a new `v<version>-*.json` pair for a new shape;
  never edit or delete an existing file.

## Enforcement

- `packages/ingestion/handler/wire_compat_test.go` (`go` CI job) replays every
  fixture and asserts `202` + full field round-trip + stable grouping + unknown-
  field tolerance.
- `packages/sdk/src/__tests__/wire-shape.test.ts` (`js` CI job) asserts the SDK's
  real transport output still matches the current version's pair.
- `.github/workflows/wire-fixtures.yml` (trusted-base `pull_request_target`) fails
  any PR that modifies or deletes a frozen fixture, unless the PR carries the
  `contract-change` label — the one deliberate, reviewed way to change the
  contract.

## Making a deliberate change

Adding a field: add a new fixture pair, keep the field optional server-side, and
the old fixtures still pass. Editing/removing an existing fixture: apply the
`contract-change` label, a conscious acknowledgement that live clients may break.
```

**Step 2: Add the AGENTS.md guardrail line**

In `AGENTS.md`, under `## Guardrails`, add:

```markdown
- The `POST /api/v1/events` wire contract is append-only and backward-compatible. Add optional fields only; never edit or delete a frozen fixture under `test-fixtures/wire/`. See `docs/contracts/events.md`.
```

**Step 3: Verify**

Run: `node -e "require('fs').readFileSync('docs/contracts/events.md'); const a=require('fs').readFileSync('AGENTS.md','utf8'); if(!a.includes('docs/contracts/events.md')) throw new Error('AGENTS.md not updated'); console.log('docs ok')"`
Expected: `docs ok`.

**Step 4: Commit**

```bash
git add docs/contracts/events.md AGENTS.md
git commit -m "docs: document the append-only event API contract"
```

---

## Task 7: Ops prerequisites (make the gate real)

Not code — without these the workflow is advisory.

**Step 1: Create the `contract-change` label**

Run: `gh label create contract-change --description "Deliberate, reviewed change to a frozen API contract (bypasses wire-fixture immutability)" --color B60205`
Expected: created (or "already exists").

**Step 2: Require the `wire-fixtures` check on `main`, including admins**

In `main` branch protection: add the status check named **`wire-fixtures`** (the job `name`, per the verified fact above — not the workflow filename), and enable "Include administrators". The gate only runs on PRs, so admins must not be exempt or a direct push could edit a frozen fixture.

Verify (admin token): `gh api repos/opslane/opslane-oss/branches/main/protection --jq '.required_status_checks.contexts, .enforce_admins.enabled'`
Expected: contexts contains `wire-fixtures`; `enforce_admins` is `true`.

**Step 3: Record completion** in the PR description (cannot be proven by the diff).

---

## Final verification (whole feature)

From repo root:

```bash
# SDK real-wire test
pnpm --filter @opslane/sdk test -- wire-shape
# Script parser unit test
node --test scripts/check-wire-fixtures.test.mjs
# Ingestion (disposable DB with migrations applied)
(cd packages/ingestion && go build ./... && go vet ./... && go test ./handler -run TestWireFixtures -v)
# Guards on a clean tree
node scripts/check-wire-fixtures.mjs
node scripts/check-action-pins.mjs
```

Expected: SDK 2 tests pass; parser 5 tests pass; Go fixture tests pass; both check scripts print OK.

On the PR: confirm the `wire-fixtures` check runs green; in a scratch commit edit a fixture and confirm it goes red; add `contract-change` and confirm the check re-runs green; drop the scratch commit before merge.
