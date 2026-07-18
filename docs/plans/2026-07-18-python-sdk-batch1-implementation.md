# Python SDK Batch 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** An unhandled exception in a Flask app lands in the Opslane database, correctly grouped, with `platform = 'python'`. Closes issue #87.

**Architecture:** Two workstreams that meet at the wire. Server side first: migration 014, shared-type additions, the Python traceback parser, the platform-aware fingerprint, and handler plumbing — so the server accepts Python events before the SDK exists to send them. Then the SDK, bottom-up: breadcrumb ring buffer → contextvars scope → payload-building client → background transport → public API → Flask adapter. New frozen wire fixtures are generated from the real SDK at the end, and a live Compose smoke proves the full path.

**Tech Stack:** Python 3.11+ (stdlib only at runtime; flask + gunicorn as dev/test deps), Go (ingestion), TypeScript (shared types), Postgres, docker compose.

**Design doc:** `docs/plans/2026-07-17-python-sdk-design.md` — the authority for every contract here (transport semantics, Flask capture table, fingerprint invariants).

**Conventions that bite if forgotten:**
- SDK auth header is `X-API-Key` (`packages/ingestion/handler/auth.go:146`), endpoint `POST /api/v1/events`.
- Wire fixtures are append-only: add NEW `python-v*.json` files under `test-fixtures/wire/events/`; never touch existing ones (`wire-fixtures` CI check).
- Migrations: append-only, idempotent (`IF NOT EXISTS`), verified against a **disposable** Postgres — never the shared dev DB on 5434 (other worktree sessions use it).
- One stdlib deviation from the design's transport contract: `urllib.request` exposes a single timeout, not separate connect/read. Use one 5s total timeout (configurable). Amend the design doc line in Task 12.
- `git push` is user-run (repo hook blocks agent pushes).

---

## Part A — Server side

### Task 1: Migration 014 — `platform` columns

**Files:**
- Create: `packages/ingestion/db/migrations/014_platform.sql`

**Step 1: Write the migration**

```sql
-- 014_platform.sql — Python SDK Batch 1 (opslane-oss#87).
-- error_events.platform: every event row is an error event; absent-platform
-- payloads are JavaScript by wire contract, so NOT NULL DEFAULT is correct.
-- error_groups.platform: nullable — the incidents table also holds
-- kind='friction' rows, which have no platform. Set only for kind='error'.
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'javascript';
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS platform TEXT;
UPDATE error_groups SET platform = 'javascript' WHERE platform IS NULL AND kind = 'error';
```

**Step 2: Verify idempotency against a disposable Postgres**

```bash
docker run -d --name mig-check -e POSTGRES_USER=opslane -e POSTGRES_PASSWORD=x -e POSTGRES_DB=opslane -p 5499:5432 postgres:16
sleep 3
DATABASE_URL=postgres://opslane:x@localhost:5499/opslane MIGRATION_DIR=packages/ingestion/db/migrations ./scripts/run-migrations.sh
DATABASE_URL=postgres://opslane:x@localhost:5499/opslane MIGRATION_DIR=packages/ingestion/db/migrations ./scripts/run-migrations.sh  # second run must also succeed
docker rm -f mig-check
```

Expected: both runs exit 0 (second proves reapply safety).

**Step 3: Commit**

```bash
git add packages/ingestion/db/migrations/014_platform.sql
git commit -m "feat(ingestion): platform columns on error_events and error_groups (#87)"
```

---

### Task 2: Shared type additions

**Files:**
- Modify: `shared/src/types.ts`

**Step 1: Extend `ErrorEventPayload` and `BreadcrumbType`**

In `ErrorEventPayload` (all new fields optional — the wire contract is append-only):

```ts
export interface ErrorEventPayload {
  timestamp: string; // ISO 8601
  platform?: 'javascript' | 'python';
  runtime?: {
    name: string;    // e.g. "cpython" (sys.implementation.name)
    version: string; // e.g. "3.12.1" (platform.python_version())
  };
  error: {
    type: string;
    message: string;
    stack: string;
  };
  breadcrumbs: Breadcrumb[];
  context: {
    url?: string;
    user_agent?: string;
    request?: {
      method: string;
      path: string;
      headers: Record<string, string>;
      remote_addr?: string;
    };
    user?: {
      id: string;
      email?: string;
      account_id?: string;
      account_name?: string;
    };
  };
  sdk_version: string;
  release?: string;      // source map lookup (JS); deployment label (Python)
  session_id?: string;   // links error event to replay
}
```

Extend the breadcrumb union:

```ts
export type BreadcrumbType =
  | 'error'
  | 'fetch'
  | 'xhr'
  | 'console'
  | 'click'
  | 'navigation'
  | 'http'
  | 'log';
```

**Step 2: Rebuild everything that consumes shared types**

```bash
pnpm -r build && pnpm test
```

Expected: all green — additions are optional, nothing narrows.

**Step 3: Commit**

```bash
git add shared/src/types.ts
git commit -m "feat(shared): platform, runtime, context.request on ErrorEventPayload (#87)"
```

---

### Task 3: Python traceback parser (`grouping/python.go`) — tests first

**Files:**
- Create: `packages/ingestion/grouping/python_test.go`
- Create: `packages/ingestion/grouping/python.go`

**Step 1: Write the failing table tests**

Every stability invariant from the design gets a case. `packages/ingestion/grouping/python_test.go`:

```go
package grouping

import (
	"reflect"
	"strings"
	"testing"
)

const pyStandard = `Traceback (most recent call last):
  File "/app/api/routes/users.py", line 42, in get_user
    user = db.query(User).filter_by(id=user_id).one()
  File "/app/services/db.py", line 17, in one
    return self.query.one()
  File "/app/venv/lib/python3.12/site-packages/sqlalchemy/orm/query.py", line 2778, in one
    return self._iter().one()
ValueError: No row was found`

func TestIsPythonTraceback(t *testing.T) {
	if !isPythonTraceback(pyStandard) {
		t.Fatal("standard traceback not detected")
	}
	if isPythonTraceback("TypeError: x is not a function\n    at foo (app.js:1:1)") {
		t.Fatal("V8 stack misdetected as Python")
	}
}

func TestPythonFrames_OrderReversedAndLibraryFiltered(t *testing.T) {
	got := pythonFrames(pyStandard)
	// Most recent call is LAST in Python; site-packages frame filtered;
	// deployment prefix /app/ stripped; identity is file:function, no lineno.
	want := []string{
		"services/db.py:one",
		"api/routes/users.py:get_user",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_DeploymentPrefixInvariance(t *testing.T) {
	a := pythonFrames(pyStandard)
	b := pythonFrames(strings.ReplaceAll(pyStandard, "/app/", "/srv/"))
	c := pythonFrames(strings.ReplaceAll(pyStandard, "/app/", "/home/deploy/"))
	if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(a, c) {
		t.Fatalf("frames differ across deployment roots: %v / %v / %v", a, b, c)
	}
}

func TestPythonFrames_LineNumberInvariance(t *testing.T) {
	shifted := strings.ReplaceAll(pyStandard, "line 42", "line 57")
	if !reflect.DeepEqual(pythonFrames(pyStandard), pythonFrames(shifted)) {
		t.Fatal("line-number shift changed frame identity")
	}
}

func TestPythonFrames_ChainedExceptionsUseOutermost(t *testing.T) {
	chained := `Traceback (most recent call last):
  File "/app/inner.py", line 1, in inner_fn
    raise KeyError("k")
KeyError: 'k'

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/app/outer.py", line 9, in outer_fn
    handle()
RuntimeError: handling failed`
	got := pythonFrames(chained)
	want := []string{"outer.py:outer_fn"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_RecursionDeduplicated(t *testing.T) {
	var b strings.Builder
	b.WriteString("Traceback (most recent call last):\n")
	for i := 0; i < 30; i++ {
		b.WriteString("  File \"/app/recurse.py\", line 5, in spin\n    spin()\n")
	}
	b.WriteString("RecursionError: maximum recursion depth exceeded")
	got := pythonFrames(b.String())
	want := []string{"recurse.py:spin"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_GunicornWrapperFiltered(t *testing.T) {
	stack := `Traceback (most recent call last):
  File "/usr/local/lib/python3.12/site-packages/gunicorn/workers/sync.py", line 136, in handle
    self.handle_request(listener, req, client, addr)
  File "/app/api/app.py", line 12, in view
    boom()
TypeError: boom`
	want := []string{"api/app.py:view"}
	if got := pythonFrames(stack); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_MalformedReturnsEmpty(t *testing.T) {
	if got := pythonFrames("Traceback (most recent call last):\ngarbage"); len(got) != 0 {
		t.Fatalf("expected no frames, got %v", got)
	}
}

func TestIsExceptionGroupTraceback(t *testing.T) {
	eg := `  + Exception Group Traceback (most recent call last):
  |   File "/app/main.py", line 3, in <module>
  |     raise ExceptionGroup("many", [ValueError("a")])`
	if !isExceptionGroupTraceback(eg) {
		t.Fatal("ExceptionGroup traceback not detected")
	}
	if isExceptionGroupTraceback(pyStandard) {
		t.Fatal("standard traceback misdetected as ExceptionGroup")
	}
}

func TestPythonFrames_CapsAtFiveNewestFirst(t *testing.T) {
	var b strings.Builder
	b.WriteString("Traceback (most recent call last):\n")
	for _, f := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		b.WriteString("  File \"/app/" + f + ".py\", line 1, in fn_" + f + "\n    x()\n")
	}
	b.WriteString("ValueError: x")
	// Not just length: the five NEWEST frames (bottom of traceback), reversed.
	want := []string{"g.py:fn_g", "f.py:fn_f", "e.py:fn_e", "d.py:fn_d", "c.py:fn_c"}
	if got := pythonFrames(b.String()); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_NestedDeploymentPrefixes(t *testing.T) {
	// /usr/src/app/x.py must normalize the same as /app/x.py — prefixes are
	// stripped iteratively, not once.
	a := pythonFrames("Traceback (most recent call last):\n  File \"/usr/src/app/x.py\", line 1, in fn\n    x()\nValueError: x")
	b := pythonFrames("Traceback (most recent call last):\n  File \"/app/x.py\", line 1, in fn\n    x()\nValueError: x")
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("nested prefix mismatch: %v vs %v", a, b)
	}
}

func TestPythonFrames_ChainMarkerInMessageIgnored(t *testing.T) {
	// A marker phrase inside an exception MESSAGE (not on its own line
	// between tracebacks) must not segment the traceback.
	stack := "Traceback (most recent call last):\n  File \"/app/x.py\", line 1, in fn\n    x()\nValueError: saw 'During handling of the above exception, another exception occurred:' in logs"
	if got := pythonFrames(stack); len(got) != 1 {
		t.Fatalf("message containing marker text segmented the traceback: %v", got)
	}
}
```

