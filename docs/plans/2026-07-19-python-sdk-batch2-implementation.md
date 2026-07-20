# Python SDK Batch 2: Dashboard Platform Support — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Python errors visible and readable in the dashboard — platform read-through, a sample-event read path (stack trace, breadcrumbs, context), platform filter + badge, and Python traceback rendering.

**Architecture:** Server first, UI second. `platform` is stored (migration 016) but never read back, and **no endpoint returns a group's stack/breadcrumbs/context today — for JS or Python; the dashboard renders no stack trace at all**. So this batch plumbs platform through the read path (struct → 2 SELECTs → `incidentJSON` → shared type), adds one new tenant-scoped endpoint (`GET /api/v1/projects/{projectID}/incidents/{incidentID}/sample-event`), then builds the dashboard rendering from scratch on top. Read-API changes are additive only.

**Tech Stack:** Go 1.24 (chi, pgx) in `packages/ingestion`; Vue 3 + Vite + Tailwind in `packages/dashboard`; shared TS contracts in `shared/src/types.ts`. Tests: `go test` (handler/db integration tests need `DATABASE_URL`), Vitest for dashboard.

**Tracker:** issue #88. Design: `docs/plans/2026-07-17-python-sdk-design.md` §7–8. Blocked-by #87 is merged (PR #98).

---

## Ground rules for the executor

- **Branch:** `abhishekray07/python-sdk-batch2` off up-to-date `origin/main`. Create it before Task 1:
  ```bash
  git fetch origin && git checkout -b abhishekray07/python-sdk-batch2 origin/main
  ```
- **DB-backed Go tests** skip without `DATABASE_URL`. Run them against a disposable migrated Postgres, never the shared 5434 instance:
  ```bash
  docker run -d --rm --name b2-pg -e POSTGRES_USER=opslane -e POSTGRES_PASSWORD=opslane \
    -e POSTGRES_DB=opslane -p 5499:5432 postgres:16-alpine
  until docker exec b2-pg pg_isready -U opslane -d opslane >/dev/null 2>&1; do sleep 0.5; done
  for f in packages/ingestion/db/migrations/*.sql; do
    docker exec -i b2-pg psql -q -U opslane -d opslane -v ON_ERROR_STOP=1 < "$f"; done
  export DATABASE_URL="postgres://opslane:opslane@localhost:5499/opslane"
  ```
  Tear down with `docker stop b2-pg` when done.
- Existing test helpers: `testDeps(t)` + `seedTenant(t, ...)` in `packages/ingestion/handler/error_event_test.go:27`; `postErrorPayload` helper posts a raw event body. Reuse them — do not write new seeding machinery.
- The `POST /api/v1/events` wire contract is frozen; this batch does not touch it. The read API (`/projects/...`) is not the frozen contract, but stay additive anyway.
- Commit after every task with the message given. No Claude attribution, no co-author lines.

---

### Task 1: Shared + dashboard types — `platform` on Incident, new `SampleEvent`

**Files:**
- Modify: `shared/src/types.ts` (Incident interface, ~line 221–252)
- Modify: `packages/dashboard/src/types/api.ts` (`IncidentFilters` at line ~238; local `Incident` mirror if present — grep `interface Incident` in that file)

**Step 1: Add to `shared/src/types.ts`** — inside `export interface Incident`, after `kind`:

```ts
  /** Platform wire token ('javascript', 'python', future tokens) for error
   *  incidents; null/absent for friction. Response fields stay `string` —
   *  ingestion accepts any valid token, and the UI must render unknown
   *  tokens rather than lie about them. Only the FILTER input is
   *  restricted to the two supported choices. */
  platform?: string | null;
```

And a new exported interface next to `Incident`:

```ts
/** Sample event for an error group, served by
 *  GET /projects/{projectId}/incidents/{incidentId}/sample-event.
 *  Mirrors sampleEventJSON in packages/ingestion/handler/read_api.go. */
export interface SampleEvent {
  timestamp: string; // ISO 8601
  platform: string;
  error: {
    type: string;
    message: string;
    stack: string;
  };
  /** ALWAYS an array: the endpoint normalizes non-array stored values
   *  (ingestion accepts any JSON for breadcrumbs — null/object/scalar can
   *  be stored) to [] before serving. Still narrow per-item with unknown. */
  breadcrumbs: unknown[];
  context: Record<string, unknown>;
}
```

**Step 2: Mirror in `packages/dashboard/src/types/api.ts`:** add `platform?: string | null;` to its `Incident`, add the same `SampleEvent` interface (or re-export), and extend `IncidentFilters` (filter input IS restricted — it drives the two UI choices):

```ts
  platform?: 'javascript' | 'python';
```

**Step 3: Verify**

Run: `pnpm --filter @opslane/shared build && pnpm --filter @opslane/dashboard build`
Expected: both pass (types are additive; nothing consumes them yet).

