# Python Backend SDK — Design Document

**Date:** 2026-07-17 (revised same day after review)
**Status:** Approved
**Author:** Brainstorm session (Claude + Abhishek); revised per design review
**Supersedes:** `docs/plans/2026-03-02-python-backend-sdk-design.md` in the private `opslane/defender` repo. That design was approved before the opslane-oss migration; this document re-validates it against the current codebase and updates naming, placement, and the fingerprint scheme.

## Problem

Opslane today captures browser JavaScript errors only. Backend errors — the 500s, unhandled exceptions, and data-layer failures in Python web apps — are invisible. For a full-stack application, a frontend TypeError might be caused by a backend endpoint returning malformed JSON, but Opslane can't see that chain.

Every design partner runs a Python backend (Flask, FastAPI, Django). Expanding to backend error capture is the natural next step. The full autonomous pipeline (capture → RCA → fix → PR) must work for Python, not just capture-and-display.

## Scope

**In scope (v1 — Flask only):**
- `opslane` pip package with `init()`, `set_user()`, `capture_exception()`, `flush()`
- Flask integration via signals + logging handler
- Log breadcrumbs (WARNING+)
- Batched async transport
- Server-side Python traceback parsing and fingerprinting
- `platform` field on events and error groups
- Sample-event read path so the dashboard can render tracebacks and request context
- Dashboard platform filter and Python traceback rendering
- Cross-stack user correlation (same `user.id` across JS and Python SDKs)
- Full autonomous fix pipeline: E2B sandbox with Python runtime, `pip install`, `pytest`

**Explicitly deferred:**
- FastAPI and Django integrations (small additive adapters once the core is proven — see "Framework adapters" below)
- SQL query breadcrumbs (SQLAlchemy hooks)
- Outgoing HTTP request breadcrumbs
- Session-level cross-stack linking (header propagation)
- Celery / background task integration
- Multi-repo project support
- Multi-version Python sandboxes (see "Runtime fidelity")

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| First framework | Flask | Design partner's stack. Simplest integration surface (signals, not ASGI). |
| SDK location | **Monorepo: `packages/sdk-python/`** | Mirrors `packages/sdk` (browser SDK). One repo, one CI, fixtures/e2e nearby. Not a pnpm workspace member — own `pyproject.toml` + pytest. |
| Package name | **`opslane` on PyPI, `import opslane`** | Mirrors `@opslane/sdk`. Name was unclaimed as of 2026-07-17; claim it. |
| License | MIT | Same boundary as `packages/sdk` per AGENTS.md — SDKs are intentionally MIT. |
| User context propagation | Application-level (`set_user()`) | Backend already knows the user from its own auth. No special headers, no CORS. Header-based session linking can come later. |
| Stack fingerprinting | Server-side (ingestion) | Keeps SDK thin. Iterate on fingerprint quality without SDK upgrades. Raw traceback always preserved for the agent. |
| Error capture surface | **Genuinely unhandled exceptions only** (via `got_request_exception`) + explicit `capture_exception()` | Flask emits the signal only for exceptions no user error handler recovers (see "Flask capture semantics"). Recovered exceptions are the app's business; opt in explicitly. |
| Project model | Same project, `platform` field | Unified user view across frontend + backend. `platform` in the fingerprint hash prevents cross-language collisions. |
| Fingerprint scheme | **`SHA256(platform \| type \| normalized_message \| frames)` for all platforms**, truncated to the first 128 bits (existing behavior) | Symmetric recipe. Pre-launch fresh start — but "no stored data" is a **deployment gate**, not an assumption: Batch 1 rollout requires `error_groups` to be empty, else a backfill must run first. |
| Python frame identity | **Prefix-stripped `file:function`, no line numbers** | Raw paths fragment groups across deployment roots (`/app/` vs `/srv/`); line numbers fragment groups on ordinary edits. Line numbers stay in the stored traceback for display and source lookup. |
| Runtime capture | **Structured `runtime: {name, version}` payload field** | The worker needs the customer's Python version for sandbox fidelity; parsing `context.user_agent` must not become a contract. v1 sandbox is a documented approximation (see "Runtime fidelity"). |
| `error_groups.platform` | **Nullable; set only for `kind='error'`** | The incidents table also holds friction incidents; defaulting them to `'javascript'` would misclassify them. Platform filtering applies to error incidents only. |
| SDK architecture | No monkey-patching | Flask signals + `logging.Handler` only. Predictable, debuggable, no import-order surprises. |
| SDK dependencies | Zero runtime deps (stdlib `urllib.request`, `threading`, `queue`, `logging`, `contextvars`) | Minimal footprint. No `requests` dependency to conflict with customer pins. Framework adapters import their framework only when the user imports the adapter. |
| Minimum Python | 3.9+ | `contextvars` stable since 3.7; 3.9 is the oldest sensible floor. CI matrix: 3.9 and 3.12. |
| Transport model | Individual POSTs (not batched array) | Reuse the existing single-event `POST /api/v1/events` endpoint. The wire contract is frozen/append-only; no new endpoint. |