The new tests use `strings` and `reflect`; `fingerprint_test.go` currently imports only `testing` — extend imports in whichever file these land.

**Step 2: Run to verify failure**

```bash
cd packages/ingestion && go test ./grouping/ -run 'TestIsPython|TestPythonFrames|TestIsExceptionGroup' -v
```

Expected: compile FAIL — `undefined: isPythonTraceback` etc.

**Step 3: Implement `packages/ingestion/grouping/python.go`**

```go
package grouping

import (
	"regexp"
	"strings"
)

// Python traceback parsing for fingerprinting (opslane-oss#87).
//
// Frame identity is deliberately "relative_file:function" — no line numbers
// (they shift on ordinary edits) and no deployment root (varies across
// environments). Line numbers and full paths stay in the stored raw
// traceback for display and worker source lookup.

var (
	// `  File "/app/x.py", line 42, in get_user`
	rePyFrame = regexp.MustCompile(`(?m)^\s*File "([^"]+)", line \d+, in (.+)$`)
	// Deployment roots stripped from frame identity. Shared by contract with
	// the worker's stack-trace mapping (Batch 3). Leading slash optional so
	// iterative stripping reduces /usr/src/app/x.py and /app/x.py to the
	// same identity.
	rePyDeployPrefix = regexp.MustCompile(`^/?(?:app|srv|opt|usr/src)/|^/?home/[^/]+/`)
	rePyLibPath      = regexp.MustCompile(`(?:site-packages|dist-packages)/|/venv/|\.tox/|lib/python\d+(?:\.\d+)?/`)
)

// Markers are matched as standalone lines ("\n"+marker+"\n"), never as
// substrings — an exception MESSAGE quoting the phrase must not segment
// the traceback.
var pyChainMarkers = []string{
	"\nDuring handling of the above exception, another exception occurred:\n",
	"\nThe above exception was the direct cause of the following exception:\n",
}

func isPythonTraceback(stack string) bool {
	return strings.HasPrefix(strings.TrimSpace(stack), "Traceback (most recent call last):")
}

// isExceptionGroupTraceback detects Python 3.11+ ExceptionGroup output
// (indented `+ Exception Group Traceback` sections). v1 handles these via the
// raw-string fallback in Fingerprint; structured handling is deferred.
func isExceptionGroupTraceback(stack string) bool {
	return strings.Contains(stack, "Exception Group Traceback (most recent call last):")
}

// pythonFrames extracts up to 5 application-frame identities from a Python
// traceback, most recent first. Returns nil/empty when nothing parseable
// remains (caller falls back to hashing the raw string).
func pythonFrames(stack string) []string {
	// Chained exceptions: fingerprint only the final (outermost) exception —
	// the one the developer sees and fixes.
	seg := stack
	for _, marker := range pyChainMarkers {
		if i := strings.LastIndex(seg, marker); i >= 0 {
			seg = seg[i+len(marker):]
		}
	}

	matches := rePyFrame.FindAllStringSubmatch(seg, -1)
	frames := make([]string, 0, len(matches))
	seen := make(map[string]bool, len(matches))
	for _, m := range matches {
		file, fn := m[1], m[2]
		if rePyLibPath.MatchString(file) {
			continue
		}
		// Strip deployment roots ITERATIVELY: /usr/src/app/x.py needs two
		// passes to match /app/x.py's single pass.
		rel := file
		for {
			next := rePyDeployPrefix.ReplaceAllString(rel, "")
			if next == rel {
				break
			}
			rel = next
		}
		id := rel + ":" + strings.TrimSpace(fn)
		if seen[id] { // RecursionError and mutual-recursion dedup
			continue
		}
		seen[id] = true
		frames = append(frames, id)
	}

	// Python prints the most recent call LAST; reverse so the most relevant
	// frame leads, matching the V8 parser's ordering convention.
	for i, j := 0, len(frames)-1; i < j; i, j = i+1, j-1 {
		frames[i], frames[j] = frames[j], frames[i]
	}
	if len(frames) > 5 {
		frames = frames[:5]
	}
	return frames
}
```

**Step 4: Run to verify pass**

```bash
cd packages/ingestion && go test ./grouping/ -v
```

Expected: all new tests PASS (existing fingerprint tests still pass — nothing touched them yet).

**Step 5: Commit**

```bash
git add packages/ingestion/grouping/python.go packages/ingestion/grouping/python_test.go
git commit -m "feat(ingestion): Python traceback parser with stable frame identity (#87)"
```

---

### Task 4: Platform-aware `Fingerprint()` — tests first

**Files:**
- Modify: `packages/ingestion/grouping/fingerprint.go`
- Modify: `packages/ingestion/grouping/fingerprint_test.go`
- Modify: `packages/ingestion/handler/error_event.go:97` (call site)

**Step 1: Add the new failing tests**

Append to `fingerprint_test.go`:

```go
func TestFingerprint_PlatformPreventsCollision(t *testing.T) {
	msg := "No row was found"
	js := Fingerprint("javascript", "ValueError", msg, "")
	py := Fingerprint("python", "ValueError", msg, "")
	if js == py {
		t.Fatal("same-type errors on different platforms must not collide")
	}
}

func TestFingerprint_PythonUsesParsedFrames(t *testing.T) {
	a := Fingerprint("python", "ValueError", "No row was found", pyStandard)
	b := Fingerprint("python", "ValueError", "No row was found",
		strings.ReplaceAll(pyStandard, "/app/", "/srv/"))
	if a != b {
		t.Fatal("fingerprint not invariant across deployment roots")
	}
}

func TestFingerprint_PythonMalformedFallsBackToRawString(t *testing.T) {
	a := Fingerprint("python", "ValueError", "x", "Traceback (most recent call last):\ngarbage-A")
	b := Fingerprint("python", "ValueError", "x", "Traceback (most recent call last):\ngarbage-B")
	if a == b {
		t.Fatal("raw-string fallback must distinguish different raw stacks")
	}
}
```

These tests use `strings.ReplaceAll`; `fingerprint_test.go` imports only `testing` today — add `strings` to its imports.

**Step 2: Run to verify failure**

```bash
cd packages/ingestion && go test ./grouping/ -v 2>&1 | head -20
```

Expected: compile FAIL — `Fingerprint` takes 3 args.

**Step 3: Change the signature and routing**

In `fingerprint.go`, replace the `Fingerprint` function:

```go
// Fingerprint generates a stable fingerprint for error grouping.
// Algorithm: first 128 bits of
// SHA256(platform | error_type | normalized_message | frames).
// Frames are platform-parsed: Python tracebacks yield prefix-stripped
// file:function identities (python.go); everything else uses V8-style
// topFrames. Python stacks that don't parse (malformed, ExceptionGroup)
// fall back to the raw stack string.
func Fingerprint(platform, errorType, errorMessage, stackTrace string) string {
	if platform == "" {
		platform = "javascript"
	}
	template := normalizeMessage(errorMessage)

	var frames []string
	if platform == "python" {
		if isPythonTraceback(stackTrace) && !isExceptionGroupTraceback(stackTrace) {
			frames = pythonFrames(stackTrace)
		}
		if len(frames) == 0 && stackTrace != "" {
			frames = []string{stackTrace} // graceful fallback: hash the raw string
		}
	} else {
		frames = topFrames(stackTrace, 5)
	}

	input := fmt.Sprintf("%s|%s|%s|%s", platform, errorType, template, strings.Join(frames, "|"))
	hash := sha256.Sum256([]byte(input))
	return fmt.Sprintf("%x", hash[:16])
}
```

**Step 4: Update every existing caller and test**

- All existing `Fingerprint(a, b, c)` calls in `fingerprint_test.go` become `Fingerprint("javascript", a, b, c)`.
- `packages/ingestion/handler/error_event.go:97` becomes (platform parsing lands properly in Task 5; for now pass the literal):
  ```go
  fingerprint := grouping.Fingerprint("javascript", payload.Error.Type, payload.Error.Message, payload.Error.Stack)
  ```
- Sweep for other callers: `grep -rn "grouping.Fingerprint(" packages/ingestion --include="*.go"` — update any found the same way.

**Step 5: Run the full ingestion suite**

```bash
cd packages/ingestion && go build ./... && go test ./... 2>&1 | tail -20
```

Expected: PASS. Note: existing stored-fingerprint expectations in tests (if any assert exact hashes) need updating — the platform prefix changes every value. That's the approved re-hash; the deployment gate (Task 15) covers production.

**Step 6: Commit**

```bash
git add packages/ingestion/grouping packages/ingestion/handler/error_event.go
git commit -m "feat(ingestion): platform-prefixed fingerprints with Python frame parsing (#87)"
```

---

### Task 5: Handler + insert path carry `platform` and `runtime`

**Files:**
- Modify: `packages/ingestion/handler/error_event.go`
- Modify: `packages/ingestion/db/queries.go` (`IngestParams`, `InsertErrorEventAndGroup`)
- Modify: `packages/ingestion/handler/error_event_test.go` (new cases)

**Step 1: Write the failing tests**

Follow the existing integration-test pattern in `error_event_test.go` (they run against the migrated test DB). Add:

```go
func TestIngest_PythonPlatformStored(t *testing.T) {
	// POST a python payload; assert 202, then read back the event and group
	// rows: error_events.platform == "python", error_groups.platform == "python",
	// and context contains the runtime object.
}

func TestIngest_NoPlatformDefaultsToJavascript(t *testing.T) {
	// POST the v1.0.0-minimal wire fixture body; assert stored platform is
	// "javascript" on both event and group.
}

func TestIngest_SamePythonErrorGroupsTogether(t *testing.T) {
	// POST the same python payload twice with different deployment roots in
	// the stack (/app/ vs /srv/); assert both events land in ONE group.
}
```

Write them fully mirroring the file's existing helper/setup style (read `error_event_test.go` first — use whatever request-posting and DB-assertion helpers actually exist there; don't invent names). **These are DB-backed tests: `testDeps` silently `t.Skip`s without `DATABASE_URL`**, so every verification run below must export it against a migrated database — a skipped test is not a passing test. Run: expected FAIL (platform column never written; no platform parsing).

**Step 2: Parse the new fields in `error_event.go`**

Add to the payload struct:

```go
Platform string          `json:"platform"`
Runtime  json.RawMessage `json:"runtime"`
```

After unmarshal, normalize the platform (before fingerprinting). Absent → `javascript`; a well-formed unknown token (future SDK) is stored as-is per append-only tolerance; garbage is clamped:

```go
// rePlatformToken at package level:
var rePlatformToken = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