**Step 4: Commit** — `feat(shared): platform on Incident, SampleEvent contract for the dashboard read path`

---

### Task 2: DB read-through — `ErrorGroup.Platform` in both group SELECTs

**Files:**
- Modify: `packages/ingestion/db/queries.go` — `ErrorGroup` struct (line ~287), `ListErrorGroups` SELECT (line ~613), `GetErrorGroup` SELECT (line ~806), and both row-`Scan` calls
- Test: `packages/ingestion/handler/error_event_test.go` (append)

**Step 1: Write the failing test** (DB-backed; goes next to the other ingest tests):

```go
func TestIngest_PlatformReadBackThroughGroupQueries(t *testing.T) {
	deps, _ := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-19T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"boom","stack":"Traceback (most recent call last):\ngarbage"},"breadcrumbs":[],"context":{},"sdk_version":"0.1.0a2"}`
	response := postErrorPayload(t, deps, rawKey, body)

	groups, err := deps.Queries.ListErrorGroups(context.Background(), projectID, nil)
	if err != nil {
		t.Fatalf("list groups: %v", err)
	}
	if len(groups) != 1 || groups[0].Platform == nil || *groups[0].Platform != "python" {
		t.Fatalf("ListErrorGroups platform = %+v, want python", groups)
	}
	group, err := deps.Queries.GetErrorGroup(context.Background(), projectID, response["group_id"])
	if err != nil {
		t.Fatalf("get group: %v", err)
	}
	if group.Platform == nil || *group.Platform != "python" {
		t.Fatalf("GetErrorGroup platform = %v, want python", group.Platform)
	}
}
```

(`GetErrorGroup`'s signature is `(ctx, projectID, groupID)` — verified at `queries.go:806`.)

**Step 2: Run to verify it fails**

Run: `cd packages/ingestion && go test ./handler -run TestIngest_PlatformReadBackThroughGroupQueries -count=1`
Expected: compile error — `groups[0].Platform undefined`.

**Step 3: Implement**

- Add `Platform *string` to the `ErrorGroup` struct (nullable: friction incidents have no platform).
- Add `eg.platform` to **both** SELECT column lists (`ListErrorGroups` line 607 block and `GetErrorGroup` line ~802 block) and `&g.Platform` to the matching `Scan` calls, keeping column/scan order aligned.

**Step 4: Run to verify it passes** (same command). Also run `go build ./... && go vet ./db ./handler`.

**Step 5: Commit** — `feat(ingestion): read platform back through ListErrorGroups and GetErrorGroup`

---

### Task 3: `incidentJSON.platform` + unit test

**Files:**
- Modify: `packages/ingestion/handler/read_api.go` — `incidentJSON` struct (line 19), `toIncidentJSON` (line 67)
- Test: `packages/ingestion/handler/read_api_test.go` (append; these are pure unit tests, no DB)

**Step 1: Write the failing test**

```go
func TestToIncidentJSON_Platform(t *testing.T) {
	platform := "python"
	inc := toIncidentJSON(db.ErrorGroup{Platform: &platform})
	if inc.Platform == nil || *inc.Platform != "python" {
		t.Fatalf("platform = %v, want python", inc.Platform)
	}
	if got := toIncidentJSON(db.ErrorGroup{}); got.Platform != nil {
		t.Fatalf("friction incident platform should marshal as absent, got %v", got.Platform)
	}
}
```

**Step 2: Run to verify it fails** — `go test ./handler -run TestToIncidentJSON_Platform -count=1` → compile error.

**Step 3: Implement** — in `incidentJSON` add `Platform *string \`json:"platform,omitempty"\`` (place after `Kind`), and in `toIncidentJSON` add `Platform: g.Platform,`.

**Step 4: Run to verify it passes.**

**Step 5: Commit** — `feat(ingestion): expose platform in incident JSON`

---

### Task 4: Platform filter in `ListErrorGroups` (DB layer)

**Files:**
- Modify: `packages/ingestion/db/queries.go` — `ErrorGroupFilters` (line ~606), `ListErrorGroups` WHERE building (just below it)
- Test: `packages/ingestion/handler/error_event_test.go` (append)

**Step 1: Write the failing test.** Seed one python group (post an event as in Task 2), one javascript group (post a JS-stack event), and one friction incident (insert directly: look at how friction rows are created — grep `kind = 'friction'` or `friction` INSERTs in `queries.go`/test helpers and reuse; if there is no helper, insert a minimal `error_groups` row with `kind='friction'`, `platform IS NULL` via `pool.Exec`). Then:

```go
func TestListErrorGroups_PlatformFilter(t *testing.T) {
	// ...seeding as above...
	python := "python"
	got, err := deps.Queries.ListErrorGroups(ctx, projectID, &db.ErrorGroupFilters{Platform: python})
	// expect: exactly the python group
	all, err := deps.Queries.ListErrorGroups(ctx, projectID, nil)
	// expect: all three rows, friction included
}
```

