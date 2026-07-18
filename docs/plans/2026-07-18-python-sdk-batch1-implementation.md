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

func TestPythonFrames_CapsAtFive(t *testing.T) {
	var b strings.Builder
	b.WriteString("Traceback (most recent call last):\n")
	for _, f := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		b.WriteString("  File \"/app/" + f + ".py\", line 1, in fn_" + f + "\n    x()\n")
	}
	b.WriteString("ValueError: x")
	if got := pythonFrames(b.String()); len(got) != 5 {
		t.Fatalf("expected 5 frames, got %d: %v", len(got), got)
	}
}
```

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
	// the worker's stack-trace mapping (Batch 3).
	rePyDeployPrefix = regexp.MustCompile(`^/(?:app|srv|opt|usr/src)/|^/home/[^/]+/`)
	rePyLibPath      = regexp.MustCompile(`(?:site-packages|dist-packages)/|/venv/|\.tox/|lib/python\d+(?:\.\d+)?/`)
)

var pyChainMarkers = []string{
	"During handling of the above exception, another exception occurred:",
	"The above exception was the direct cause of the following exception:",
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
		id := rePyDeployPrefix.ReplaceAllString(file, "") + ":" + strings.TrimSpace(fn)
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

Write them fully against the file's existing helpers (`postEvent`, DB assertions — mirror neighboring tests' style). Run: expected FAIL (platform column never written; no platform parsing).

**Step 2: Parse the new fields in `error_event.go`**

Add to the payload struct:

```go
Platform string          `json:"platform"`
Runtime  json.RawMessage `json:"runtime"`
```

After unmarshal, default the platform (before fingerprinting):

```go
if payload.Platform == "" {
	payload.Platform = "javascript"
}
```

Fingerprint call becomes:

```go
fingerprint := grouping.Fingerprint(payload.Platform, payload.Error.Type, payload.Error.Message, payload.Error.Stack)
```

Fold `runtime` into the context JSONB (design: runtime is stored inside the event's context), after the redaction block so it can't be redacted away:

```go
if len(payload.Runtime) > 0 {
	var ctxMap map[string]json.RawMessage
	if err := json.Unmarshal([]byte(ctx), &ctxMap); err == nil {
		ctxMap["runtime"] = payload.Runtime
		if merged, err := json.Marshal(ctxMap); err == nil {
			ctx = string(merged)
		}
	}
}
```

Pass `Platform: payload.Platform` in the `IngestParams` literal.

**Step 3: Store it in `queries.go`**

- Add `Platform string` to `IngestParams` (with a comment: `"javascript" | "python"; handler defaults it`).
- Event insert gains the column:
  ```sql
  INSERT INTO error_events (project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw, breadcrumbs, context, release, session_id, platform)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
  ```
- Group upsert gains it (never flip an existing group's platform):
  ```sql
  INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, occurrence_count, sample_event_id, platform)
  VALUES ($1, $2, $3, $4, $4, 1, $5, $6)
  ON CONFLICT (project_id, fingerprint) DO UPDATE
    SET ...,
        platform = COALESCE(error_groups.platform, EXCLUDED.platform)
  ```

**Step 4: Run the suite**

```bash
cd packages/ingestion && go build ./... && go test ./handler ./db ./grouping -v 2>&1 | tail -30
```

Expected: new tests PASS; `wire_compat_test.go` still green (old fixtures default to javascript).

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
    t = make_transport(lambda p: None, queue_size=3)
    for i in range(5):
        t.enqueue({"n": i})
    t._drain()
    # oldest (0, 1) dropped
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


def test_enqueue_never_raises():
    def exploding(p):
        raise RuntimeError("unexpected")

    t = make_transport(exploding)
    t.enqueue({"n": 1})
    t._drain()                             # unexpected errors are caught+logged
    assert t.queue_size() == 0


def test_fork_detection_restarts_thread():
    t = make_transport(lambda p: None)
    t._thread_enabled = True
    t.enqueue({"n": 1})
    assert t._pid is not None
    t._pid = t._pid + 1                    # simulate: we are a forked child
    t.enqueue({"n": 2})                    # must not raise; thread restarted
    assert t._pid is not None
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

    # -- public ----------------------------------------------------------

    def enqueue(self, payload):
        """Queue an event for delivery. Never raises, never blocks."""
        try:
            if not self._check_rate_limit():
                logger.warning("opslane: client-side rate limit hit; event dropped")
                return
            self._put_dropping_oldest([payload, 0])
            self._ensure_thread()
            self._wake.set()
        except Exception:
            logger.warning("opslane: enqueue failed; event dropped", exc_info=True)

    def flush(self, timeout=5.0):
        """Drain the queue. Returns True if fully drained in time. Never raises."""
        try:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if self._queue.empty() and not self._in_flight:
                    return True
                if self._thread_enabled and (self._thread is None or not self._thread.is_alive()):
                    return self._queue.empty() and not self._in_flight
                self._backoff_until = 0.0  # flush overrides pacing
                self._wake.set()
                time.sleep(0.05)
            return self._queue.empty() and not self._in_flight
        except Exception:
            logger.warning("opslane: flush failed", exc_info=True)
            return False

    def queue_size(self):
        return self._queue.qsize()

    # -- internals -------------------------------------------------------

    def _check_rate_limit(self):
        now = time.monotonic()
        with self._lock:
            while self._sent_stamps and now - self._sent_stamps[0] > 60.0:
                self._sent_stamps.popleft()
            if len(self._sent_stamps) >= self._max_per_minute:
                return False
            self._sent_stamps.append(now)
            return True

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
            if self._pid is not None and self._pid != pid:
                # Forked child: the inherited thread is dead and inherited
                # queue contents belong to the parent. Start clean.
                self._queue = queue.Queue(maxsize=self._queue_size)
                logger.debug("opslane: fork detected; transport restarted")
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
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                return
            payload, attempts = item
            self._in_flight = True
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
- Modify: `packages/sdk-python/tests/test_package.py`

**Step 1: Failing tests** — `tests/test_public_api.py`:

```python
import logging