if payload.Platform == "" || !rePlatformToken.MatchString(payload.Platform) {
	payload.Platform = "javascript"
}
```

Fingerprint call becomes:

```go
fingerprint := grouping.Fingerprint(payload.Platform, payload.Error.Type, payload.Error.Message, payload.Error.Stack)
```

Fold `runtime` into the context JSONB (design: runtime is stored inside the event's context). Two review-driven constraints: validate the shape (never persist arbitrary client JSON), and merge **before** the redaction block so RedactContext sees the merged object. `"context": null` unmarshals into a **nil map** without error — assigning into it panics, so guard:

```go
// BEFORE the masking.RedactContext call:
if len(payload.Runtime) > 0 {
	var rt struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(payload.Runtime, &rt); err == nil && rt.Name != "" && rt.Version != "" {
		var ctxMap map[string]json.RawMessage
		if err := json.Unmarshal([]byte(ctx), &ctxMap); err == nil {
			if ctxMap == nil { // "null" decodes to a nil map — writable it is not
				ctxMap = map[string]json.RawMessage{}
			}
			if clean, err := json.Marshal(rt); err == nil {
				ctxMap["runtime"] = clean
				if merged, err := json.Marshal(ctxMap); err == nil {
					ctx = string(merged)
				}
			}
		}
	}
}
```

Pass `Platform: payload.Platform` in the `IngestParams` literal.

**Step 3: Store it in `queries.go`**

- Add `Platform string` to `IngestParams` (comment: `"javascript" | "python" | future tokens; empty is defaulted here`).
- **Default inside `InsertErrorEventAndGroup`**, next to the existing Breadcrumbs/Context defaulting — ~20 other `IngestParams` construction sites (tests, webhook paths) omit `Platform`, and an explicit `""` INSERT would bypass the column's SQL default:
  ```go
  if p.Platform == "" {
  	p.Platform = "javascript"
  }
  ```
- Event insert gains the column AND the argument (the placeholder is useless without the matching arg in the `QueryRow` call):
  ```go
  err = tx.QueryRow(ctx,
  	`INSERT INTO error_events (project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw, breadcrumbs, context, release, session_id, platform)
  	 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
  	 RETURNING id`,
  	p.ProjectID, p.EnvironmentID, eventTime, p.ErrorType, p.ErrorMessage, p.StackTraceRaw, p.Breadcrumbs, p.Context, nilIfEmpty(p.Release), nilIfEmpty(p.SessionID), p.Platform,
  ).Scan(&eventID)
  ```
- Group upsert gains column + argument (never flip an existing group's platform):
  ```go
  err = tx.QueryRow(ctx,
  	`INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, occurrence_count, sample_event_id, platform)
  	 VALUES ($1, $2, $3, $4, $4, 1, $5, $6)
  	 ON CONFLICT (project_id, fingerprint) DO UPDATE
  	   SET first_seen = LEAST(error_groups.first_seen, $4),
  	       last_seen = GREATEST(error_groups.last_seen, $4),
  	       occurrence_count = error_groups.occurrence_count + 1,
  	       sample_event_id = $5,
  	       platform = COALESCE(error_groups.platform, EXCLUDED.platform),
  	       updated_at = now()
  	 RETURNING id, (xmax = 0) AS is_new`,
  	p.ProjectID, p.Fingerprint, p.Title, eventTime, eventID, p.Platform,
  ).Scan(&groupID, &isNew)
  ```

**Step 4: Run the suite — with a real database, or the handler/db tests skip vacuously**

```bash
docker run -d --name b1-test-db -e POSTGRES_USER=opslane -e POSTGRES_PASSWORD=x -e POSTGRES_DB=opslane -p 5499:5432 postgres:16 && sleep 3
export DATABASE_URL=postgres://opslane:x@localhost:5499/opslane
MIGRATION_DIR=db/migrations ../../scripts/run-migrations.sh   # from packages/ingestion
cd packages/ingestion && go build ./... && go test ./handler ./db ./grouping -v 2>&1 | tail -30
```

Expected: new tests PASS (verify they RAN — grep the output for the test names, not just `ok`); `wire_compat_test.go` still green (old fixtures default to javascript). Keep `b1-test-db` running for Task 13; remove it after.

**Step 5: Commit**

```bash
git add packages/ingestion/handler packages/ingestion/db/queries.go
git commit -m "feat(ingestion): ingest platform and runtime through to storage (#87)"
```

---

## Part B — SDK

Each SDK task: activate the venv (`cd packages/sdk-python`, use `.venv/bin/pytest`). Add test deps once in Task 6.

### Task 6: Test deps + breadcrumb ring buffer

**Files:**
- Modify: `packages/sdk-python/pyproject.toml` (dev extras)
- Create: `packages/sdk-python/tests/test_breadcrumbs.py`
- Modify: `packages/sdk-python/opslane/breadcrumbs.py`

**Step 1: Extend dev extras** (runtime deps stay `[]` — the zero-dep test guards this):

```toml
[project.optional-dependencies]
dev = ["pytest>=8", "flask>=3", "gunicorn>=22"]
```

```bash
cd packages/sdk-python && .venv/bin/pip install -e '.[dev]'
```

**Step 2: Failing tests** — `tests/test_breadcrumbs.py`:

```python
from opslane.breadcrumbs import MAX_BREADCRUMBS, BreadcrumbBuffer


def test_appends_in_order():
    buf = BreadcrumbBuffer()
    buf.add({"n": 1})
    buf.add({"n": 2})
    assert [c["n"] for c in buf.snapshot()] == [1, 2]


def test_ring_drops_oldest_at_cap():
    buf = BreadcrumbBuffer()
    for i in range(MAX_BREADCRUMBS + 10):
        buf.add({"n": i})
    snap = buf.snapshot()
    assert len(snap) == MAX_BREADCRUMBS
    assert snap[0]["n"] == 10          # oldest 10 dropped
    assert snap[-1]["n"] == MAX_BREADCRUMBS + 9


def test_snapshot_is_a_copy():
    buf = BreadcrumbBuffer()
    buf.add({"n": 1})
    snap = buf.snapshot()
    snap.append({"n": 2})
    assert len(buf.snapshot()) == 1
```

Run `.venv/bin/pytest tests/test_breadcrumbs.py -v` → FAIL (`ImportError`).

**Step 3: Implement** — `opslane/breadcrumbs.py`:

```python
"""Request-scoped breadcrumb ring buffer: max 50, oldest dropped."""
from collections import deque

MAX_BREADCRUMBS = 50


class BreadcrumbBuffer:
    def __init__(self, maxlen: int = MAX_BREADCRUMBS):
        self._buf = deque(maxlen=maxlen)

    def add(self, crumb: dict) -> None:
        self._buf.append(crumb)

    def snapshot(self) -> list:
        return list(self._buf)
```

**Step 4:** `.venv/bin/pytest tests/test_breadcrumbs.py -v` → 3 passed. Full suite still green: `.venv/bin/pytest -v`.

**Step 5: Commit**

```bash
git add packages/sdk-python
git commit -m "feat(sdk-python): breadcrumb ring buffer (#87)"
```

---

### Task 7: contextvars scope

**Files:**
- Create: `packages/sdk-python/tests/test_context.py`
- Modify: `packages/sdk-python/opslane/context.py`

**Step 1: Failing tests** — `tests/test_context.py`:

```python
import threading

from opslane import context as ctx


def test_scope_lifecycle():
    tokens = ctx.push_scope({"method": "GET", "path": "/x"})
    ctx.set_user({"id": "u1"})
    ctx.add_breadcrumb({"type": "log"})
    assert ctx.get_user() == {"id": "u1"}
    assert ctx.get_request()["path"] == "/x"
    assert len(ctx.get_breadcrumbs()) == 1
    ctx.reset_scope(tokens)
    assert ctx.get_user() is None
    assert ctx.get_request() is None
    assert ctx.get_breadcrumbs() == []


def test_no_bleed_across_threads():
    errors = []

    def worker(i: int):
        try:
            tokens = ctx.push_scope({"method": "GET", "path": f"/u/{i}"})
            ctx.set_user({"id": f"user-{i}"})
            ctx.add_breadcrumb({"n": i})
            # If contextvars bled, another thread's writes would surface here.
            assert ctx.get_user() == {"id": f"user-{i}"}, "user bled"
            assert ctx.get_breadcrumbs() == [{"n": i}], "breadcrumbs bled"
            assert ctx.get_request()["path"] == f"/u/{i}", "request bled"
            ctx.reset_scope(tokens)
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(50)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []


def test_clear_user():
    tokens = ctx.push_scope(None)
    ctx.set_user({"id": "u1"})
    ctx.clear_user()
    assert ctx.get_user() is None
    ctx.reset_scope(tokens)


def test_reset_scope_survives_foreign_context():
    # teardown may run in a different context under async servers; reset_scope
    # must degrade gracefully instead of raising ValueError.
    import contextvars

    tokens = contextvars.copy_context().run(ctx.push_scope, None)
    ctx.reset_scope(tokens)  # must not raise
```

Run → FAIL.

**Step 2: Implement** — `opslane/context.py`:

```python
"""contextvars-based request-scoped state: user, breadcrumbs, request meta.

Safe for threaded Flask (each request thread gets isolated state) and async
views. Adapters call push_scope() at request start and reset_scope() at
teardown; the token-based reset cleans up even when the handler raised.

Known v1 limitations (documented, accepted for sync-Flask scope): a COPIED
context (contextvars.copy_context) shares the mutable BreadcrumbBuffer with
its origin, so sibling async tasks spawned from one request see each other's
breadcrumbs; and the foreign-context fallback in reset_scope clears the
executing context, not the originating one. Both are inert under the
supported deployment model (one request per thread/context).
"""
import contextvars
from typing import Any, Optional

from opslane.breadcrumbs import BreadcrumbBuffer

_user: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "opslane_user", default=None
)
_breadcrumbs: contextvars.ContextVar[Optional[BreadcrumbBuffer]] = contextvars.ContextVar(
    "opslane_breadcrumbs", default=None
)
_request: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "opslane_request", default=None
)