Assert: platform filter returns ONLY the python error group (friction excluded even though its platform is NULL — the filter implies `kind = 'error'`); unfiltered list includes the friction row.

**Step 2: Run to verify it fails** — compile error on `Platform` field.

**Step 3: Implement** — add `Platform string` to `ErrorGroupFilters` with the comment `// filter by platform; implies kind='error' (friction incidents have no platform)`. In the WHERE-builder, following the existing `filters.Status` pattern:

```go
if filters.Platform != "" {
	wheres = append(wheres, fmt.Sprintf("eg.platform = $%d AND eg.kind = 'error'", argIdx))
	args = append(args, filters.Platform)
	argIdx++
}
```

**Step 4: Run to verify it passes** (needs `DATABASE_URL`).

**Step 5: Commit** — `feat(ingestion): platform filter on ListErrorGroups, scoped to error incidents`

---

### Task 5: Handler parses `?platform=` (with token validation)

**Files:**
- Modify: `packages/ingestion/handler/read_api.go` — `ListIncidents` (line 185), where it builds `db.ErrorGroupFilters` from query params
- Test: `packages/ingestion/handler/error_event_test.go` or `read_api_test.go` (DB-backed end-to-end through the router)

**Step 1: Write the failing test.** Reuse Task 4's seeding; hit the HTTP route:

```go
// GET /api/v1/projects/{projectID}/incidents?platform=python  → only python group
// GET ...?platform=Not%20A%20Token                            → 400 (or ignored — see Step 3)
```

**Step 3: Implement.** Read `r.URL.Query().Get("platform")`. Validate with the same token rule ingestion uses (`rePlatformToken` in `error_event.go:15` — it's package-level, reuse it). Invalid non-empty value → `writeJSONError(w, http.StatusBadRequest, "invalid platform")` (read side should be strict, unlike the lenient write side — a typo'd filter silently returning everything would mislead).

**Allocation gotcha (`read_api.go:193`):** the handler currently allocates `filters` ONLY when `accountID != "" || endUserID != "" || status != ""` — a platform-only request would leave `filters` nil and the value silently dropped. Add `platform != ""` to that condition AND `Platform: platform,` to the struct literal:

```go
if accountID != "" || endUserID != "" || status != "" || platform != "" {
	filters = &db.ErrorGroupFilters{
		AccountID: accountID,
		EndUserID: endUserID,
		Status:    status,
		Platform:  platform,
	}
}
```

The Step-1 test must include a platform-ONLY request (no other params) so a regression to the old condition fails it.

**Step 4: Run all handler tests** — `go test ./handler -count=1`.

**Step 5: Commit** — `feat(ingestion): platform query param on incident list`

---

### Task 6: `GetSampleEvent` query (DB layer)

**Files:**
- Modify: `packages/ingestion/db/queries.go` (append near the other read queries)
- Test: `packages/ingestion/handler/error_event_test.go` (append)

**Step 1: Write the failing test**

```go
func TestGetSampleEvent_TenantScopedRoundTrip(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-19T00:00:00Z","platform":"python","runtime":{"name":"cpython","version":"3.12.1"},"error":{"type":"ValueError","message":"No row was found","stack":"Traceback (most recent call last):\n  File \"/app/api/x.py\", line 1, in f\n    raise ValueError()\nValueError: No row was found"},"breadcrumbs":[{"type":"log","timestamp":"t","category":"app","level":"warning","message":"near expiry"}],"context":{},"sdk_version":"0.1.0a2"}`
	response := postErrorPayload(t, deps, rawKey, body)

	ev, err := deps.Queries.GetSampleEvent(context.Background(), projectID, response["group_id"])
	if err != nil {
		t.Fatalf("get sample event: %v", err)
	}
	if ev.ErrorType != "ValueError" || ev.Platform != "python" ||
		!strings.HasPrefix(ev.StackTraceRaw, "Traceback") {
		t.Fatalf("unexpected sample event: %+v", ev)
	}
	// Tenant scoping: a different project must not see it. Assert the
	// SPECIFIC no-rows error — `err != nil` would also pass on broken SQL
	// or connection failures and prove nothing about invisibility.
	_, otherProject, _, _ := seedTenant(t, deps.Queries)
	if _, err := deps.Queries.GetSampleEvent(context.Background(), otherProject, response["group_id"]); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-project sample event read must be pgx.ErrNoRows, got %v", err)
	}
}
```

(Check `seedTenant`'s return values — if calling it twice collides on fixed IDs, look at how other multi-tenant tests isolate; there is prior art in the auth/session tests.)

**Step 3: Implement** in `queries.go`:

```go
// SampleEvent is the representative event for an error group, used by the
// dashboard detail view. Tenant-scoped through the owning group's project_id.
type SampleEvent struct {
	Timestamp     time.Time
	Platform      string
	ErrorType     string
	ErrorMessage  string
	StackTraceRaw string
	Breadcrumbs   []byte // JSONB passthrough
	Context       []byte // JSONB passthrough
}

