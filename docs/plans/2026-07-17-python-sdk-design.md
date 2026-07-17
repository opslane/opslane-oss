# Python Backend SDK — Design Document

**Date:** 2026-07-17
**Status:** Approved
**Author:** Brainstorm session (Claude + Abhishek)
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

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| First framework | Flask | Design partner's stack. Simplest integration surface (signals, not ASGI). |
| SDK location | **Monorepo: `packages/sdk-python/`** | Mirrors `packages/sdk` (browser SDK). One repo, one CI, fixtures/e2e nearby. Not a pnpm workspace member — own `pyproject.toml` + pytest. |
| Package name | **`opslane` on PyPI, `import opslane`** | Mirrors `@opslane/sdk`. Name was unclaimed as of 2026-07-17; claim it. |
| License | MIT | Same boundary as `packages/sdk` per AGENTS.md — SDKs are intentionally MIT. |
| User context propagation | Application-level (`set_user()`) | Backend already knows the user from its own auth. No special headers, no CORS. Header-based session linking can come later. |
| Stack fingerprinting | Server-side (ingestion) | Keeps SDK thin. Iterate on fingerprint quality without SDK upgrades. Raw traceback always preserved for the agent. |
| Error capture surface | Framework integration + explicit `capture_exception()` | Catches user-facing 500s + opted-in handled exceptions. No `sys.excepthook` (conflicts with other libs). |
| Project model | Same project, `platform` field | Unified user view across frontend + backend. `platform` in the fingerprint hash prevents cross-language collisions. |
| Fingerprint scheme | **`SHA256(platform \| type \| normalized_message \| frames)` for all platforms** | Symmetric recipe. We're pre-launch with no existing error data, so re-hashing JS fingerprints has zero blast radius — existing JS test expectations update once, no backfill, no group splits. |
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

# Explicit drain
opslane.flush(timeout=5.0)

# Flask integration — one line
from opslane.integrations.flask import OpslaneFlask
OpslaneFlask(app)
```

Key behaviors:

- **`contextvars.ContextVar`** for all request-scoped state (user, breadcrumbs, request metadata). Safe for threaded Flask (Gunicorn sync workers) and async views. `before_request` calls `ContextVar.set()` and stores the token; `teardown_request` calls `ContextVar.reset(token)` — cleanup happens even when the handler raises.
- **No monkey-patching.** Flask's public signal API and Python's `logging.Handler` only.
- **Transport** — daemon thread with `queue.Queue` (thread-safe), drains up to 10 events per flush cycle (every 5s). Each event is an individual `POST /api/v1/events`. Never blocks the request path.
- **Shutdown** — `atexit.register(opslane.flush)` drains the queue on graceful shutdown. Public `opslane.flush(timeout=5.0)` for explicit drain. On hard kill the daemon thread dies with the process; in-flight events are lost and re-sent on next occurrence. Acceptable.
- **Gunicorn compatibility** — `opslane.init()` must be called post-fork (app factory, not module level with `--preload`). The transport thread is created lazily on first event, not at `init()`, so forked workers each get their own thread. `gevent>=20.9` patches `contextvars` correctly; older versions are unsupported (SDK logs a warning on init when detected).
- **Client-side rate limiting** — max 100 events/minute per process, beyond which events are silently dropped. Prevents a crash-looping endpoint from DDoS-ing ingestion. Configurable via `opslane.init(max_events_per_minute=100)`.
- **Graceful degradation** — unreachable ingestion → exponential backoff (1s, 2s, 4s, … max 60s) with jitter. Queue capped at 100 events; oldest dropped when full. Transport failures never raise into request handling.

### 2. Flask integration

`OpslaneFlask(app)` registers three hooks:

**Request lifecycle:**

```python
@app.before_request
def _opslane_before():
    # New breadcrumb scope for this request; capture incoming request as first
    # breadcrumb: {type: "http", category: "request", data: {method, path, content_type}}

@app.after_request
def _opslane_after(response):
    # Breadcrumb: {type: "http", category: "response", data: {status_code}}
    return response

@app.teardown_request
def _opslane_teardown(exc):
    # Reset contextvars (prevent bleed across requests on the same thread)