def push_scope(request_meta: "Optional[dict]") -> tuple:
    """Start a fresh request scope. Returns tokens for reset_scope()."""
    return (
        _user.set(None),
        _breadcrumbs.set(BreadcrumbBuffer()),
        _request.set(dict(request_meta) if request_meta else None),
    )


def reset_scope(tokens: tuple) -> None:
    """Restore pre-scope state. Tolerates running in a foreign context
    (async servers may run teardown elsewhere); falls back to clearing."""
    for var, token in zip((_user, _breadcrumbs, _request), tokens):
        try:
            var.reset(token)
        except ValueError:
            var.set(None)


def set_user(user: "Optional[dict]") -> None:
    _user.set(dict(user) if user else None)


def get_user() -> "Optional[dict]":
    return _user.get()


def clear_user() -> None:
    _user.set(None)


def add_breadcrumb(crumb: dict) -> None:
    buf = _breadcrumbs.get()
    if buf is None:
        buf = BreadcrumbBuffer()
        _breadcrumbs.set(buf)
    buf.add(crumb)


def get_breadcrumbs() -> list:
    buf = _breadcrumbs.get()
    return buf.snapshot() if buf is not None else []


def get_request() -> "Optional[dict]":
    return _request.get()
```

**Step 3:** `.venv/bin/pytest tests/test_context.py -v` → 4 passed; full suite green.

**Step 4: Commit**

```bash
git add packages/sdk-python
git commit -m "feat(sdk-python): contextvars request scope with thread isolation (#87)"
```

---

### Task 8: Client — payload building, header deny-list, level mapping

**Files:**
- Create: `packages/sdk-python/tests/test_client.py`
- Modify: `packages/sdk-python/opslane/client.py`

**Step 1: Failing tests** — `tests/test_client.py` (transport injected as a stub; the client never does I/O itself):

```python
import opslane
from opslane import context as ctx
from opslane.client import DEFAULT_SENSITIVE_HEADERS, Client, filter_headers, map_log_level


class StubTransport:
    def __init__(self):
        self.sent = []

    def enqueue(self, payload):
        self.sent.append(payload)

    def flush(self, timeout=5.0):
        return True


def make_client(**kw):
    return Client(api_key="k", endpoint="https://ingest.example.com", transport=StubTransport(), **kw)


def _capture(client):
    try:
        raise ValueError("boom hex 0xDEADBEEF")
    except ValueError as e:
        client.capture_exception(e)
    return client.transport.sent[-1]


def test_payload_core_fields():
    payload = _capture(make_client())
    assert payload["platform"] == "python"
    assert payload["runtime"]["name"]  # cpython
    assert payload["runtime"]["version"].count(".") == 2
    assert payload["error"]["type"] == "ValueError"
    assert "boom hex" in payload["error"]["message"]
    assert payload["error"]["stack"].startswith("Traceback (most recent call last):")
    assert payload["sdk_version"] == opslane.__version__
    assert payload["timestamp"].endswith("Z")
    assert "release" not in payload  # absent, not null — matches wire fixtures


def test_qualified_exception_type():
    class Custom(Exception):
        pass

    client = make_client()
    try:
        raise Custom("x")
    except Custom as e:
        client.capture_exception(e)
    # Non-builtin types are module-qualified, like sqlalchemy.exc.NoResultFound
    assert client.transport.sent[-1]["error"]["type"].endswith("test_client.Custom")


def test_request_context_and_compat_fields():
    tokens = ctx.push_scope({
        "method": "GET",
        "path": "/api/users/123",
        "headers": {"Content-Type": "application/json", "Authorization": "Bearer s3cr3t"},
        "remote_addr": "10.0.1.50",
    })
    payload = _capture(make_client())
    ctx.reset_scope(tokens)
    req = payload["context"]["request"]
    assert req["method"] == "GET"
    assert "authorization" not in req["headers"]        # deny-listed
    assert req["headers"]["content-type"] == "application/json"
    assert payload["context"]["url"] == "GET /api/users/123"   # compat fill
    assert payload["context"]["user_agent"].startswith("Python/")


def test_user_context_mapping():
    tokens = ctx.push_scope(None)
    ctx.set_user({"id": "u1", "email": "a@b.c", "account": {"id": "acme", "name": "Acme"}})
    payload = _capture(make_client())
    ctx.reset_scope(tokens)
    assert payload["context"]["user"] == {
        "id": "u1", "email": "a@b.c", "account_id": "acme", "account_name": "Acme",
    }


def test_breadcrumbs_included():
    tokens = ctx.push_scope(None)
    ctx.add_breadcrumb({"type": "log", "category": "app", "level": "warning",
                        "message": "near expiry", "timestamp": "t"})
    payload = _capture(make_client())
    ctx.reset_scope(tokens)
    assert payload["breadcrumbs"][0]["message"] == "near expiry"


def test_filter_headers_deny_list():
    headers = {"Authorization": "x", "Cookie": "x", "X-API-Key": "x",
               "X-CSRF-Token": "x", "Set-Cookie": "x", "Accept": "text/html"}
    assert filter_headers(headers, DEFAULT_SENSITIVE_HEADERS) == {"accept": "text/html"}


def test_map_log_level():
    assert map_log_level("WARNING") == "warning"
    assert map_log_level("CRITICAL") == "error"   # shared type has no critical
    assert map_log_level("unknown") == "info"


def test_release_included_when_set():
    payload = _capture(make_client(release="v1.2.3"))
    assert payload["release"] == "v1.2.3"
```

Run → FAIL.

**Step 2: Implement** — `opslane/client.py`:

```python
"""Core client: builds ErrorEventPayload dicts and hands them to the transport.

No I/O here — the transport owns delivery. Payload shape must match
shared/src/types.ts ErrorEventPayload and the frozen python-v* wire fixtures.
"""
import platform as _platform
import sys
import traceback
from datetime import datetime, timezone

from opslane import context as ctx

DEFAULT_SENSITIVE_HEADERS = frozenset(
    {"authorization", "cookie", "x-api-key", "x-csrf-token", "set-cookie"}
)

_LEVEL_MAP = {
    "DEBUG": "debug",
    "INFO": "info",
    "WARNING": "warning",
    "ERROR": "error",
    "CRITICAL": "error",  # shared Breadcrumb type has no 'critical'
}


def map_log_level(levelname: str) -> str:
    return _LEVEL_MAP.get(levelname, "info")