## Framework adapters

One SDK, thin per-framework adapters. The core (`client.py`, `transport.py`, `context.py`, `breadcrumbs.py`) is framework-agnostic. Each framework gets a ~100–200 line adapter in `opslane/integrations/` that wires the core into that framework's lifecycle: when a request starts/ends, and how unhandled exceptions surface.

```python
from opslane.integrations.flask import OpslaneFlask      # v1 — this design
from opslane.integrations.fastapi import OpslaneFastAPI  # later: ASGI middleware
from opslane.integrations.django import OpslaneDjango    # later: middleware + signal
```

Design rule: nothing framework-specific leaks into core modules. Adapters translate framework concepts into core calls, never the reverse. Because the SDK has zero dependencies, the Flask adapter imports Flask only when the user imports the adapter.

## Design

### 1. Package layout and public API

```
packages/sdk-python/
├── opslane/
│   ├── __init__.py          # init(), set_user(), clear_user(), capture_exception(), flush()
│   ├── client.py            # Core client: builds payloads, manages state
│   ├── transport.py         # HTTP transport: queue, retry, background thread
│   ├── context.py           # contextvars-based request/user context
│   ├── breadcrumbs.py       # Ring buffer, max 50 per request
│   └── integrations/
│       └── flask.py         # OpslaneFlask: signal hooks, logging hook
├── tests/
├── pyproject.toml
└── README.md
```

```python
import opslane

# Initialize — in app factory or wsgi.py (post-fork under Gunicorn)
opslane.init(
    api_key="env-key-xxx",
    endpoint="https://ingest.example.com",   # optional
    release="v1.2.3",                        # optional
)

# User context — call after authentication
opslane.set_user({
    "id": "user-123",
    "email": "alice@acme.com",
    "account": {"id": "acme-corp", "name": "Acme Corporation"}
})
opslane.clear_user()

# Explicit capture — for handled exceptions
try:
    risky_operation()
except SomeError as e:
    opslane.capture_exception(e)

# Explicit drain — returns True if the queue drained within the timeout
opslane.flush(timeout=5.0)

# Flask integration — one line
from opslane.integrations.flask import OpslaneFlask
OpslaneFlask(app)
```

Key behaviors:

- **`contextvars.ContextVar`** for all request-scoped state (user, breadcrumbs, request metadata). Safe for threaded Flask (Gunicorn sync workers) and async views. `before_request` calls `ContextVar.set()` and stores the token; `teardown_request` calls `ContextVar.reset(token)` — cleanup happens even when the handler raises.
- **No monkey-patching.** Flask's public signal API and Python's `logging.Handler` only.
- **Idempotent setup.** Calling `init()` twice reconfigures and logs a warning; wrapping the same Flask app with `OpslaneFlask` twice is a no-op with a warning. Neither double-registers hooks.

### 2. Transport contract

A lazily-started daemon thread drains a `queue.Queue` and POSTs events individually to `/api/v1/events`.