import opslane
from opslane import _state


class StubTransport:
    def __init__(self):
        self.sent = []

    def enqueue(self, payload):
        self.sent.append(payload)

    def flush(self, timeout=5.0):
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


def test_reinit_warns_and_replaces(caplog):
    _init_with_stub()
    first = _state.client
    with caplog.at_level(logging.WARNING, logger="opslane"):
        opslane.init(api_key="k2", endpoint="https://y.example")
    assert _state.client is not first
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
    Gunicorn). Calling again replaces the client and logs a warning."""
    from opslane.client import Client

    with _state.lock:
        if _state.client is not None:
            logger.warning("opslane: already initialized; replacing client")
        _state.client = Client(
            api_key=api_key, endpoint=endpoint, release=release, **options
        )
        if not _state.atexit_registered:
            atexit.register(flush)
            _state.atexit_registered = True


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
opslane.capture_exception() to record them. The event snapshot is fully
serialized at signal time, before response finalization, so there is no
response breadcrumb (a request-scoped buffer could never carry one anyway).
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
        meta = {
            "method": request.method,
            "path": request.path,
            "headers": dict(request.headers),
            "remote_addr": request.remote_addr,
        }
        g.setdefault(_TOKENS_KEY, _context.push_scope(meta))
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

**Step 1: Write the smoke test** — spawns a real Gunicorn worker serving a tiny SDK-wrapped app, with a mock ingestion server (stdlib `http.server` on an ephemeral port) capturing POSTs:

```python
"""End-to-end smoke: Gunicorn (post-fork worker) -> SDK -> mock ingestion.

Proves the lazy transport thread works in a forked worker and events arrive
with the X-API-Key header. Skipped where gunicorn can't run (non-POSIX).
"""
import json
import os
import subprocess
import sys
import textwrap
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="gunicorn is POSIX-only")

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


def test_gunicorn_worker_delivers_events(tmp_path):
    server = HTTPServer(("127.0.0.1", 0), _Capture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ingest_port = server.server_address[1]

    app_py = tmp_path / "smoke_app.py"
    app_py.write_text(textwrap.dedent(f"""
        import opslane
        from flask import Flask
        from opslane.integrations.flask import OpslaneFlask

        opslane.init(api_key="smoke-key", endpoint="http://127.0.0.1:{ingest_port}")
        app = Flask(__name__)
        OpslaneFlask(app)

        @app.get("/boom")
        def boom():
            raise ValueError("gunicorn smoke")
    """))

    proc = subprocess.Popen(
        [sys.executable, "-m", "gunicorn", "--workers", "1",
         "--bind", "127.0.0.1:0", "smoke_app:app"],
        cwd=tmp_path, stderr=subprocess.PIPE, text=True,
    )
    try:
        # Parse the bound port from gunicorn's startup line.
        port = None
        deadline = time.time() + 15
        while time.time() < deadline and port is None:
            line = proc.stderr.readline()
            if "Listening at" in line:
                port = int(line.rsplit(":", 1)[1].split()[0])
        assert port, "gunicorn did not start"

        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/boom", timeout=5)
        except urllib.error.HTTPError as e:
            assert e.code == 500

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
        proc.terminate()
        proc.wait(timeout=10)
        server.shutdown()
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

**Step 1: Write the wire-shape test** (it both generates and then locks the fixtures — mirroring `packages/sdk/src/__tests__/wire-shape.test.ts`):

```python
"""The SDK's real payload must match the frozen python-v* wire fixtures.