def filter_headers(headers, deny_list) -> dict:
    return {
        k.lower(): v for k, v in (headers or {}).items() if k.lower() not in deny_list
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _qualified_type(exc: BaseException) -> str:
    t = type(exc)
    module = getattr(t, "__module__", "")
    if module in ("builtins", "", None):
        return t.__qualname__
    return f"{module}.{t.__qualname__}"


class Client:
    def __init__(
        self,
        api_key,
        endpoint,
        release=None,
        sensitive_headers=None,
        send_pii=False,
        max_events_per_minute=100,
        http_timeout=5.0,
        transport=None,
    ):
        from opslane.transport import Transport  # local import: keeps stubs easy

        self.api_key = api_key
        self.endpoint = endpoint.rstrip("/")
        self.release = release
        self.send_pii = send_pii
        self.sensitive_headers = frozenset(
            h.lower() for h in (sensitive_headers or DEFAULT_SENSITIVE_HEADERS)
        )
        self.transport = transport or Transport(
            endpoint=self.endpoint,
            api_key=api_key,
            max_events_per_minute=max_events_per_minute,
            http_timeout=http_timeout,
        )

    def capture_exception(self, exc: BaseException) -> None:
        self.transport.enqueue(self.build_payload(exc))

    def build_payload(self, exc: BaseException) -> dict:
        from opslane import __version__

        stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        payload = {
            "timestamp": _now_iso(),
            "platform": "python",
            "runtime": {
                "name": sys.implementation.name,
                "version": _platform.python_version(),
            },
            "error": {
                "type": _qualified_type(exc),
                "message": str(exc),
                "stack": stack,
            },
            "breadcrumbs": ctx.get_breadcrumbs(),
            "context": self._build_context(),
            "sdk_version": __version__,
        }
        if self.release:
            payload["release"] = self.release
        return payload

    def _build_context(self) -> dict:
        from opslane import __version__

        context = {
            "user_agent": f"Python/{_platform.python_version()} opslane/{__version__}"
        }
        request = ctx.get_request()
        if request:
            context["url"] = f"{request.get('method', '')} {request.get('path', '')}".strip()
            req = {
                "method": request.get("method", ""),
                "path": request.get("path", ""),
                "headers": filter_headers(request.get("headers"), self.sensitive_headers),
            }
            if request.get("remote_addr"):
                req["remote_addr"] = request["remote_addr"]
            context["request"] = req
        user = ctx.get_user()
        if user and user.get("id"):
            mapped = {"id": str(user["id"])}
            if user.get("email"):
                mapped["email"] = user["email"]
            account = user.get("account") or {}
            if user.get("account_id") or account.get("id"):
                mapped["account_id"] = user.get("account_id") or account.get("id")
            if user.get("account_name") or account.get("name"):
                mapped["account_name"] = user.get("account_name") or account.get("name")
            context["user"] = mapped
        return context
```

**Step 3:** `.venv/bin/pytest tests/test_client.py -v` → all pass (note: `Transport` doesn't exist yet, but the local import only runs when no transport is injected — the stub covers every test). Full suite green.

**Step 4: Commit**

```bash
git add packages/sdk-python
git commit -m "feat(sdk-python): payload-building client with PII deny-list (#87)"
```

---

### Task 9: Transport — the full contract

**Files:**
- Create: `packages/sdk-python/tests/test_transport.py`
- Modify: `packages/sdk-python/opslane/transport.py`

The design's contract, restated as the test list: queue cap 100 oldest-dropped; drain ≤10/5s; single 5s timeout; retry network/429/5xx with backoff+jitter capped 60s; `Retry-After` override capped 60s; other 4xx dropped immediately; max 5 attempts; failing events don't block the queue; rate limit 100/min at enqueue; `opslane` logger diagnostics; `flush(timeout)`→bool, never raises; lazy thread start with PID fork check.

**Step 1: Failing tests** — `tests/test_transport.py`. Key technique: inject the send function (`_send_fn`) so no test does real HTTP, and drive draining synchronously via the internal `_drain()` to avoid timing flakiness:

```python
import logging
import time

import pytest

from opslane.transport import Transport, RetryableSendError, FatalSendError


def make_transport(send_fn, **kw):
    t = Transport(endpoint="https://x.example", api_key="k", **kw)
    t._send_fn = send_fn          # test seam; production default is _http_send
    t._thread_enabled = False     # tests drive _drain() directly
    return t


def test_send_success_drains_queue():
    sent = []
    t = make_transport(lambda p: sent.append(p))
    t.enqueue({"n": 1})
    t.enqueue({"n": 2})
    t._drain()
    assert [p["n"] for p in sent] == [1, 2]
    assert t.queue_size() == 0


def test_queue_cap_drops_oldest():
    sent = []
    t = make_transport(lambda p: sent.append(p), queue_size=3)
    for i in range(5):
        t.enqueue({"n": i})
    for _ in range(3):
        t._drain()
    # Not just emptiness: the SURVIVORS are the newest three; 0 and 1 dropped.
    assert [p["n"] for p in sent] == [2, 3, 4]
    assert t.queue_size() == 0


def test_rate_limit_drops_at_enqueue(caplog):
    t = make_transport(lambda p: None, max_events_per_minute=2)
    with caplog.at_level(logging.WARNING, logger="opslane"):
        for i in range(5):
            t.enqueue({"n": i})
    assert t.queue_size() == 2
    assert any("rate limit" in r.message for r in caplog.records)


def test_retryable_failure_requeues_with_backoff():
    calls = []

    def failing(p):
        calls.append(p)
        raise RetryableSendError(status=503)

    t = make_transport(failing)
    t.enqueue({"n": 1})
    t._drain()
    assert len(calls) == 1
    assert t.queue_size() == 1            # requeued
    assert t._backoff_until > time.monotonic()


def test_fatal_failure_drops_immediately(caplog):
    def fatal(p):
        raise FatalSendError(status=401)

    t = make_transport(fatal)
    with caplog.at_level(logging.WARNING, logger="opslane"):
        t.enqueue({"n": 1})
        t._drain()
    assert t.queue_size() == 0
    assert any("401" in r.message for r in caplog.records)


def test_max_attempts_then_drop():
    def failing(p):
        raise RetryableSendError(status=503)

    t = make_transport(failing, max_attempts=3)
    t.enqueue({"n": 1})
    for _ in range(10):
        t._backoff_until = 0.0            # neutralize backoff for the test
        t._drain()
    assert t.queue_size() == 0            # dropped after 3 attempts, not spinning


def test_failing_event_does_not_block_successors():
    sent = []

    def selective(p):
        if p["n"] == 1:
            raise RetryableSendError(status=503)
        sent.append(p)

    t = make_transport(selective, max_attempts=2)
    t.enqueue({"n": 1})
    t.enqueue({"n": 2})
    for _ in range(5):
        t._backoff_until = 0.0
        t._drain()
    assert [p["n"] for p in sent] == [2]


def test_retry_after_overrides_backoff():
    def failing(p):
        raise RetryableSendError(status=429, retry_after=42.0)

    t = make_transport(failing)
    t.enqueue({"n": 1})
    before = time.monotonic()
    t._drain()
    assert t._backoff_until == pytest.approx(before + 42.0, abs=1.0)


def test_retry_after_capped_at_60():
    def failing(p):
        raise RetryableSendError(status=429, retry_after=3600.0)

    t = make_transport(failing)
    t.enqueue({"n": 1})
    before = time.monotonic()
    t._drain()
    assert t._backoff_until <= before + 61.0


def test_flush_returns_true_on_empty_and_false_on_stuck():
    t = make_transport(lambda p: None)
    assert t.flush(timeout=0.2) is True

    def failing(p):
        raise RetryableSendError(status=503)

    t2 = make_transport(failing)
    t2.enqueue({"n": 1})
    assert t2.flush(timeout=0.3) is False


def test_flush_does_not_defeat_retry_after():
    # A flush that clears backoff would burn all attempts in milliseconds,
    # drop the event, and report a "successful" drain. Backoff is honored.
    def failing(p):
        raise RetryableSendError(status=429, retry_after=30.0)

    t = make_transport(failing)
    t.enqueue({"n": 1})
    t._drain()
    before = t._backoff_until
    assert t.flush(timeout=0.2) is False
    assert t._backoff_until == before


def test_enqueue_never_raises():
    def exploding(p):
        raise RuntimeError("unexpected")

    t = make_transport(exploding)
    t.enqueue({"n": 1})
    t._drain()                             # unexpected errors are caught+logged
    assert t.queue_size() == 0


def test_fork_reset_reinitializes_state():
    t = make_transport(lambda p: None)
    t.enqueue({"n": 1})
    t._reset_after_fork()          # what os.register_at_fork runs in the child
    assert t.queue_size() == 0     # inherited events belong to the parent
    t.enqueue({"n": 2})            # child transport works immediately, fresh locks
    assert t.queue_size() == 1
```

Run → FAIL.

**Step 2: Implement** — `opslane/transport.py`:

```python
"""Background HTTP transport for error events.

Contract (design doc §2): bounded queue (oldest dropped), 5s drain cycle of up
to 10 events, one 5s total HTTP timeout (urllib exposes a single timeout),
retry only network/429/5xx with exponential backoff + jitter capped at 60s,
Retry-After override (capped 60s), other 4xx dropped immediately, max 5
attempts per event, client-side rate limit at enqueue, diagnostics via the
'opslane' stdlib logger, flush(timeout)->bool never raises, lazy daemon thread
with PID check for post-fork safety. Transport failures never propagate to
application code.
"""
import json
import logging
import os
import queue
import random
import threading
import time
import urllib.error
import urllib.request
import weakref
from collections import deque

logger = logging.getLogger("opslane")

DRAIN_INTERVAL = 5.0
BATCH_SIZE = 10
MAX_BACKOFF = 60.0


class RetryableSendError(Exception):
    """Network error, 429, or 5xx. Optionally carries Retry-After seconds."""

    def __init__(self, status=None, retry_after=None):
        super().__init__(f"retryable send failure (status={status})")
        self.status = status
        self.retry_after = retry_after


class FatalSendError(Exception):
    """Non-retryable 4xx (bad key, malformed event). The event is dropped."""

    def __init__(self, status):
        super().__init__(f"fatal send failure (status={status})")
        self.status = status


class Transport:
    def __init__(
        self,
        endpoint,
        api_key,
        max_events_per_minute=100,
        http_timeout=5.0,
        queue_size=100,
        max_attempts=5,
    ):
        self._endpoint = endpoint.rstrip("/") + "/api/v1/events"
        self._api_key = api_key
        self._http_timeout = http_timeout
        self._queue_size = queue_size
        self._max_attempts = max_attempts
        self._max_per_minute = max_events_per_minute

        self._queue = queue.Queue(maxsize=queue_size)  # items: [payload, attempts]
        self._sent_stamps = deque()
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread = None
        self._pid = None
        self._backoff_until = 0.0
        self._in_flight = False
        self._send_fn = self._http_send
        self._thread_enabled = True  # tests set False and drive _drain() directly

        # Fork safety: PID checks alone are insufficient — inherited locks may
        # have been HELD by parent threads that don't exist in the child, so
        # first touch would deadlock. register_at_fork rebuilds all sync
        # primitives in the child before anything uses them. weakref so a
        # replaced transport can be collected. POSIX-only (fork is too).
        if hasattr(os, "register_at_fork"):
            self_ref = weakref.ref(self)

            def _after_fork_in_child():
                t = self_ref()
                if t is not None:
                    t._reset_after_fork()

            os.register_at_fork(after_in_child=_after_fork_in_child)

    # -- public ----------------------------------------------------------

    def enqueue(self, payload):
        """Queue an event for delivery. Never raises, never blocks.

        Order matters: the thread/fork check runs BEFORE the put, so the
        event lands in the queue that will actually be drained (a put into
        an inherited pre-fork queue would be silently lost on replacement).
        """
        try:
            self._ensure_thread()
            if not self._rate_limit_exceeded():
                logger.warning("opslane: client-side rate limit hit; event dropped")
                return
            self._put_dropping_oldest([payload, 0])
            self._record_admission()
            self._wake.set()
        except Exception:
            logger.warning("opslane: enqueue failed; event dropped", exc_info=True)

    def flush(self, timeout=5.0):
        """Drain the queue. Returns True if fully drained in time. Never raises.

        Honors active backoff — flush must NOT reset pacing (that would defeat
        Retry-After, burn the attempt budget in milliseconds, drop the event,
        and then report a "successful" drain). Under backoff longer than the
        timeout this correctly returns False: best-effort, honestly reported.
        """
        try:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                with self._lock:
                    if self._queue.empty() and not self._in_flight:
                        return True
                if self._thread_enabled and not self._queue.empty():
                    self._ensure_thread()
                self._wake.set()
                time.sleep(0.05)
            with self._lock:
                return self._queue.empty() and not self._in_flight
        except Exception:
            logger.warning("opslane: flush failed", exc_info=True)
            return False

    def queue_size(self):
        return self._queue.qsize()

    # -- internals -------------------------------------------------------

    def _reset_after_fork(self):
        """Rebuild every synchronization primitive in the forked child.

        Inherited queue contents belong to the parent (it still owns them);
        inherited locks may be held by threads that no longer exist here.
        """
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._queue = queue.Queue(maxsize=self._queue_size)
        self._sent_stamps = deque()
        self._thread = None
        self._pid = None
        self._in_flight = False
        self._backoff_until = 0.0
        logger.debug("opslane: fork detected; transport state reinitialized")

    def _rate_limit_exceeded(self):
        # Admission-time accounting: the stamp is recorded only after the put
        # succeeds (_record_admission), so rejected events don't consume
        # budget. Known approximation, accepted: an admitted event later
        # displaced by queue overflow is not refunded.
        now = time.monotonic()
        with self._lock:
            while self._sent_stamps and now - self._sent_stamps[0] > 60.0:
                self._sent_stamps.popleft()
            return len(self._sent_stamps) < self._max_per_minute

    def _record_admission(self):
        with self._lock:
            self._sent_stamps.append(time.monotonic())

    def _put_dropping_oldest(self, item):
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            try:
                self._queue.get_nowait()
                logger.warning("opslane: queue full; oldest event dropped")
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(item)
            except queue.Full:
                logger.warning("opslane: queue full; event dropped")

    def _ensure_thread(self):
        if not self._thread_enabled:
            self._pid = self._pid or os.getpid()
            return
        with self._lock:
            pid = os.getpid()
            if self._thread is not None and self._thread.is_alive() and self._pid == pid:
                return
            self._pid = pid
            self._thread = threading.Thread(
                target=self._run, name="opslane-transport", daemon=True
            )
            self._thread.start()

    def _run(self):
        while True:
            self._wake.wait(timeout=DRAIN_INTERVAL)
            self._wake.clear()
            try:
                self._drain()
            except Exception:  # the loop must survive anything
                logger.warning("opslane: drain error", exc_info=True)

    def _drain(self):
        for _ in range(BATCH_SIZE):
            if time.monotonic() < self._backoff_until:
                return
            # Dequeue and mark in-flight under ONE lock so flush() can never
            # observe the empty-queue/not-in-flight gap mid-send.
            with self._lock:
                try:
                    item = self._queue.get_nowait()
                except queue.Empty:
                    return
                self._in_flight = True
            payload, attempts = item
            try:
                self._send_fn(payload)
            except RetryableSendError as e:
                attempts += 1
                if attempts >= self._max_attempts:
                    logger.warning(
                        "opslane: event dropped after %d attempts (status=%s)",
                        attempts, e.status,
                    )
                else:
                    self._put_dropping_oldest([payload, attempts])
                    delay = e.retry_after if e.retry_after is not None else (
                        min(MAX_BACKOFF, 2 ** attempts) * (0.5 + random.random() / 2)
                    )
                    self._backoff_until = time.monotonic() + min(MAX_BACKOFF, delay)
                    logger.debug("opslane: retrying in %.1fs", min(MAX_BACKOFF, delay))
            except FatalSendError as e:
                logger.warning("opslane: event rejected (status=%s); dropped", e.status)
            except Exception:
                logger.warning("opslane: unexpected send error; event dropped", exc_info=True)
            finally:
                with self._lock:
                    self._in_flight = False

    def _http_send(self, payload):
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self._endpoint,
            data=body,
            headers={"Content-Type": "application/json", "X-API-Key": self._api_key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._http_timeout):
                pass
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                retry_after = None
                try:
                    header = e.headers.get("Retry-After") if e.headers else None
                    if header is not None:
                        retry_after = float(header)
                except (TypeError, ValueError):
                    retry_after = None
                raise RetryableSendError(status=e.code, retry_after=retry_after) from e
            raise FatalSendError(status=e.code) from e
        except urllib.error.URLError as e:
            raise RetryableSendError() from e
```

**Step 3:** `.venv/bin/pytest tests/test_transport.py -v` → all pass; full suite green.

**Step 4: One real-HTTP integration test** (appended to `test_transport.py`) — spin up `http.server` in a thread returning 202, enqueue with `_thread_enabled` left True, `flush()`, assert the server received a POST with `X-API-Key` and the JSON body. Write it, run it, see it pass.

**Step 5: Commit**

```bash
git add packages/sdk-python
git commit -m "feat(sdk-python): background transport with full retry contract (#87)"
```

---

### Task 10: Public API wiring (`opslane.init` et al.)

**Files:**
- Create: `packages/sdk-python/tests/test_public_api.py`
- Modify: `packages/sdk-python/opslane/__init__.py`
- Modify: `packages/sdk-python/pyproject.toml` — bump `version = "0.1.0a2"` **in the same commit** as `__version__`; `test_version_matches_distribution_metadata` fails on any mismatch (then `pip install -e '.[dev]'` again to refresh metadata)
- Modify: `packages/sdk-python/tests/test_package.py`

**Step 1: Failing tests** — `tests/test_public_api.py`:

```python
import logging

import opslane
from opslane import _state


class StubTransport:
    def __init__(self):
        self.sent = []
        self.flushed = False

    def enqueue(self, payload):
        self.sent.append(payload)

    def flush(self, timeout=5.0):
        self.flushed = True
        return True


def setup_function(_fn):
    _state.client = None  # reset the singleton between tests


def _init_with_stub(**kw):
    opslane.init(api_key="k", endpoint="https://x.example", **kw)
    _state.client.transport = StubTransport()
    return _state.client.transport


def test_capture_before_init_warns_and_drops(caplog):
    with caplog.at_level(logging.WARNING, logger="opslane"):
        opslane.capture_exception(ValueError("x"))  # must not raise
    assert any("init" in r.message for r in caplog.records)


def test_init_then_capture():
    transport = _init_with_stub()
    try:
        raise ValueError("boom")
    except ValueError as e:
        opslane.capture_exception(e)
    assert transport.sent[-1]["error"]["type"] == "ValueError"


def test_set_and_clear_user_flow():
    transport = _init_with_stub()
    opslane.set_user({"id": "u1"})
    try:
        raise ValueError("boom")
    except ValueError as e:
        opslane.capture_exception(e)
    assert transport.sent[-1]["context"]["user"]["id"] == "u1"
    opslane.clear_user()
    try:
        raise ValueError("boom2")
    except ValueError as e:
        opslane.capture_exception(e)
    assert "user" not in transport.sent[-1]["context"]


def test_reinit_warns_flushes_old_client_and_replaces(caplog):
    transport = _init_with_stub()
    first = _state.client
    with caplog.at_level(logging.WARNING, logger="opslane"):
        opslane.init(api_key="k2", endpoint="https://y.example")
    assert _state.client is not first
    assert transport.flushed    # old queue drained, not silently abandoned
    assert any("already initialized" in r.message for r in caplog.records)


def test_flush_without_init_is_true():
    assert opslane.flush(timeout=0.1) is True
```

Also update `tests/test_package.py`: delete `test_api_fails_loudly_until_implemented` and `test_flask_integration_fails_loudly` (their Batch 0 purpose — honesty about the scaffold — is fulfilled by the real implementation; the remaining smoke tests still pin the surface).

Run → FAIL.

**Step 2: Implement** — replace `opslane/__init__.py`:

```python
"""Opslane Python SDK — backend error capture for the Opslane engine.

    import opslane
    opslane.init(api_key="...", endpoint="https://ingest.example.com")
    opslane.set_user({"id": "user-123"})
    opslane.capture_exception(exc)
    opslane.flush()

Flask apps: `from opslane.integrations.flask import OpslaneFlask; OpslaneFlask(app)`.
"""
import atexit
import logging
import threading

from opslane import context as _context

__version__ = "0.1.0a2"

__all__ = ["init", "set_user", "clear_user", "capture_exception", "flush"]

logger = logging.getLogger("opslane")


class _State:
    def __init__(self):
        self.client = None
        self.lock = threading.Lock()
        self.atexit_registered = False


_state = _State()


def init(api_key, endpoint, release=None, **options):
    """Configure the SDK. Call once, post-fork (in the app factory under
    Gunicorn). Calling again drains the old client, then replaces it.

    Known limitation (documented, accepted): atexit runs LIFO, so callbacks
    registered BEFORE opslane.init() run after our flush — events they
    capture are lost. Register opslane early.
    """
    from opslane.client import Client

    with _state.lock:
        old = _state.client
        if old is not None:
            logger.warning("opslane: already initialized; replacing client")
        _state.client = Client(
            api_key=api_key, endpoint=endpoint, release=release, **options
        )
        if not _state.atexit_registered:
            atexit.register(flush)
            _state.atexit_registered = True
    if old is not None:
        # Best-effort drain OUTSIDE the lock — the old queue and its daemon
        # thread would otherwise be silently abandoned with events aboard.
        old.transport.flush(timeout=2.0)


def set_user(user):
    """Attach user context (dict with at least 'id') to subsequent events."""
    _context.set_user(user)


def clear_user():
    """Clear user context."""
    _context.clear_user()


def capture_exception(exc):
    """Capture a handled exception. Never raises; warns if init() wasn't called."""
    client = _state.client
    if client is None:
        logger.warning("opslane: capture_exception before init(); event dropped")
        return
    try:
        client.capture_exception(exc)
    except Exception:
        logger.warning("opslane: capture failed", exc_info=True)


def flush(timeout=5.0):
    """Drain pending events. Returns True if the queue fully drained."""
    client = _state.client
    if client is None:
        return True
    return client.transport.flush(timeout=timeout)
```

**Step 3:** `.venv/bin/pytest -v` → whole suite passes.

**Step 4: Commit**

```bash
git add packages/sdk-python
git commit -m "feat(sdk-python): wire public API to client and transport (#87)"
```

---

### Task 11: Flask integration

**Files:**
- Create: `packages/sdk-python/tests/test_flask_integration.py`
- Modify: `packages/sdk-python/opslane/integrations/flask.py`

**Step 1: Failing tests** — the design's capture-semantics table, verbatim:

```python
import logging

import pytest
from flask import Flask, abort

import opslane
from opslane import _state
from opslane.integrations.flask import OpslaneFlask


class StubTransport:
    def __init__(self):
        self.sent = []

    def enqueue(self, payload):
        self.sent.append(payload)

    def flush(self, timeout=5.0):
        return True


@pytest.fixture
def app_and_transport():
    _state.client = None
    opslane.init(api_key="k", endpoint="https://x.example")
    transport = StubTransport()
    _state.client.transport = transport

    app = Flask(__name__)
    app.config["PROPAGATE_EXCEPTIONS"] = False  # exercise real error paths
    OpslaneFlask(app)

    @app.get("/boom")
    def boom():
        raise ValueError("seeded failure")

    @app.get("/handled")
    def handled():
        raise KeyError("recovered")

    @app.errorhandler(KeyError)
    def recover(e):
        return {"recovered": True}, 200

    @app.errorhandler(500)
    def custom_500(e):
        return {"custom_500": True}, 500

    @app.get("/gone")
    def gone():
        abort(404)

    @app.get("/explicit")
    def explicit():
        try:
            raise RuntimeError("looked after")
        except RuntimeError as e:
            opslane.capture_exception(e)
        return {"ok": True}

    @app.get("/warn")
    def warn():
        app.logger.warning("token near expiry")
        raise ValueError("with breadcrumb")

    @app.get("/who")
    def who():
        opslane.set_user({"id": "u-req"})
        raise ValueError("user attached")

    return app, transport


def test_unhandled_exception_captured(app_and_transport):
    app, transport = app_and_transport
    resp = app.test_client().get("/boom", headers={"Authorization": "Bearer s3cr3t"})
    assert resp.status_code == 500          # Flask's error response is untouched
    assert len(transport.sent) == 1
    payload = transport.sent[0]
    assert payload["error"]["type"] == "ValueError"
    req = payload["context"]["request"]
    assert req["method"] == "GET" and req["path"] == "/boom"
    assert "authorization" not in req["headers"]
    assert payload["context"]["url"] == "GET /boom"
    # request breadcrumb is first
    assert payload["breadcrumbs"][0]["type"] == "http"
    assert payload["breadcrumbs"][0]["message"] == "GET /boom"


def test_errorhandler_recovered_not_captured(app_and_transport):
    app, transport = app_and_transport
    resp = app.test_client().get("/handled")
    assert resp.status_code == 200
    assert transport.sent == []             # design: recovered => not captured


def test_custom_500_handler_still_captured(app_and_transport):
    # The signal fires before a 500 handler renders: the exception WAS
    # unhandled; the handler only shapes the response. Capture is correct.
    app, transport = app_and_transport
    resp = app.test_client().get("/boom")
    assert resp.get_json() == {"custom_500": True}
    assert len(transport.sent) == 1


def test_http_exception_not_captured(app_and_transport):
    app, transport = app_and_transport
    assert app.test_client().get("/gone").status_code == 404
    assert transport.sent == []


def test_explicit_capture_works(app_and_transport):
    app, transport = app_and_transport
    assert app.test_client().get("/explicit").status_code == 200
    assert len(transport.sent) == 1
    assert transport.sent[0]["error"]["type"] == "RuntimeError"


def test_log_breadcrumbs_at_warning(app_and_transport):
    app, transport = app_and_transport
    app.test_client().get("/warn")
    crumbs = transport.sent[0]["breadcrumbs"]
    logs = [c for c in crumbs if c["type"] == "log"]
    assert logs and logs[0]["message"] == "token near expiry"
    assert logs[0]["level"] == "warning"


def test_user_scoped_to_request(app_and_transport):
    app, transport = app_and_transport
    app.test_client().get("/who")
    assert transport.sent[0]["context"]["user"]["id"] == "u-req"
    app.test_client().get("/boom")
    assert "user" not in transport.sent[1]["context"]  # no bleed across requests


def test_double_wrap_is_noop(app_and_transport):
    app, transport = app_and_transport
    OpslaneFlask(app)                        # second wrap: warn, don't double-hook
    app.test_client().get("/boom")
    assert len(transport.sent) == 1          # not two
```

Run → FAIL (`NotImplementedError`).

**Step 2: Implement** — replace `opslane/integrations/flask.py`:

```python
"""Flask integration: signal-based capture, request breadcrumbs, log breadcrumbs.

Capture contract (design doc §3): only genuinely unhandled exceptions —
Flask emits got_request_exception solely from handle_exception, which runs
only when no user error handler recovered the exception. Recovered
exceptions and HTTPExceptions are the app's business; use
opslane.capture_exception() to record them. Nuance: a registered
@app.errorhandler(500) / InternalServerError handler runs AFTER the signal,
so those exceptions are (correctly) still captured — the error was
unhandled; the 500 handler only renders the response. The event snapshot is
fully serialized at signal time, before response finalization, so there is
no response breadcrumb (a request-scoped buffer could never carry one
anyway).

Log breadcrumbs: the handler is attached to app.logger and sees only records
that logger EMITS — if the app configures app.logger above WARNING, no log
breadcrumbs are captured. That is the app's logging policy; the SDK does not
override logger levels.
"""
import logging
from datetime import datetime, timezone

from flask import g, request
from flask.signals import got_request_exception

import opslane
from opslane import context as _context
from opslane.client import map_log_level

logger = logging.getLogger("opslane")

_EXTENSION_KEY = "opslane"
_TOKENS_KEY = "_opslane_scope_tokens"


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


class _BreadcrumbLogHandler(logging.Handler):
    def emit(self, record):
        try:
            _context.add_breadcrumb({
                "type": "log",
                "timestamp": _now_iso(),
                "category": record.name,
                "level": map_log_level(record.levelname),
                "message": record.getMessage(),
            })
        except Exception:  # a logging hook must never break the app
            pass


class OpslaneFlask:
    """One-line Flask integration: `OpslaneFlask(app)`."""

    def __init__(self, app, log_level=logging.WARNING):
        if app.extensions.get(_EXTENSION_KEY):
            logger.warning("opslane: app already wrapped; ignoring second OpslaneFlask")
            return
        app.extensions[_EXTENSION_KEY] = self

        app.before_request(self._before_request)
        app.teardown_request(self._teardown_request)
        # Weak-referenced by default; keep a strong ref via connect(weak=False)
        # so the hook survives this constructor's scope.
        got_request_exception.connect(self._on_exception, app, weak=False)

        self._log_handler = _BreadcrumbLogHandler(level=log_level)
        app.logger.addHandler(self._log_handler)

    def _before_request(self):
        if getattr(g, _TOKENS_KEY, None) is not None:
            return  # scope already pushed for this request context
        meta = {
            "method": request.method,
            "path": request.path,
            "headers": dict(request.headers),
            "remote_addr": request.remote_addr,
        }
        # NOT g.setdefault(key, push_scope(...)): setdefault evaluates its
        # default eagerly, pushing a second scope and orphaning its tokens.
        setattr(g, _TOKENS_KEY, _context.push_scope(meta))
        _context.add_breadcrumb({
            "type": "http",
            "timestamp": _now_iso(),
            "category": "request",
            "message": f"{request.method} {request.path}",
            "data": {
                "method": request.method,
                "path": request.path,
                "content_type": request.content_type or "",
            },
        })

    def _teardown_request(self, exc):
        tokens = g.pop(_TOKENS_KEY, None)
        if tokens is not None:
            _context.reset_scope(tokens)

    def _on_exception(self, sender, exception, **extra):
        opslane.capture_exception(exception)
```

**Step 3:** `.venv/bin/pytest tests/test_flask_integration.py -v` → all pass; full suite green.

**Step 4: Commit**

```bash
git add packages/sdk-python
git commit -m "feat(sdk-python): Flask integration with unhandled-only capture (#87)"
```

---

### Task 12: Gunicorn smoke test + design-doc timeout amendment

**Files:**
- Create: `packages/sdk-python/tests/test_gunicorn_smoke.py`
- Modify: `docs/plans/2026-07-17-python-sdk-design.md` (timeout note)

**Step 1: Write the smoke test** — spawns real Gunicorn workers serving a tiny SDK-wrapped app, with a mock ingestion server (stdlib `http.server` on an ephemeral port) capturing POSTs. Review-driven design points: no stderr parsing (a blocking `readline()` with no newline hangs forever, and the log format is not a contract) — the port is pre-selected and readiness is polled with request retries; teardown escalates terminate → kill; a second case runs `--preload` so `init()` happens PRE-fork and the `os.register_at_fork` recovery path is exercised for real:

```python
"""End-to-end smoke: Gunicorn -> SDK -> mock ingestion.

Two cases: post-fork init (the documented pattern) and --preload (init
before fork), which exercises the transport's at-fork state reset.
Skipped where gunicorn can't run (non-POSIX).
"""
import json
import os
import socket
import subprocess
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="gunicorn is POSIX-only")