```

**Exception capture:** hooks Flask's `got_request_exception` signal — never interferes with the app's own `@app.errorhandler()` or response codes. The signal fires for all exceptions that reach the framework, including ones an error handler subsequently recovers. Known v1 behavior, intentional: a recovered `ValueError` is still a signal worth capturing; users filter in the dashboard.

Captures: exception type, message, full traceback string (`traceback.format_exception()`), accumulated breadcrumbs, user context, request context (method, path, filtered headers, remote IP).

**Log capture:** a `logging.Handler` on `app.logger` turns records ≥ WARNING (configurable) into breadcrumbs: `{type: "log", category: record.name, level, message}`. Breadcrumbs capped at 50 per request (ring buffer, oldest dropped).

**What the SDK does NOT do:**
- Capture request/response bodies (PII risk, size risk)
- Capture query parameters by default (opt-in via `send_pii=True`)
- Capture sensitive headers — default deny-list: `authorization`, `cookie`, `x-api-key`, `x-csrf-token`, `set-cookie`; configurable via `opslane.init(sensitive_headers=[...])`
- Interfere with Flask's error handlers or response codes
- Add latency to the request path (target <1ms per request for signal handlers; transport is async)

### 3. Event payload

The Python SDK sends `POST /api/v1/events` with the same payload shape as the browser SDK, plus new **optional** fields. The wire contract is frozen/append-only (`docs/contracts/events.md`): optional additions only, no edits to frozen fixtures under `test-fixtures/wire/`. A new frozen Python-event fixture is added; existing fixtures are untouched.

```json
{
  "timestamp": "2026-07-17T14:30:00Z",
  "platform": "python",
  "error": {
    "type": "sqlalchemy.exc.NoResultFound",
    "message": "No row was found when one was required",
    "stack": "Traceback (most recent call last):\n  File \"/app/api/routes/users.py\", line 42, ..."
  },
  "breadcrumbs": [
    {"type": "http", "category": "request", "data": {"method": "GET", "path": "/api/users/123"}, "timestamp": "..."},
    {"type": "log", "category": "app.auth", "level": "WARNING", "message": "Token near expiry", "timestamp": "..."},
    {"type": "http", "category": "response", "data": {"status_code": 500}, "timestamp": "..."}
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

**New fields vs browser SDK:**
- `platform` — `"python"`; absent/other payloads default to `"javascript"`
- `context.request` — server-side request metadata; browser SDK doesn't send it
- `context.url` — filled with `"{method} {path}"` so dashboard/worker code reading `context.url` keeps working; browser SDK sends the page URL here
- `context.user_agent` — `"Python/{version} opslane/{sdk_version}"` for the same reason
- No `runtime` field — the agent works in the E2B sandbox, not the customer's Python; the version is embedded in `context.user_agent` if needed

**Shared type changes** (`shared/src/types.ts`):
- `ErrorEventPayload.platform?: 'javascript' | 'python'`
- `BreadcrumbType` union grows `'http' | 'log'`
- Lands in Batch 1; triggers `pnpm -r build`

### 4. Ingestion changes

**Fingerprint** (`packages/ingestion/grouping/fingerprint.go`): `Fingerprint()` gains a `platform` parameter:

```go
func Fingerprint(platform, errorType, errorMessage, stackTrace string) string
```

Hash input becomes `SHA256(platform | error_type | normalized_message | joined_frames)` for **all** platforms. We are pre-launch with no stored error data, so changing JS hash inputs has no blast radius; existing JS fingerprint test expectations update in the same change. No backfill, no compat shim.

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
5. Format each as `"file:function:lineno"`, join with `|`, feed into the hash

The parser returns pre-extracted, pre-ordered frame strings directly; it does not use `topFrames()`.

**Chained exceptions:** for `"During handling of the above exception..."` / `"...direct cause of the following exception:"`, use only the **final (outermost)** exception's frames — that's what the developer sees and fixes.

**Edge cases:** `RecursionError` repeating frames dedup before hashing; malformed/empty tracebacks fall back to hashing the raw string; Gunicorn/uWSGI wrapper frames filter as library frames.

**Payload parsing:** `platform` is a new optional field on the ingest payload, defaulting to `"javascript"`. Everything else — user upsert, affected users, job creation, tenant scoping — unchanged.

### 5. Database migration

`packages/ingestion/db/migrations/014_platform.sql` (next free slot; auth took 010–013):

```sql
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'javascript';
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'javascript';
```

Idempotent per ingestion conventions. **Deployment order:** migration before the code that writes the column.

No other schema changes — the JSONB `context` column already accepts `context.request`. Platform propagates to the worker via the error group: claim job → load error group (now has `platform`) → route. No changes to `error_group_jobs`.

### 6. Dashboard changes

All named components exist today (`FilterBar.vue`, `IncidentDetail.vue`):

1. **Platform filter** in `FilterBar.vue`: All / JavaScript / Python, flowing through the incident-list query to an API filter on `error_groups.platform`
2. **Platform badge** on incident rows
3. **Python traceback rendering** in `IncidentDetail.vue`: detect the `Traceback` format, render in `<pre>` — tracebacks are already human-readable; no syntax-highlighting dependency
4. **`context.request` display** in detail views alongside `context.url`; JS incidents unaffected
5. **Cross-stack user timeline** — verification, not construction: both SDKs calling `set_user({id})` upsert the same `end_user` row, so the user view should already show both. Prove it with seeded mixed-platform data.

Constraints: no `any` (use `unknown` + narrowing); `pnpm --filter @opslane/dashboard build` passes.

### 7. Worker pipeline — Python autonomous fix

Platform-aware routing; plain if/else, not a plugin system. One worker handles both platforms — no separate pools for v1; filtered polling can come later if Python volume grows.

```
claim job → load error group → check platform
  ├── "javascript" → existing JS pipeline (unchanged)
  └── "python"     → Python pipeline
```

| Step | JS (current) | Python (new) |
|------|-------------|--------------|
| Sandbox setup | `npm/pnpm/yarn install`, 120s timeout | `pip install`, 300s timeout, `--no-cache-dir` |
| Source file lookup | Source maps via `extractStackTraceFiles()` | Python regex + prefix strip, exact match |
| Agent context | V8 stack, console breadcrumbs | Python traceback, log/request breadcrumbs |
| Verification | vitest/npm test via `runTestGate()` | `pytest` via platform-aware `runTestGate()` |

**E2B sandbox:** custom template with Python 3.12 + `build-essential`, `libpq-dev` (psycopg2), `libffi-dev` (cffi). Built and benchmarked in Batch 0 (spike validates the 300s install budget). No virtualenv — install into system Python; the sandbox is the isolation.

**Install detection** (deliberately dumb):
1. `requirements.txt` → `pip install -r requirements.txt --no-cache-dir`
2. `pyproject.toml` with `[project]` → `pip install -e .`
3. Neither → agent investigates via `bash`

Pipfile/pipenv and bare setup.py deferred — legacy patterns no design partner uses.

**`extractStackTraceFiles()`** (`packages/worker/src/harness/stack-trace-utils.ts`): gains a `platform` parameter and the Python regex `/File "([^"]+)", line \d+/g` alongside the V8/Firefox/Safari patterns. Frame → repo file mapping:
1. Strip deployment prefixes (`/app/`, `/opt/`, `/home/*/`)
2. Exact-match the remaining relative path against cloned-repo files — **no fuzzy matching** (silent wrong-file matches poison the agent)
3. No match → not pre-loaded; the agent discovers via its `search` tool
4. Library frames excluded from pre-loading but kept in the raw traceback

**Prompt:** `buildPythonSystemPrompt()` as a separate function beside the JS one in `agent-fix.ts`, sharing scope/budget constants (turn budget, cost limit, necessity test, test-before-completion). Python-specific content: traceback format description, site-packages/virtualenv instead of node_modules/minified bundles, give-up criteria ("error only in third-party library code", "fix requires a database schema change"). Context includes raw traceback, breadcrumbs, request line, and the frame→file mapping. Agent tools unchanged (read, edit, write, bash, search, give_up).

**`runTestGate()`:** platform branch — `pytest`, 120s timeout, exit codes: 0 pass, 1 failures, 2 error, 5 no-tests-collected (treated as unverifiable, not passing).

**Source maps:** skipped entirely for `platform: "python"` — no lookup query. `release` is a deployment version label only.

**Classification unchanged (deterministic):** tests pass + diff → `fix_pr`; `give_up` / failed tests / budget exhausted → `needs_human` with reason codes.

## Cross-stack user correlation

No special headers or session linking. Both SDKs call `set_user({id})` independently; ingestion upserts the same `end_user` row (keyed on `project_id + external_user_id`). The user detail view shows all error groups affecting that user — JS and Python — in one timeline. Per-request session linking via header propagation is a later opt-in enhancement.

## CI and release

- **CI**: new job in `.github/workflows/ci.yml` — pytest matrix on Python 3.9 and 3.12 for `packages/sdk-python`
- **Release**: new `release-pypi.yml` modeled on `release-npm.yml`, using PyPI trusted publishing; Batch 0 proves the TestPyPI path end-to-end
- The package is not a pnpm workspace member; JS tooling ignores it

## Testing strategy

### SDK (pytest, `packages/sdk-python/tests/`)
- Transport: queue cap, flush timing, rate limiting, backoff, graceful degradation (mocked HTTP)
- Context: contextvars isolation — N threads, distinct users, no bleed
- Breadcrumbs: ring buffer overflow, ordering, 50 cap
- Flask integration (Flask test client): unhandled exception → correct payload; `capture_exception()` → correct payload; `got_request_exception` doesn't interfere with `@app.errorhandler()`; log breadcrumbs at WARNING+
- Shutdown: `atexit` flush drains; `flush(timeout)` respects timeout
- Gunicorn smoke test (CI): run a Gunicorn worker, send requests, verify events arrive

### Go parser (`packages/ingestion/grouping/python_test.go`)
- Standard multi-frame traceback → correct extraction, bottom-up ordering
- `site-packages` frames filtered
- Chained exceptions → only outermost used
- `RecursionError` repeating frames deduplicated
- Malformed/empty traceback → graceful fallback
- Gunicorn/uWSGI wrapper frames filtered

### Fingerprint
- JS expectations updated once for the platform prefix
- Python fingerprint stable across message-normalization variants
- Python + JS with the same error type do not collide

### Wire contract
- One new frozen Python-event fixture in `test-fixtures/wire/`; existing fixtures untouched

### End-to-end
- Fixture Flask app → event → correctly-fingerprinted group with `platform='python'` → job → agent PR with pytest passing in-sandbox

## Delivery batches

Tracked as issues in `opslane/opslane-oss` (re-filed from `opslane/defender#21–24`).

### Batch 0: scaffold + E2B Python template spike
- `packages/sdk-python/` skeleton, `pyproject.toml`, pytest wiring, CI job, TestPyPI publish
- E2B Python template spike: build the custom template, clone a representative Flask app (SQLAlchemy + psycopg2), benchmark `pip install`, document time/failures/template ID
- **Gate:** `pip install -i https://test.pypi.org/simple/ opslane` works in a clean venv; CI pytest green on 3.9 and 3.12; E2B template sandbox ready in <60s; install benchmark documented

### Batch 1: SDK + ingestion ("events flow in")
- Public API + `OpslaneFlask` + transport + privacy deny-list
- `grouping/python.go` parser + tests; `Fingerprint()` platform parameter
- Migration `014_platform.sql`; shared type updates; new wire fixture
- **Gate:** fixture Flask app throws → DB row with correct fingerprint and `platform='python'`; contextvars isolation test passes; JS ingestion regression-clean; `pnpm -r build`, `go test ./...`, SDK pytest all green

### Batch 2: dashboard ("you can see them")
- Platform filter + badge; Python traceback rendering; `context.request` display; cross-stack timeline verification
- **Gate:** seeded mixed-platform data — filter and badge work, Python traceback legible, JS rendering unchanged, one user shows both error types

### Batch 3: worker ("agent fixes Python")
- `getErrorGroup` selects `platform`; pipeline branch; Python sandbox setup; `extractStackTraceFiles()` Python support; `buildPythonSystemPrompt()`; pytest test gate; source-map skip
- 2+ Python cases in the eval harness (fixture Flask repo with a seeded bug)
- **Gate:** real Python error → PR whose diff fixes the bug with pytest passing in-sandbox; JS worker tests green; give-up paths produce `needs_human` with reason codes

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