Timestamps and stacks vary per run, so the comparison normalizes them; every
other byte is contract. To regenerate after a DELIBERATE contract change
(new SDK version = new fixture pair; never edit existing files):
    OPSLANE_WRITE_FIXTURES=1 .venv/bin/pytest tests/test_wire_shape.py
"""
import json
import os
import pathlib

import opslane
from opslane import _state, context as ctx
from opslane.client import Client

FIXTURES = pathlib.Path(__file__).resolve().parents[3] / "test-fixtures" / "wire" / "events"
VERSION = opslane.__version__


class StubTransport:
    def __init__(self):
        self.sent = []

    def enqueue(self, payload):
        self.sent.append(payload)


def _normalize(payload):
    payload = json.loads(json.dumps(payload))
    payload["timestamp"] = "<TS>"
    payload["error"]["stack"] = "<STACK>"
    payload["runtime"]["version"] = "<PYVER>"
    payload["context"]["user_agent"] = "<UA>"
    for crumb in payload["breadcrumbs"]:
        crumb["timestamp"] = "<TS>"
    return payload


def _build(full: bool):
    client = Client(api_key="k", endpoint="https://x.example",
                    release="v1.2.3" if full else None, transport=StubTransport())
    tokens = ctx.push_scope({
        "method": "GET", "path": "/api/users/123",
        "headers": {"Content-Type": "application/json"},
        "remote_addr": "10.0.1.50",
    } if full else None)
    if full:
        ctx.set_user({"id": "user-123", "email": "jane@example.com",
                      "account": {"id": "acct-42", "name": "Example Inc"}})
        ctx.add_breadcrumb({"type": "log", "timestamp": "t", "category": "app.auth",
                            "level": "warning", "message": "Token near expiry"})
    try:
        raise ValueError("No row was found")
    except ValueError as e:
        client.capture_exception(e)
    ctx.reset_scope(tokens)
    return _normalize(client.transport.sent[0])


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

Inspect both generated files by eye against the design's payload example (platform, runtime, context.request, lowercase levels, message on every breadcrumb, no nulls for absent fields).

**Step 3: Confirm the server replays them** — `wire_compat_test.go` picks up every `.json` in the dir automatically:

```bash
cd packages/ingestion && go test ./handler -run TestWireCompat -v
```

Expected: PASS including both python fixtures (202 + stored round-trip). If the compat test asserts fields the python fixtures lack (e.g. `session_id`), extend the test's per-fixture expectations following its existing pattern — do not change the fixtures to appease the test.

**Step 4: Append provenance to the README** (how each python fixture was produced, mirroring the existing entries), then commit:

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

**Step 2: Fire a real SDK-captured error at it**

```bash
cd packages/sdk-python && .venv/bin/python - <<'EOF'
import opslane
from flask import Flask
from opslane.integrations.flask import OpslaneFlask

opslane.init(api_key="<KEY-FROM-SEED>", endpoint="http://localhost:8082")
app = Flask(__name__)
OpslaneFlask(app)

@app.get("/boom")
def boom():
    raise ValueError("live smoke failure")

client = app.test_client()
client.get("/boom")            # from /app/-style path? no — local paths; still groups
client.get("/boom")            # second occurrence: must join the same group
assert opslane.flush(timeout=10), "flush did not drain"
print("sent")
EOF
```

**Step 3: Verify the database state**

```bash
psql "postgres://opslane:opslane_dev@localhost:5434/opslane" -c \
  "SELECT platform, error_type, context ? 'runtime' AS has_runtime FROM error_events ORDER BY created_at DESC LIMIT 2;"
psql "postgres://opslane:opslane_dev@localhost:5434/opslane" -c \
  "SELECT platform, occurrence_count, title FROM error_groups WHERE platform = 'python';"
```

Expected: two events `platform=python`, `has_runtime=t`; ONE group, `platform=python`, `occurrence_count=2` — this is Batch 1's acceptance gate observed live.

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