APP_TEMPLATE = """
import opslane
from flask import Flask
from opslane.integrations.flask import OpslaneFlask

opslane.init(api_key="smoke-key", endpoint="http://127.0.0.1:{ingest_port}")
app = Flask(__name__)
OpslaneFlask(app)

@app.get("/boom")
def boom():
    raise ValueError("gunicorn smoke")
"""


def _free_port():
    # Bind-then-close; tiny reuse race is acceptable for a test.
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _terminate(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


@pytest.fixture
def capture_server():
    received = []

    class _Capture(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            received.append((self.path, dict(self.headers), json.loads(body)))
            self.send_response(202)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), _Capture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1], received
    server.shutdown()


@pytest.mark.parametrize("preload", [False, True], ids=["postfork", "preload"])
def test_gunicorn_worker_delivers_events(tmp_path, capture_server, preload):
    ingest_port, received = capture_server
    (tmp_path / "smoke_app.py").write_text(
        textwrap.dedent(APP_TEMPLATE.format(ingest_port=ingest_port))
    )

    port = _free_port()
    args = [sys.executable, "-m", "gunicorn", "--workers", "1",
            "--bind", f"127.0.0.1:{port}", "smoke_app:app"]
    if preload:
        args.insert(-1, "--preload")   # init() runs PRE-fork: at-fork reset path
    proc = subprocess.Popen(args, cwd=tmp_path,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        # Readiness = a request succeeds; retry until deadline, no log parsing.
        deadline = time.time() + 20
        status = None
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/boom", timeout=3)
            except urllib.error.HTTPError as e:
                status = e.code
                break
            except (urllib.error.URLError, ConnectionError, OSError):
                time.sleep(0.25)
        assert status == 500, f"gunicorn never answered /boom (last={status})"

        deadline = time.time() + 10
        while time.time() < deadline and not received:
            time.sleep(0.2)
        assert received, "no event arrived at mock ingestion"
        path, headers, payload = received[0]
        assert path == "/api/v1/events"
        assert headers.get("X-API-Key") == "smoke-key"
        assert payload["platform"] == "python"
        assert payload["error"]["type"] == "ValueError"
    finally:
        _terminate(proc)
```

Run: `.venv/bin/pytest tests/test_gunicorn_smoke.py -v` → 1 passed (it runs in CI's linux matrix too).

**Step 2: Amend the design doc** — in §2 Transport contract, replace the "3s connect, 5s read" line with: "One 5s total timeout (configurable via `init(http_timeout=...)`) — stdlib `urllib.request` exposes a single timeout, not separate connect/read phases."

**Step 3: Commit**

```bash
git add packages/sdk-python docs/plans/2026-07-17-python-sdk-design.md
git commit -m "test(sdk-python): gunicorn post-fork delivery smoke (#87)"
```

---

## Part C — Contract + end-to-end

### Task 13: Frozen Python wire fixtures, generated from the real SDK

**Files:**
- Create: `test-fixtures/wire/events/python-v0.1.0a2-minimal.json`
- Create: `test-fixtures/wire/events/python-v0.1.0a2-full.json`
- Create: `packages/sdk-python/tests/test_wire_shape.py`
- Modify: `test-fixtures/wire/events/README.md` (append provenance lines — README is not a frozen fixture)

**Step 1: Write the wire-shape test** (it both generates and then locks the fixtures — mirroring `packages/sdk/src/__tests__/wire-shape.test.ts`).

Review-driven fixture rule: **fixtures contain only real, replayable values** — a genuine RFC3339 timestamp, a realistic frozen Python traceback, a pinned runtime version. Sentinel placeholders like `<TS>` would fail the compat test's RFC3339 parsing, and a `<STACK>` placeholder would mean the server replay never exercises the Python traceback parser (the very thing the fixture exists to lock). Volatile fields are normalized **to those same frozen constants** on the SDK side before comparison — the frozen file itself is valid wire JSON end to end.

```python
"""The SDK's real payload must match the frozen python-v* wire fixtures.

Volatile per-run fields (timestamp, traceback text, interpreter version,
user agent) are replaced with FROZEN REALISTIC constants before comparison;
the rest of the payload is byte-for-byte contract. The frozen files are
valid wire payloads — the Go compat test replays them against the real
handler, exercising the Python traceback parser.

To generate for a NEW SDK version (never edit existing files):
    OPSLANE_WRITE_FIXTURES=1 .venv/bin/pytest tests/test_wire_shape.py
"""
import json
import os
import pathlib

import opslane
from opslane import context as ctx
from opslane.client import Client

FIXTURES = pathlib.Path(__file__).resolve().parents[3] / "test-fixtures" / "wire" / "events"
VERSION = opslane.__version__

FROZEN_TS = "2026-07-18T00:00:00.000Z"
FROZEN_STACK = (
    "Traceback (most recent call last):\n"
    '  File "/app/api/routes/users.py", line 42, in get_user\n'
    "    user = db.query(User).filter_by(id=user_id).one()\n"
    "ValueError: No row was found\n"
)
FROZEN_PYVER = "3.12.1"
FROZEN_UA = f"Python/{FROZEN_PYVER} opslane/{VERSION}"


class StubTransport:
    def __init__(self):
        self.sent = []

    def enqueue(self, payload):
        self.sent.append(payload)


def _freeze_volatile(payload):
    """Replace per-run values with frozen REALISTIC constants (never sentinels
    — the fixture must stay a valid, parseable wire payload)."""
    payload = json.loads(json.dumps(payload))
    payload["timestamp"] = FROZEN_TS
    payload["error"]["stack"] = FROZEN_STACK
    payload["runtime"]["version"] = FROZEN_PYVER
    payload["context"]["user_agent"] = FROZEN_UA
    for crumb in payload["breadcrumbs"]:
        crumb["timestamp"] = FROZEN_TS
    return payload


def _build(full: bool):
    client = Client(api_key="k", endpoint="https://x.example",
                    release="v1.2.3" if full else None, transport=StubTransport())
    tokens = ctx.push_scope({
        "method": "GET", "path": "/api/users/123",
        "headers": {"Content-Type": "application/json"},
        "remote_addr": "10.0.1.50",
    } if full else None)
    try:
        if full:
            ctx.set_user({"id": "user-123", "email": "jane@example.com",
                          "account": {"id": "acct-42", "name": "Example Inc"}})
            ctx.add_breadcrumb({"type": "log", "timestamp": FROZEN_TS,
                                "category": "app.auth", "level": "warning",
                                "message": "Token near expiry"})
        try:
            raise ValueError("No row was found")
        except ValueError as e:
            client.capture_exception(e)
    finally:
        ctx.reset_scope(tokens)   # a failure above must not poison later tests
    return _freeze_volatile(client.transport.sent[0])


def _check(name: str, payload: dict):
    path = FIXTURES / f"python-v{VERSION}-{name}.json"
    if os.environ.get("OPSLANE_WRITE_FIXTURES") == "1" and not path.exists():
        path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
    frozen = json.loads(path.read_text())
    assert payload == frozen, f"SDK output diverged from frozen fixture {path.name}"


def test_minimal_matches_fixture():
    _check("minimal", _build(full=False))


def test_full_matches_fixture():
    _check("full", _build(full=True))
```

**Step 2: Generate the fixtures once, then verify they're locked**

```bash
cd packages/sdk-python
OPSLANE_WRITE_FIXTURES=1 .venv/bin/pytest tests/test_wire_shape.py -v   # writes both files
.venv/bin/pytest tests/test_wire_shape.py -v                            # now passes read-only
```

Inspect both generated files by eye against the design's payload example (platform, runtime, context.request, lowercase levels, message on every breadcrumb, no nulls for absent fields, and the stack is the realistic frozen traceback).

**Step 3: Extend `wire_compat_test.go` for the Python fixtures, then replay everything**

The compat test compares stored context **exactly** against the fixture's context and models neither `platform` nor `runtime` — the Python fixtures would fail round-trip without these extensions (Task 5 folds `runtime` INTO stored context):

- Add `Platform string` and `Runtime json.RawMessage` fields to the `wireFixture` struct.
- Where stored context is compared: when the fixture has a top-level `runtime`, the expected stored context is the fixture's context **plus** the folded `runtime` key.
- Add assertions: stored `error_events.platform` and the group's `platform` equal the fixture's `platform` (default `javascript` when absent) — so persistence can't regress unnoticed.

Then replay with the real test names (there is no `TestWireCompat`; the suite is `TestWireFixtures_*`) against the Task 5 database:

```bash
export DATABASE_URL=postgres://opslane:x@localhost:5499/opslane
cd packages/ingestion && go test ./handler -run 'TestWireFixtures' -v
```

Expected: PASS including both python fixtures (202 + stored round-trip + platform assertions), and the output shows the python fixture subtests actually RAN. If the compat test asserts other fields the python fixtures lack (e.g. `session_id`), extend the per-fixture expectations following its existing pattern — do not change the fixtures to appease the test.

**Step 4: Update the README** — two changes, then commit: append provenance lines for both python fixtures (how they were produced, mirroring existing entries), and amend the naming rule itself to document the platform prefix (`v<version>-*.json` for the browser SDK, `python-v<version>-*.json` for the Python SDK) — the rule text must match what the directory actually contains. The README is not a frozen fixture; editing it is fine:

```bash
git add test-fixtures/wire/events packages/sdk-python/tests/test_wire_shape.py
git commit -m "feat(wire): frozen python-v0.1.0a2 event fixtures from real SDK output (#87)"
```

---

### Task 14: Live Compose smoke — Flask error to Postgres row

**Step 1: Boot the stack** (shared-port caution: 5434/8082 may be in use by other worktree sessions — check `docker ps` first; coordinate rather than clobber):

```bash
docker compose up -d postgres minio minio-setup
docker compose run --rm migrate
docker compose up -d --build --wait ingestion
psql "postgres://opslane:opslane_dev@localhost:5434/opslane" -f scripts/seed-e2e.sql
```

(The seed creates a project + API key — read `scripts/seed-e2e.sql` for the key value.)

**Step 2: Fire a real SDK-captured error at it** — the error message carries a per-run identifier so the verification queries can't match leftover rows from earlier runs against this shared database:

```bash
# Letters-only id: the fingerprint normalizer collapses digits/hex/UUIDs, so a
# numeric id would make every run's events fingerprint identically and join
# ONE cross-run group, breaking the exactly-one-new-group assertion below.
export SMOKE_ID="smoke$(LC_ALL=C tr -dc 'a-z' </dev/urandom | head -c 8)"
cd packages/sdk-python && .venv/bin/python - <<EOF
import os
import opslane
from flask import Flask
from opslane.integrations.flask import OpslaneFlask

opslane.init(api_key="<KEY-FROM-SEED>", endpoint="http://localhost:8082")
app = Flask(__name__)
OpslaneFlask(app)

@app.get("/boom")
def boom():
    raise ValueError("live smoke failure ${SMOKE_ID}")

client = app.test_client()
client.get("/boom")
client.get("/boom")            # second occurrence: must join the same group
assert opslane.flush(timeout=10), "flush did not drain"
print("sent ${SMOKE_ID}")
EOF
```

**Step 3: Verify the database state — assert, don't eyeball**

```bash
EVENTS=$(psql -t -A "postgres://opslane:opslane_dev@localhost:5434/opslane" -c \
  "SELECT count(*) FROM error_events WHERE platform='python' AND context ? 'runtime' AND error_message LIKE '%${SMOKE_ID}%';")
GROUPS=$(psql -t -A "postgres://opslane:opslane_dev@localhost:5434/opslane" -c \
  "SELECT count(*) || ':' || COALESCE(max(occurrence_count),0) FROM error_groups WHERE platform='python' AND title LIKE '%${SMOKE_ID}%';")
echo "events=$EVENTS groups=$GROUPS"
[ "$EVENTS" = "2" ] && [ "$GROUPS" = "1:2" ] && echo "LIVE SMOKE PASS" || echo "LIVE SMOKE FAIL"
```

Expected: `events=2 groups=1:2` then `LIVE SMOKE PASS` — exactly two THIS-run events with `platform=python` and folded runtime, in exactly ONE group with `occurrence_count=2`. This is Batch 1's acceptance gate observed live: same-run events group together (identical message + stack), while the letters-only run id keeps each run's group distinct from earlier runs' leftovers.

**Step 4: Tear down** (only what this smoke started; leave shared services if another session owns them):

```bash
docker compose down
```

---

### Task 15: Full verification + close out #87

**Step 1: The complete gate, in order**

```bash
pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go vet ./... && go test ./...)
(cd packages/sdk-python && .venv/bin/pytest -v)
docker compose config --quiet
```

All green, plus the Task 14 live-smoke evidence.

**Step 2: Deployment-gate note** — Batch 1's rollout precondition (from the design): `error_groups` must be empty in production at deploy time, or a fingerprint backfill ships in the same release. Verify against the actual prod DB is the user's call; record in the PR description:
> Deployment gate: fingerprints are re-keyed (platform prefix). Confirmed `SELECT count(*) FROM error_groups` = 0 in prod before deploy, per design doc.

**Step 3: Push (user), PR, and close**

Ask the user to `! git push`; open the PR referencing #87 with the acceptance-criteria checklist filled in with real evidence (test output, live-smoke rows). Close #87 only after merge, mirroring Batch 0's close-out discipline.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found → addressed | 31 findings (16 P1, 15 P2), 28 incorporated, 3 rejected with rationale |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**CODEX:** Two scoped passes (server-side Go/SQL, Python SDK). All P1s fixed in the plan: SQL args added to match placeholders, nil-map runtime-merge panic guarded + merged pre-redaction, platform defaulted inside `InsertErrorEventAndGroup`, fixtures redesigned to real frozen values (no sentinels), `TestWireFixtures` selector + `DATABASE_URL` gates, `os.register_at_fork` transport reset, enqueue-before-swap ordering, `_in_flight` under one lock, flush no longer defeats Retry-After, old-client drain on re-init, version sync `0.1.0a2`, Gunicorn smoke rewritten (no stderr parsing, kill fallback, `--preload` case). Rejected: JS fingerprint re-hash concern (settled user decision + deployment gate), Windows-path normalization and site-packages app-wheel handling (out of v1 scope).

**VERDICT:** CODEX ADDRESSED — plan revised; eng review not run (user-triggered if wanted).

NO UNRESOLVED DECISIONS