// GetSampleEvent returns the sample event for a group, scoped to the project.
// The candidate predicate matches GetErrorGroup (queries.go:806): ordinary
// candidate rows are hidden workflow records (issue #56) and must stay
// invisible through this read path too. The join REQUIRES the event to be in
// the same project as the group: sample_event_id has no FK or same-project
// constraint, so without `e.project_id = g.project_id` a corrupt pointer
// could disclose another tenant's event.
func (q *Queries) GetSampleEvent(ctx context.Context, projectID, groupID string) (*SampleEvent, error) {
	var ev SampleEvent
	err := q.pool.QueryRow(ctx,
		`SELECT e."timestamp", e.platform, e.error_type, e.error_message,
		        e.stack_trace_raw, e.breadcrumbs, e.context
		 FROM error_groups g
		 JOIN error_events e ON e.id = g.sample_event_id AND e.project_id = g.project_id
		 WHERE g.id = $1 AND g.project_id = $2
		   AND (g.status <> 'candidate' OR g.adjudication_status = 'unchecked')`,
		groupID, projectID,
	).Scan(&ev.Timestamp, &ev.Platform, &ev.ErrorType, &ev.ErrorMessage,
		&ev.StackTraceRaw, &ev.Breadcrumbs, &ev.Context)
	if err != nil {
		return nil, err
	}
	return &ev, nil
}
```

Note the JOIN handles the friction case for free: friction incidents have no `sample_event_id`, so the join is empty → `pgx.ErrNoRows`.

**Additional Step-1 test case — hidden candidates stay hidden:** after the round-trip assertions, flip the group to an ordinary candidate and assert the read disappears:

```go
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups SET status = 'candidate', adjudication_status = NULL WHERE id = $1`,
		response["group_id"]); err != nil {
		t.Fatalf("hide group as ordinary candidate: %v", err)
	}
	if _, err := deps.Queries.GetSampleEvent(context.Background(), projectID, response["group_id"]); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("hidden candidate's sample event must be pgx.ErrNoRows, got %v", err)
	}
```

(`adjudication_status` — per `007_friction_adjudication.sql:66`, the CHECK allows only `'unchecked'` or NULL. An ordinary hidden candidate is `status='candidate', adjudication_status=NULL`; there is no `'confirmed'` value.)

**Step 4: Run to verify it passes.**

**Step 5: Commit** — `feat(ingestion): GetSampleEvent query, tenant-scoped through the owning group`

---

### Task 7: Sample-event endpoint + server-side header deny-list

**Files:**
- Modify: `packages/ingestion/masking/masking.go` (expand + export the sensitive-header policy) and `packages/ingestion/masking/masking_test.go`
- Modify: `packages/ingestion/handler/read_api.go` (new handler + JSON type + header filter)
- Modify: `packages/ingestion/handler/routes.go` (route registration — session-only, see below)
- Modify: `docs/reference/http-routes.md` — document the new route. NOT optional: `scripts/check-docs-drift.mjs:93` fails the root `pnpm test` gate for any registered-but-undocumented route.
- Test: `packages/ingestion/handler/read_api_test.go` (unit: header filter) and `error_event_test.go` (integration: endpoint)

**Step 1: Write the failing unit test for the filter** (no DB). Cover EVERY deny-listed key and mixed-case variants — the stored JSON keys come from clients, not from Go's canonicalized `http.Header`:

```go
func TestFilterSensitiveHeaders(t *testing.T) {
	in := map[string]json.RawMessage{"content-type": json.RawMessage(`"application/json"`)}
	for _, k := range []string{
		"Authorization", "PROXY-AUTHORIZATION", "authentication",
		"Cookie", "set-cookie", "x-api-key", "X-CSRF-Token",
		"x-auth-token", "X-Access-Token", "x-amz-security-token",
	} {
		in[k] = json.RawMessage(`"secret"`)
	}
	out := filterSensitiveHeaders(in)
	if len(out) != 1 {
		t.Fatalf("expected only content-type to survive, got %v", out)
	}
	if _, ok := out["content-type"]; !ok {
		t.Fatal("benign header must survive")
	}
}
```

**Step 2: Write the failing integration test** — POST an event whose `context` includes `request.headers` with `Authorization` (note: the SDK strips it client-side, so build the body by hand — this test is exactly the defense-in-depth case of a non-SDK client), then:

```go
// GET /api/v1/projects/{projectID}/incidents/{groupID}/sample-event
// via handler.NewRouter(deps), authenticated with a USER SESSION —
// see how auth_middleware_test.go / session-authenticated handler tests
// mint a session cookie, and copy that setup exactly.
```