**Queueing and pacing:**
- Queue capped at 100 events; when full, the **oldest** event is dropped to admit the new one.
- Drain cycle every 5s, up to 10 events per cycle.
- Client-side rate limit: 100 events/minute per process (configurable via `init(max_events_per_minute=...)`); events beyond the limit are dropped at enqueue time.

**HTTP semantics:**
- Timeouts: 3s connect, 5s read (configurable via `init(http_timeout=...)`).
- **Retryable:** network errors, HTTP 429, and 5xx. Exponential backoff 1s, 2s, 4s … capped at 60s, with jitter. A `Retry-After` header, when present, overrides the computed backoff (capped at 60s).
- **Not retryable:** all other 4xx (bad API key, malformed event). The event is dropped immediately and the failure logged — retrying can't fix it.
- **Bounded retries:** an event is dropped after 5 failed attempts. A failing event never blocks the queue indefinitely; after its attempts are exhausted, draining continues with the next event.

**Diagnostics:** the SDK logs through the stdlib `logging` logger named `opslane` — drops (queue-full, rate-limit, non-retryable, attempts-exhausted) at WARNING, retries at DEBUG. It never prints, never raises into application code.

**Shutdown:** `atexit.register(flush)` drains the queue on graceful shutdown. `flush(timeout)` blocks up to `timeout` seconds and returns `True` if the queue fully drained, `False` otherwise; it never raises. On hard kill the daemon thread dies with the process; unsent events are lost and re-sent on next occurrence. Acceptable.

**Fork safety (Gunicorn):** the transport thread starts lazily on first event, and the transport records the PID that started it. If the current PID differs (init happened pre-fork, e.g. `--preload`), the transport discards the inherited dead thread state and starts a fresh thread in the child. `gevent>=20.9` patches `contextvars` correctly; older versions are unsupported (SDK logs a warning on init when detected).

### 3. Flask capture semantics

`OpslaneFlask(app)` registers: a `before_request` hook, a `teardown_request` hook, the `got_request_exception` signal, and a `logging.Handler` on `app.logger`.

**What generates an event — the explicit contract:**

| Situation | Captured? |
|---|---|
| Unhandled exception → Flask's generic 500 | **Yes** — via `got_request_exception` |
| Exception recovered by a registered `@app.errorhandler` | **No** — Flask handles it in `handle_user_exception`, which does not emit the signal |
| `HTTPException` (e.g. `abort(404)`) | **No** — same path as above |
| Handled exception the app wants recorded | **Yes** — explicit `opslane.capture_exception(e)` |

This follows Flask's actual lifecycle: `got_request_exception` is emitted in `handle_exception`, which only runs for exceptions no user error handler recovers. (The old defender design claimed the signal fires for recovered exceptions too; that was wrong.)

**Snapshot timing:** the event payload is fully serialized at signal time — exception type, message, `traceback.format_exception()` output, accumulated breadcrumbs, user context, request context (method, path, filtered headers, remote IP). The signal fires before response finalization, so **the captured event never contains a breadcrumb for its own response**. Since breadcrumbs are request-scoped (reset every request), a response breadcrumb could never appear in any event — so there is no response breadcrumb and no `after_request` hook at all.

**Request lifecycle:**

```python
@app.before_request
def _opslane_before():
    # New breadcrumb scope; capture the incoming request as the first breadcrumb:
    # {type: "http", category: "request", message: "GET /api/users/123",
    #  data: {method, path, content_type}}

@app.teardown_request
def _opslane_teardown(exc):
    # Reset contextvars (prevent bleed across requests on the same thread)
```

**Log capture:** a `logging.Handler` on `app.logger` turns records ≥ WARNING (configurable) into breadcrumbs: `{type: "log", category: record.name, level: "warning", message: record.getMessage()}`. Levels are normalized to the shared-type lowercase union (`debug`/`info`/`warning`/`error`; CRITICAL maps to `error`). Breadcrumbs capped at 50 per request (ring buffer, oldest dropped).

**What the SDK does NOT do:**
- Capture request/response bodies (PII risk, size risk)
- Capture query parameters by default (opt-in via `send_pii=True`)
- Capture sensitive headers — default deny-list: `authorization`, `cookie`, `x-api-key`, `x-csrf-token`, `set-cookie`; configurable via `opslane.init(sensitive_headers=[...])`
- Interfere with Flask's error handlers or response codes
- Add latency to the request path (target <1ms per request for the hooks; transport is async)

### 4. Event payload

The Python SDK sends `POST /api/v1/events` with the same payload shape as the browser SDK, plus new **optional** fields. The wire contract is frozen/append-only (`docs/contracts/events.md`): optional additions only, no edits to frozen fixtures under `test-fixtures/wire/`. A new frozen Python-event fixture is added; existing fixtures are untouched.

```json
{
  "timestamp": "2026-07-17T14:30:00Z",
  "platform": "python",
  "runtime": {"name": "cpython", "version": "3.12.1"},
  "error": {
    "type": "sqlalchemy.exc.NoResultFound",
    "message": "No row was found when one was required",
    "stack": "Traceback (most recent call last):\n  File \"/app/api/routes/users.py\", line 42, ..."
  },
  "breadcrumbs": [
    {"type": "http", "category": "request", "message": "GET /api/users/123",
     "data": {"method": "GET", "path": "/api/users/123", "content_type": "application/json"},
     "timestamp": "..."},
    {"type": "log", "category": "app.auth", "level": "warning",
     "message": "Token near expiry", "timestamp": "..."}
  ],
  "context": {
    "url": "GET /api/users/123",
    "user_agent": "Python/3.12 opslane/0.1.0",
    "request": {
      "method": "GET",
      "path": "/api/users/123",
      "headers": {"content-type": "application/json"},
      "remote_addr": "10.0.1.50"
    },
    "user": {"id": "user-123", "email": "alice@acme.com", "account_id": "acme-corp"}
  },
  "sdk_version": "0.1.0",
  "release": "v1.2.3"
}
```

Payloads conform to the existing shared types: every breadcrumb carries a `message` (required in `Breadcrumb`), and `level` uses the lowercase union.