Assert: 200; body has `error.type`, `error.stack` starting `Traceback`, breadcrumbs array; `context.request.headers` lacks `authorization` but keeps `content-type`; `context.request.remote_addr` passes through if present; `Cache-Control: no-store` response header set (this endpoint returns stack traces, headers, client IPs, and user identity — it must never be cached; mirror the explicit cache policies on `embedded_auth.go:101` / `session_read.go:262`). Second case: unknown incident ID → 404. Third case: incident from another project → 404 (not 403 — do not leak existence). Careful: `verifyProjectAccess` (`read_api.go:169`) returns 403 for a project outside the caller's org BEFORE the incident lookup — so to test non-disclosure, use a second project in the SAME org (accessible to the caller) with the first project's incident ID. Fourth case: SDK-key auth (`X-API-Key` as in `postErrorPayload`) → 401. Fifth case: POST an event whose `context.request.headers` is a NON-OBJECT (e.g. `[["Authorization","secret"]]`) — the response's `request.headers` must be absent or `{}`, never the raw value.

**Step 3: Implement.**

**Single source of truth: extend `packages/ingestion/masking/masking.go`, don't create a second Go deny-list.** `masking.sensitiveHeaders` (masking.go:11) already owns sensitive-header policy but predates Batch 1's expanded SDK list (it has 5 entries; the SDK's `DEFAULT_SENSITIVE_HEADERS` in `packages/sdk-python/opslane/client.py` has 10). In the masking package:

1. Add the missing entries: `proxy-authorization`, `authentication`, `x-auth-token`, `x-access-token`, `x-amz-security-token`. This is strictly-more redaction at ingest time — safe by direction — and it aligns write-side masking with the SDK. Extend the masking package's own tests (`packages/ingestion/masking/masking_test.go`) for the new names.
2. Export a predicate for read-side reuse:

```go
// IsSensitiveHeader reports whether a header name (any case) must never be
// exposed or persisted in cleartext. Single source of truth for write-side
// redaction and read-side filtering.
func IsSensitiveHeader(name string) bool {
	_, ok := sensitiveHeaders[strings.ToLower(name)]
	return ok
}
```

Then in `read_api.go`, `filterSensitiveHeaders(map[string]json.RawMessage) map[string]json.RawMessage` — copy minus keys where `masking.IsSensitiveHeader(key)`. (Read-side filtering still matters even though write-side masking now redacts these: rows ingested before the expansion carry unredacted values.)

**Read-side redaction must cover the WHOLE payload, not just `request.headers`.** Sensitive values can sit anywhere in historical `context` and `breadcrumbs` (the pre-expansion write-side list missed 5 header names, and breadcrumb messages/URLs were never key-filtered). The masking package already has recursive redaction: `masking.RedactContext` and `masking.RedactBreadcrumbs` (masking.go:95/159, both walking `redactValue` at masking.go:126). Run the stored `context` and `breadcrumbs` bytes through those on the way out, THEN apply `filterSensitiveHeaders` to `request.headers` (key-drop is stronger than value-redaction for headers). Verify what `redactValue` actually catches before relying on it — extend it only if a gap shows up in the tests.

**Malformed sub-objects are dropped, not passed through.** If `context.request` or `context.request.headers` fails to unmarshal into a JSON object, REMOVE that node (replace `headers` with `{}` / omit `request`), and never 500. Pass-through would defeat the filter: ingestion accepts arbitrary JSON, so `headers: [["Authorization","secret"]]` is storable, bypasses a map-shaped filter, and would be served verbatim to the browser.

`sampleEventJSON`:

```go
type sampleEventJSON struct {
	Timestamp   string          `json:"timestamp"`
	Platform    string          `json:"platform"`
	Error       sampleErrorJSON `json:"error"`
	Breadcrumbs json.RawMessage `json:"breadcrumbs"`
	Context     json.RawMessage `json:"context"`
}
type sampleErrorJSON struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
}
```

Handler `GetSampleEvent` (mirror `ListAffectedUsers`'s shape: chi URL params, `verifyProjectAccess`, then):
- `deps.Queries.GetSampleEvent(ctx, projectID, incidentID)`; `pgx.ErrNoRows` → 404 `"no sample event"`.
- Redact `Breadcrumbs`/`Context` bytes via `masking.RedactBreadcrumbs`/`masking.RedactContext`; then unmarshal `Context` into `map[string]json.RawMessage`; if it has `request`, unmarshal that into `map[string]json.RawMessage`, filter its `headers` object through `filterSensitiveHeaders` (drop the node if it isn't an object — see above), re-marshal.
- Normalize `Breadcrumbs`: if the stored bytes aren't a JSON array, serve `[]` — the `SampleEvent` contract promises an array and the UI iterates it.
- Set `Cache-Control: no-store` on the response.
- Marshal `sampleEventJSON` with breadcrumbs/context as `json.RawMessage`.

Route in `routes.go` — **session-only auth, deliberately stricter than the other incident reads**:

```go
r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/incidents/{incidentID}/sample-event", deps.GetSampleEvent)
```

Why: browser SDK keys are necessarily client-visible (`packages/sdk/src/transport.ts`), and this endpoint returns request headers, client IPs, and user identity. A leaked/extracted SDK key must not become a PII read path. `AuthenticateUserSession` (see `routes.go:89-108` for usage) restricts it to logged-in dashboard users; `verifyProjectAccess` still applies for org scoping. If a rate limiter wraps the adjacent incident routes, carry it too.

**Additional integration test case:** the same request authenticated with the SDK API key (the `X-API-Key` header pattern from `postErrorPayload`) must get **401**, not data.

**Step 4: Run** — `go test ./handler -count=1` (with `DATABASE_URL`). All pass.

**Step 5: Commit** — `feat(ingestion): tenant-scoped sample-event endpoint with server-side header deny-list`

---

### Task 8: Dashboard API client

**Files:**
- Modify: `packages/dashboard/src/api.ts` — `listIncidents` (line ~526), new `getSampleEvent`
- Test: new colocated api test (fetch-mock pattern — see below)

**Step 1: Implement:**

In `listIncidents`, after the `status` param: `if (filters?.platform) params.set('platform', filters.platform);`

New function, following `fetchJSON` conventions in the same file:

```ts
export function getSampleEvent(
  projectId: string,
  incidentId: string
): Promise<SampleEvent> {
  return fetchJSON<SampleEvent>(
    `/projects/${projectId}/incidents/${incidentId}/sample-event`
  );
}
```

Import `SampleEvent` from the types module the file already uses.

**Step 2: Test.** The dashboard DOES have HTTP-client tests that mock `fetch` — `packages/dashboard/src/api-project-settings.test.ts` and `api-notifications.test.ts`. Copy that pattern into a colocated test asserting: `listIncidents` with `{platform: 'python'}` requests a URL containing `platform=python` (and omits it when unset), and `getSampleEvent('p1','i1')` requests `/projects/p1/incidents/i1/sample-event`. Type-checking alone can't catch a wrong path or dropped query param.

**Step 3: Verify** — `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build`.

**Step 4: Commit** — `feat(dashboard): sample-event fetch and platform filter param`

---

### Task 9: Platform filter UI + badge

**Files:**
- Modify: `packages/dashboard/src/components/FilterBar.vue` (emits `filter-change` with `IncidentFilters` — line 12/31)
- Modify: `packages/dashboard/src/views/ActivityFeed.vue` (table row, near the Kind badge at line 153–231)
- Create: `packages/dashboard/src/components/platform-badge.ts` + colocated test `packages/dashboard/src/components/platform-badge.test.ts` (mirror `incident-kind.ts` and its test at `components/incident-kind.test.ts` — colocated next to the module, NOT under `__tests__/` — read both first and copy their shape)

**Step 1: Write the failing badge-helper test** (pattern-match `incident-kind.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { platformBadge } from './platform-badge';

describe('platformBadge', () => {
  it('labels javascript and python', () => {
    expect(platformBadge('javascript')?.label).toBe('JavaScript');
    expect(platformBadge('python')?.label).toBe('Python');
  });
  it('returns null for absent platform (friction incidents)', () => {
    expect(platformBadge(null)).toBeNull();
    expect(platformBadge(undefined)).toBeNull();
  });
  it('renders unknown future tokens verbatim rather than hiding them', () => {
    expect(platformBadge('ruby')?.label).toBe('ruby');
  });
});
```

**Step 2: Run to verify it fails** — `pnpm --filter @opslane/dashboard test` → module not found.

**Step 3: Implement** `platform-badge.ts` (styling: copy the class conventions from `incident-kind.ts` so badges match visually):

```ts
export interface PlatformBadge {
  label: string;
  class: string; // named `class`, matching incident-kind.ts:5 — do not invent `classes`
}

const KNOWN: Record<string, string> = {
  javascript: 'JavaScript',
  python: 'Python',
};

export function platformBadge(
  platform: string | null | undefined
): PlatformBadge | null {
  if (!platform) return null;
  return {
    label: KNOWN[platform] ?? platform,
    class: '<copy badge class values from incident-kind.ts>',
  };
}
```

**Step 4: FilterBar** — add a platform `<select>` next to the existing status filter (read the current template first and match its markup): options All (empty) / JavaScript / Python. The existing filters have THREE synchronization touchpoints (see `selectedStatus` for the pattern, FilterBar.vue:15-45) and platform needs all three or a reload silently drops it:

1. **Init from the URL — validated, not cast:** a raw cast lets `?platform=ruby` (or any garbage) through the `'javascript' | 'python'` type and would send an invalid token the server now 400s. Accept only known values:
   ```ts
   const rawPlatform = route.query['platform'];
   const selectedPlatform = ref(
     rawPlatform === 'javascript' || rawPlatform === 'python' ? rawPlatform : ''
   );
   ```
2. **Emit:** in `emitFilters()`, `if (selectedPlatform.value) filters.platform = selectedPlatform.value;` (already narrowed by step 1 — no cast needed).
3. **URL sync:** in `onFilterChange()`, set `query['platform']` when non-empty, `delete query['platform']` when empty — exactly mirroring the `status` branch.

Note: FilterBar syncs the URL with `router.replace` (FilterBar.vue:37/54), so filter changes create no history entries and browser-Back restore is NOT how the existing filters behave. Match that existing behavior — do not switch to `push` for this batch. The manual check is reload-only: apply the Python filter, reload the page → filter still applied.

**End-user filter passthrough (required for Task 11's acceptance criterion):** the server supports `?end_user_id=` but the dashboard currently DROPS it — FilterBar neither reads nor emits it (FilterBar.vue:18), so on mount it emits filters without `end_user_id` and any user-scoped URL loses its scope. Fix in the same three-touchpoint pattern, minus UI: read `route.query['end_user_id']` (string, no validation set — it's an opaque ID), carry it through `emitFilters()` and the URL sync, but render no visible control for it. This makes `/…?end_user_id=X` a working cross-stack user timeline.

**ActivityFeed** — render the platform badge in the Kind column cell next to the kind badge, `v-if` on `platformBadge(incident.platform)`.

**Step 5: Run** — `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build`.

**Step 6: Commit** — `feat(dashboard): platform filter and badge on the activity feed`

---

### Task 10: IncidentDetail — traceback, breadcrumbs, request context

**Files:**
- Modify: `packages/dashboard/src/views/IncidentDetail.vue` (Overview tab; lines ~383–396 are the root-cause markup — the metadata/dl region starts around line 529)
- Reuse: `packages/dashboard/src/components/CodeBlock.vue` (pre/code + copy button)

**Step 1: Implement** (component test after — the fetch logic is the testable seam):

In `<script setup>`: after `getIncident()` resolves and `incident.kind === 'error'`, call `getSampleEvent(projectId, incidentId)`; store in `sampleEvent = ref<SampleEvent | null>(null)`. Error isolation matters: **only the `getIncident` fetch is page-fatal.** A sample-event 404 → `sampleEvent = null`, section simply absent (friction groups and groups whose sample event was pruned have none). A sample-event 500/network error → set a LOCAL `sampleEventError` ref and render a small inline "couldn't load stack trace" note in that section — never blank or error out the otherwise-usable incident page.

In the Overview tab template, above the AI root-cause block:

```html
<!-- Wrapper renders when EITHER the data or the error exists — a section
     gated only on sampleEvent has nowhere to show the fetch-error note,
     because on a 500 sampleEvent is null. -->
<section v-if="sampleEvent || sampleEventError" class="...">
  <p v-if="sampleEventError">Couldn't load stack trace.</p>
  <template v-if="sampleEvent">
  <h3>Stack trace</h3>
  <CodeBlock :code="sampleEvent.error.stack" />
  <div v-if="requestContext" class="...">
    <h3>Request</h3>
    <dl>
      <div><dt>Method</dt><dd>{{ requestContext.method }}</dd></div>
      <div><dt>Path</dt><dd>{{ requestContext.path }}</dd></div>
      <div v-if="requestContext.remote_addr"><dt>Client IP</dt><dd>{{ requestContext.remote_addr }}</dd></div>
    </dl>
    <details v-if="requestContext.headers">
      <summary>Headers</summary>
      <dl><!-- k/v rows from requestContext.headers --></dl>
    </details>
  </div>
  <div v-if="sampleEvent.breadcrumbs.length">
    <h3>Breadcrumbs</h3>
    <ol><!-- per crumb: timestamp, type/category chip, level, message —
         each crumb is `unknown`: narrow per-field before rendering --></ol>
  </div>
  </template>
</section>
```

with `requestContext` a computed narrowing `sampleEvent.context.request` (use `unknown` + narrowing, never `any` — repo rule). Python tracebacks are already human-readable text; `CodeBlock` renders both platforms — no syntax highlighting, no platform branch in the template (the design explicitly says `<pre>`-class rendering is enough).

Match the surrounding markup/classes of the existing Overview sections — read the neighboring sections and copy their container classes rather than inventing new styling.

**Step 2: Component test** — `packages/dashboard/src/views/__tests__` ALREADY EXISTS; read a test there for the route/API mocking pattern and add a mount test for IncidentDetail covering: sample-event section renders on success; 404 → section absent, page fine; 500 → inline error note, page fine; friction incident → no fetch or no section. A helper-only test is NOT an acceptable substitute — the fetch wiring, 404-vs-500 branching, and page-fatal isolation are exactly the seams that need coverage. Additionally extract the `requestContext` narrowing + breadcrumb formatting into a small `sample-event.ts` helper and unit-test that too if it keeps the mount test simpler.

**Step 3: Run** — `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build`.

**Step 4: Commit** — `feat(dashboard): render sample-event traceback, request context, and breadcrumbs`

---

### Task 11: Cross-stack user timeline — verification test

**Files:**
- Test: `packages/ingestion/handler/error_event_test.go` (append)

This is **verification, not construction** (design §8.5). The "user timeline" surface is **ActivityFeed filtered by `end_user_id`** — which did NOT work until Task 9's end-user passthrough fix (the server supported `?end_user_id=` but FilterBar dropped it on mount). With that fix plus the badge, the user-scoped URL lists one user's incidents across both platforms. No new dashboard surface is in scope; issue #88's criterion is met by that filtered feed, and this task proves the data layer plus the HTTP path behind it (the smoke in Task 12 proves the dashboard leg).

**Step 1: Write the test.** POST two events through `postErrorPayload`: one JS-shaped (no `platform`, JS stack), one Python-shaped, both with `context.user.id = "cross-stack-user"`. Then assert at BOTH layers:
- `ListErrorGroups(ctx, projectID, &db.ErrorGroupFilters{EndUserID: "cross-stack-user"})` returns both groups — one platform `javascript`, one `python`.
- `GET /api/v1/projects/{projectID}/incidents?end_user_id=cross-stack-user` through the router returns both, each carrying its `platform` in the JSON (this is the exact request the dashboard's user-filtered feed makes).

**Step 2: Run** — with `DATABASE_URL`. If this fails, the bug is in end-user upsert reuse; investigate before patching (it may be a test-setup issue — both events must share the seeded tenant).

**Step 3: Commit** — `test(ingestion): one end user spans JS and Python error groups`

---

### Task 12: Full gate + live smoke

**Step 1: Repo gate**

```bash
pnpm install --frozen-lockfile && pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go vet ./... && DATABASE_URL=... go test ./... -count=1)
docker compose config --quiet
```

All green, with the disposable-DB `DATABASE_URL` from the ground rules.

**Step 2: Live smoke (seeded mixed-platform data).** Boot an ISOLATED compose stack (do not clobber 5434/8082 — check `docker ps`; the Batch 1 review used a rendered-config override at ports 5461/9061/8093, same trick works: `docker compose config | sed` the published ports, `-p b2-smoke`). Then:
1. Apply migrations + `scripts/seed-e2e.sql`.
2. POST one JS event and two Python events (same Python fingerprint) with `context.user.id` shared across one JS + one Python event — reuse the wire fixtures as bodies.
3. **Mint a dashboard session first** — the sample-event route and the dashboard are session-auth'd, and the default compose stack gives you NO way to log in: `AUTH_PROVIDER` defaults to the GitHub provider with empty OAuth credentials, and that provider doesn't implement `PasswordAuthenticator` (`github_provider.go:13`), so `seed-e2e.sql`'s password users are unusable. Mint the session directly the way `test-e2e/helpers.ts:304` (`generateTestJWT`) does: insert a user row for the seeded org, sign an HS256 JWT (`sub`, `org_id`, `email`, `iat`, `exp`) with the stack's `JWT_SECRET`, and present it the way `AuthenticateUserSession` expects (cookie or bearer — copy what the e2e helpers do). Then:
   - `GET /api/v1/projects/{id}/incidents` (SDK key is fine for the list routes) → both groups carry `platform`; `?platform=python` returns only the Python group.
   - `GET .../incidents/{pythonGroupID}/sample-event` **with the session JWT — an SDK key must get 401 here, per Task 7's auth contract** → traceback + breadcrumbs, headers filtered, `Cache-Control: no-store`.
   - Dashboard at the mapped port (browser carrying the session cookie): platform badges visible, filter works and survives a page reload (URL sync), Python incident detail shows the traceback, and the activity feed filtered to the shared user (`?end_user_id=...`) shows both the JS and Python incidents with their badges.
4. Tear down (`docker compose -p b2-smoke down -v`).

**Step 3: Update docs** — `docs/contracts/` untouched (ingest contract unchanged). If `docs/architecture/*` or dashboard docs describe the incident detail view, note the new sample-event section (check `docs/` with grep for "incident detail").

**Step 4: Commit anything outstanding; run `/review changes` before `/ship`.**

---

## Acceptance criteria (from issue #88 — every box must have evidence)

- [ ] Sample-event endpoint returns the traceback, tenant-scoped, header deny-list applied server-side (Tasks 6–7 tests)
- [ ] Filter + badge work against seeded mixed-platform data; friction incidents appear only under "All" (Tasks 4–5, 9; smoke)
- [ ] Python traceback renders legibly; JS incidents unchanged-or-improved via the same endpoint (Task 10; smoke)
- [ ] A user with one JS and one Python error shows both in their timeline (Task 11; smoke)
- [ ] No `any` types; `pnpm --filter @opslane/dashboard build` passes (every dashboard task)

## Explicitly out of scope

- Worker/agent changes (Batch 3, #89). Real-PyPI release. Runtime display beyond what `context.runtime` already carries. Backlog issues #102–#105 unless one blocks a task.