**New fields vs browser SDK:**
- `platform` — `"python"`; absent/other payloads default to `"javascript"`
- `runtime` — structured interpreter identity (`sys.implementation.name`, `platform.python_version()`); the worker's sandbox-fidelity input
- `context.request` — server-side request metadata; browser SDK doesn't send it
- `context.url` — filled with `"{method} {path}"` so dashboard/worker code reading `context.url` keeps working; browser SDK sends the page URL here
- `context.user_agent` — `"Python/{version} opslane/{sdk_version}"`, display-only; **never parsed** (that's what `runtime` is for)

**Shared type changes** (`shared/src/types.ts`), the complete list:
- `ErrorEventPayload.platform?: 'javascript' | 'python'`
- `ErrorEventPayload.runtime?: { name: string; version: string }`
- `ErrorEventPayload['context']['request']?: { method: string; path: string; headers: Record<string, string>; remote_addr?: string }`
- `BreadcrumbType` union grows `'http' | 'log'`
- Lands in Batch 1; triggers `pnpm -r build`

### 5. Ingestion changes

**Fingerprint** (`packages/ingestion/grouping/fingerprint.go`): `Fingerprint()` gains a `platform` parameter:

```go
func Fingerprint(platform, errorType, errorMessage, stackTrace string) string
```

Hash input becomes `SHA256(platform | error_type | normalized_message | joined_frames)` for **all** platforms; the stored fingerprint remains the first 128 bits (32 hex chars) as today. Existing JS fingerprint test expectations update in the same change.

**Deployment gate (not an assumption):** grouping is unique on `(project_id, fingerprint)`, so this change re-keys every stored JS group. Rollout of Batch 1 requires `error_groups` to be empty (`SELECT count(*) FROM error_groups` = 0). If that ever stops being true before rollout, a backfill that recomputes stored fingerprints must ship in the same release — it may not be skipped silently.

Routing: `platform == "python"` and stack starts with `"Traceback"` → Python parser; otherwise the existing V8 `topFrames()` path. Message normalization reuses the existing `normalizeMessage` (hex, UUIDs, numbers, quoted strings, URL/asset-hash stripping).

**Python traceback parser** (new `packages/ingestion/grouping/python.go`):

Detection: stack string starts with `"Traceback (most recent call last):"`.

Python frames span two lines each:

```
  File "/app/api/routes/users.py", line 42, in get_user
    user = db.query(User).filter_by(id=user_id).one()
```

Algorithm:
1. Regex-extract `(file, function, lineno)` from each `File "...", line N, in func` line
2. Filter library frames: paths containing `site-packages/`, `dist-packages/`, `venv/`, `lib/python*/`, `.tox/`
3. **Reverse** remaining application frames (Python puts the most recent frame last — opposite of V8)
4. Take up to 5 application frames
5. **Normalize each frame to a stable identity:** strip deployment prefixes (`/app/`, `/srv/`, `/opt/`, `/home/<user>/`, `/usr/src/`), then format as `"relative_file:function"` — **no line number**. Line numbers fragment groups on ordinary edits; deployment roots fragment them across environments. Both stay in the stored raw traceback for display and worker source lookup.
6. Join with `|`, feed into the hash

The parser returns pre-extracted, pre-ordered frame strings directly; it does not use `topFrames()`.

**Fingerprint stability invariants** (each gets a test):
- Same error from `/app/routes/users.py` and `/srv/routes/users.py` → same group
- Inserting a line above the failure site (lineno shifts) → same group
- Chained exceptions (`During handling of...` / `...direct cause of...`) → only the **final (outermost)** exception's frames are used
- `RecursionError` repeating frames dedup before hashing
- Malformed/empty tracebacks → fall back to hashing the raw string
- Python 3.11+ `ExceptionGroup` tracebacks (indented sub-traceback format) → v1 treats them via the fallback path (hash raw string); structured handling deferred
- Gunicorn/uWSGI wrapper frames filter as library frames
- Python + JS with the same error type never collide (platform in hash)

**Payload parsing:** `platform` and `runtime` are new optional fields on the ingest payload; `platform` defaults to `"javascript"`. Both are stored on the event (`runtime` inside the event's `context` JSONB). Everything else — user upsert, affected users, job creation, tenant scoping — unchanged.

### 6. Database migration

`packages/ingestion/db/migrations/014_platform.sql` (next free slot; auth took 010–013):

```sql
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'javascript';
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS platform TEXT;  -- nullable
```

- `error_events.platform` — NOT NULL with default: every event row is an error event, and absent-platform payloads are JavaScript by contract.
- `error_groups.platform` — **nullable**: the incidents table holds both `kind='error'` and `kind='friction'` rows. Ingestion sets `platform` when creating/updating error groups; friction incidents keep `NULL`. A backfill statement sets `platform='javascript'` for existing `kind='error'` rows (vacuous under the empty-table deployment gate, but keeps the migration correct standalone).

Idempotent per ingestion conventions. **Deployment order:** migration before the code that writes the column.

No other schema changes — the JSONB `context` column already accepts `context.request`. Platform propagates to the worker via the error group: claim job → load error group (now has `platform`) → route. No changes to `error_group_jobs`.

### 7. Read API — sample event exposure (new in Batch 2)

Today `incidentJSON` (`packages/ingestion/handler/read_api.go`) exposes only group-level fields — no stack trace, no breadcrumbs, no context. The dashboard cannot render a traceback (for Python **or** JS) without a new read path.

**Design:** a tenant-scoped sample-event endpoint:

```
GET /api/v1/incidents/{id}/sample-event
```

- Resolves the group's `sample_event_id` (already on `error_groups`), scoped to the caller's project like every other read query.
- Returns: `error_type`, `error_message`, `stack_trace_raw`, `breadcrumbs`, `timestamp`, and a **filtered** `context`.
- **Exposure policy:** `context.request.headers` passes through the same deny-list the SDK uses (`authorization`, `cookie`, `x-api-key`, `x-csrf-token`, `set-cookie`) as defense in depth — the SDK already filtered, but the server must not rely on client behavior. `context.request.remote_addr` **is** returned (dashboard users are the tenant's own engineers debugging their own traffic). `context.user` passes through as-is (same data the user list already shows).
- New Go query `GetSampleEvent(projectID, groupID)`, new `sampleEventJSON` handler type, new shared `SampleEvent` type for the dashboard.

Separate endpoint rather than embedding in incident detail: the list view stays lean, and the detail view fetches the event only when opened.

### 8. Dashboard changes

All named components exist today (`FilterBar.vue`, `IncidentDetail.vue`):

1. **Platform filter** in `FilterBar.vue`: All / JavaScript / Python. Full propagation chain (not just the component): dashboard `IncidentFilters` type → query-string param → handler query parsing → `db.ErrorGroupFilters.Platform` → `ListErrorGroups` WHERE clause. **A platform filter implicitly scopes to `kind='error'`** — friction incidents (platform NULL) appear only under "All".
2. **Platform badge** on error-incident rows (`platform` added to `incidentJSON` and the shared `Incident` type; hidden when NULL).
3. **Python traceback rendering** in `IncidentDetail.vue`, fed by the new sample-event endpoint: detect the `Traceback` format, render in `<pre>` — tracebacks are already human-readable; no syntax-highlighting dependency. JS incidents get the same sample-event fetch (their stacks render in the existing code-block style).
4. **`context.request` display** in the detail view: method, path, filtered headers, remote addr, when present. JS incidents unaffected.
5. **Cross-stack user timeline** — verification, not construction: both SDKs calling `set_user({id})` upsert the same `end_user` row, so the user view should already show both. Prove it with seeded mixed-platform data.

Constraints: no `any` (use `unknown` + narrowing); `pnpm --filter @opslane/dashboard build` passes.

### 9. Worker pipeline — Python autonomous fix

Platform-aware routing; plain if/else, not a plugin system. One worker handles both platforms — no separate pools for v1; filtered polling can come later if Python volume grows.

```
claim job → load error group → check platform
  ├── "javascript" (or NULL) → existing JS pipeline (unchanged)
  └── "python"               → Python pipeline
```

| Step | JS (current) | Python (new) |
|------|-------------|--------------|
| Sandbox setup | `npm/pnpm/yarn install`, 120s timeout | `pip install`, 300s timeout, `--no-cache-dir` |
| Source file lookup | Source maps via `extractStackTraceFiles()` | Python regex + prefix strip, exact match |
| Agent context | V8 stack, console breadcrumbs | Python traceback, log/request breadcrumbs |
| Verification | vitest/npm test via `runTestGate()` | `pytest` via platform-aware `runTestGate()` |

**E2B sandbox:** custom template with Python 3.12 + `build-essential`, `libpq-dev` (psycopg2), `libffi-dev` (cffi). Built and benchmarked in Batch 0 (spike validates the 300s install budget). No virtualenv — install into system Python; the sandbox is the isolation.

**Runtime fidelity — explicit v1 policy:** the sandbox runs Python 3.12 regardless of the customer's interpreter, while the SDK supports 3.9+. This is a documented approximation with known failure modes: a fix could use 3.10+ syntax that fails on the customer's 3.9, or a dependency set could resolve differently. Mitigations in v1: the captured `runtime.version` is (a) surfaced in the agent prompt ("the application runs CPython 3.9.18 — do not use syntax newer than 3.9"), and (b) recorded on the PR description so reviewers see the verification gap. Per-version sandbox templates are deferred until a design partner actually runs a pre-3.12 interpreter in production.

**Install detection** (deliberately dumb):
1. `requirements.txt` → `pip install -r requirements.txt --no-cache-dir`
2. `pyproject.toml` with `[project]` → `pip install -e .`
3. Neither → agent investigates via `bash`

Pipfile/pipenv and bare setup.py deferred — legacy patterns no design partner uses.

**`extractStackTraceFiles()`** (`packages/worker/src/harness/stack-trace-utils.ts`): gains a `platform` parameter and the Python regex `/File "([^"]+)", line \d+/g` alongside the V8/Firefox/Safari patterns. Frame → repo file mapping:
1. Strip deployment prefixes (`/app/`, `/srv/`, `/opt/`, `/home/*/`, `/usr/src/`) — same list as the fingerprint parser, shared by contract test
2. Exact-match the remaining relative path against cloned-repo files — **no fuzzy matching** (silent wrong-file matches poison the agent)
3. No match → not pre-loaded; the agent discovers via its `search` tool
4. Library frames excluded from pre-loading but kept in the raw traceback

**Prompt:** `buildPythonSystemPrompt()` as a separate function beside the JS one in `agent-fix.ts`, sharing scope/budget constants (turn budget, cost limit, necessity test, test-before-completion). Python-specific content: traceback format description, the captured runtime version constraint, site-packages/virtualenv instead of node_modules/minified bundles, give-up criteria ("error only in third-party library code", "fix requires a database schema change"). Context includes raw traceback, breadcrumbs, request line, and the frame→file mapping. Agent tools unchanged (read, edit, write, bash, search, give_up).

**`runTestGate()`:** platform branch — `pytest`, 120s timeout, exit codes: 0 pass, 1 failures, 2 error, 5 no-tests-collected (treated as unverifiable, not passing).

**Source maps:** skipped entirely for `platform: "python"` — no lookup query. `release` is a deployment version label only.

**Classification unchanged (deterministic):** tests pass + diff → `fix_pr`; `give_up` / failed tests / budget exhausted → `needs_human` with reason codes.

## End-to-end data propagation map

Every layer `platform` (and the Python payload) touches, so nothing silently drops it:

| Layer | Change |
|---|---|
| Wire payload | `platform`, `runtime`, `context.request` — optional fields; new frozen fixture |
| Shared types | `ErrorEventPayload` additions; `BreadcrumbType` + `'http' \| 'log'`; new `SampleEvent`; `Incident.platform?` |
| Ingest handler | Parse `platform` (default `javascript`); route to Python parser; store on event + group |
| DB schema | `error_events.platform` NOT NULL default; `error_groups.platform` nullable (migration 014) |
| DB queries | `CreateOrUpdateErrorGroup` writes platform; `ListErrorGroups` gains platform filter; `GetErrorGroup` selects platform; new `GetSampleEvent` |
| Read API | `incidentJSON.platform`; query-param parsing; new sample-event endpoint with header/IP policy |
| Dashboard | `Incident.platform`; `IncidentFilters.platform`; FilterBar; badge; sample-event fetch + traceback render |
| Worker | `getErrorGroup` selects platform; pipeline branch; stack-trace extraction; prompt; test gate; source-map skip |

## Cross-stack user correlation

No special headers or session linking. Both SDKs call `set_user({id})` independently; ingestion upserts the same `end_user` row (keyed on `project_id + external_user_id`). The user detail view shows all error groups affecting that user — JS and Python — in one timeline. Per-request session linking via header propagation is a later opt-in enhancement.

## CI and release

- **CI**: new job in `.github/workflows/ci.yml` — pytest matrix on Python 3.9 and 3.12 for `packages/sdk-python`
- **Release**: new `release-pypi.yml` modeled on `release-npm.yml`, using PyPI trusted publishing; Batch 0 proves the TestPyPI path end-to-end
- The package is not a pnpm workspace member; JS tooling ignores it

## Testing strategy

### SDK (pytest, `packages/sdk-python/tests/`)
- Transport: queue cap + oldest-dropped, flush timing, rate limiting, backoff, Retry-After handling, non-retryable 4xx drop, attempts-exhausted drop, head-of-line non-blocking (mocked HTTP)
- Context: contextvars isolation — N threads, distinct users, no bleed
- Breadcrumbs: ring buffer overflow, ordering, 50 cap, level normalization to lowercase
- Flask capture semantics (Flask test client): unhandled exception → captured; exception recovered by `@app.errorhandler` → **not** captured; `HTTPException` → not captured; `capture_exception()` → captured; log breadcrumbs at WARNING+; every breadcrumb has a `message`
- Shutdown: `atexit` flush drains; `flush(timeout)` returns True/False correctly, never raises
- Fork safety: simulated pre-fork init → child gets a working transport
- Idempotency: double `init()`, double `OpslaneFlask(app)` → warnings, no double-capture
- Gunicorn smoke test (CI): run a Gunicorn worker, send requests, verify events arrive

### Go parser (`packages/ingestion/grouping/python_test.go`)
All the stability invariants listed in the fingerprint section, each as a table test: prefix invariance, lineno invariance, library filtering, chained exceptions, RecursionError dedup, malformed fallback, ExceptionGroup fallback, wrapper-frame filtering, cross-platform non-collision.

### Wire contract
- One new frozen Python-event fixture in `test-fixtures/wire/`; existing fixtures untouched

### End-to-end
- Fixture Flask app → event → correctly-fingerprinted group with `platform='python'` → sample-event endpoint returns the traceback → job → agent PR with pytest passing in-sandbox

## Delivery batches

Tracked as issues in `opslane/opslane-oss` (#86–#89, re-filed from `opslane/defender#21–24`).

### Batch 0 (#86): scaffold + E2B Python template spike
- `packages/sdk-python/` skeleton, `pyproject.toml`, pytest wiring, CI job, TestPyPI publish
- E2B Python template spike: build the custom template, clone a representative Flask app (SQLAlchemy + psycopg2), benchmark `pip install`, document time/failures/template ID
- **Gate:** `pip install -i https://test.pypi.org/simple/ opslane` works in a clean venv; CI pytest green on 3.9 and 3.12; E2B template sandbox ready in <60s; install benchmark documented

### Batch 1 (#87): SDK + ingestion ("events flow in")
- Public API + `OpslaneFlask` + transport (full contract above) + privacy deny-list
- `grouping/python.go` parser + stability tests; `Fingerprint()` platform parameter
- Migration `014_platform.sql` (nullable group platform); shared type updates (complete list above); new wire fixture
- **Gate:** fixture Flask app throws → DB row with correct fingerprint and `platform='python'`; error-handler-recovered exceptions NOT captured; contextvars isolation test passes; JS ingestion regression-clean; **`error_groups` verified empty at rollout** (deployment gate); `pnpm -r build`, `go test ./...`, SDK pytest all green

### Batch 2 (#88): dashboard ("you can see them")
- Sample-event read path (endpoint + query + types + exposure policy)
- Platform filter (full propagation chain) + badge; Python traceback rendering; `context.request` display; cross-stack timeline verification
- **Gate:** seeded mixed-platform data — filter and badge work and friction incidents only appear under "All"; Python traceback renders from the sample-event endpoint; JS rendering unchanged; one user shows both error types

### Batch 3 (#89): worker ("agent fixes Python")
- `getErrorGroup` selects `platform`; pipeline branch; Python sandbox setup; `extractStackTraceFiles()` Python support; `buildPythonSystemPrompt()` with runtime-version constraint; pytest test gate; source-map skip
- 2+ Python cases in the eval harness (fixture Flask repo with a seeded bug)
- **Gate:** real Python error → PR whose diff fixes the bug with pytest passing in-sandbox; PR description records the sandbox-vs-customer runtime versions; JS worker tests green; give-up paths produce `needs_human` with reason codes

## State of the art — research summary

Findings from competitive research that informed this design (from the original 2026-03-02 session):

**Sentry Python SDK pain points:**
- `set_user()` broken in FastAPI dependencies (closed as "not planned")
- `send_default_pii=False` by default — user identity silently dropped
- No unified cross-stack user view when frontend/backend are separate projects (their recommended setup)
- `tracePropagationTargets` glob bugs silently break trace correlation
- `BaseHTTPMiddleware` in Starlette breaks `contextvars` propagation

**Highlight.io's approach:**
- Custom `x-highlight-request` header carries `sessionId/requestId` browser→backend; simpler than trace-based correlation but needs CORS config and is proprietary

**Our advantages:**
- Same-project model gives a unified user view by default (Sentry splits projects)
- Application-level `set_user()` avoids the CORS/header/propagation failure modes
- No monkey-patching avoids the "set_user in wrong scope" class of bugs
- Server-side fingerprinting lets us iterate quality without SDK upgrades
