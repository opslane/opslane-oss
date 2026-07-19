# Notifications event bus + Slack destination — design

Date: 2026-07-19
Status: draft v4 (revised after Codex review rounds 1–3)

## Goal

When Opslane creates a new issue (error group), send a Slack notification.
Build it on a small internal event bus so future destinations (generic
webhooks, email, PagerDuty) and future event types (`issue.needs_human`,
`issue.pr_created`) are additive changes, not redesigns.

## Decisions (settled with the user)

| Decision | Choice |
| --- | --- |
| Slack connection | Pasted-in Slack incoming-webhook URL. No OAuth app. |
| v1 event types | `issue.created` only. |
| Delivery runtime | Go ingestion service (background dispatcher goroutine). |
| Subscription scope | Per project. |
| Destination types | `slack` only, but the schema carries a `type` column so generic webhooks are a follow-up PR. |

## Architecture

Transactional outbox in Postgres — the same pattern as the existing
`error_group_jobs` queue. No Redis, no new infra (per AGENTS.md guardrail).

1. **Publish** — Go ingestion. Inside the same transaction that creates a
   new error group (`InsertErrorEventAndGroup`, `is_new` branch,
   `packages/ingestion/db/queries.go:509`), write one event row and fan out
   one delivery row per matching destination.
2. **Dispatch** — a goroutine in the ingestion process claims due
   deliveries with a lease (mirroring `error_group_jobs` semantics),
   formats the payload per destination type, POSTs it, and retries with
   backoff. Ingestion is always running, so notifications work even when
   the Node worker is down.
3. **Configure** — new "Integrations" tab in the dashboard project
   settings, backed by CRUD endpoints in the ingestion API.

### Accepted trade-off: outbox insert lives in the ingest transaction

Putting the publish inside `InsertErrorEventAndGroup` means **any** failure
of the outbox statements — missing schema, constraint violation, deadlock,
disk exhaustion, connection loss — rolls back the customer's error event.
This is the price of the atomicity guarantee (no lost events, no events
for rolled-back issues) and we accept it deliberately. Mitigations:

- The publish is fixed SQL with no fallible application logic (see
  "Publish flow" — every step is either in-transaction SQL or a pure
  function that cannot error).
- The delivery path (HTTP, formatting, retries) is fully outside the
  transaction; only the outbox inserts are inside.
- Migrations run before the server serves traffic, so missing schema
  cannot occur in a running process.

## Data model (migration `018_notifications.sql`)

Migrations are re-applied on every boot (see `migrations_test.go`), so all
DDL is idempotent: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
EXISTS`, guarded `DO $$` blocks — same style as `001_baseline.sql`.

```sql
CREATE TABLE IF NOT EXISTS notification_destinations (
  id UUID PRIMARY KEY,                         -- generated app-side (bound into encryption AAD)
  project_id UUID NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL DEFAULT 'slack' CHECK (type IN ('slack')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  config_encrypted BYTEA NOT NULL,             -- sealed JSON: {"webhook_url": "..."} (format below)
  config_fingerprint TEXT NOT NULL,            -- masked display form, e.g. "hooks.slack.com/…/****abcd"
  event_types TEXT[] NOT NULL DEFAULT '{issue.created}'
    -- cardinality(), not array_length(): array_length('{}',1) is NULL and
    -- NULL CHECKs pass, so empty arrays would slip through
    CHECK (cardinality(event_types) >= 1 AND event_types <@ ARRAY['issue.created']),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_destinations_project
  ON notification_destinations(project_id);

CREATE TABLE IF NOT EXISTS outbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('issue.created')),
  dedup_key TEXT NOT NULL,                     -- producer idempotency, e.g. 'issue.created:<group_id>'
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, dedup_key)               -- tenant-scoped: one tenant cannot suppress another's key
);

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES outbound_events(id) ON DELETE CASCADE,
  destination_id UUID NOT NULL REFERENCES notification_destinations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ,
  lease_generation BIGINT NOT NULL DEFAULT 0,  -- fencing token (same pattern as error_group_jobs)
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, destination_id)            -- one delivery row per event × destination
);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_claimable
  ON outbound_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_stale
  ON outbound_deliveries(lease_expires_at) WHERE status = 'delivering';
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_event
  ON outbound_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_destination_updated
  ON outbound_deliveries(destination_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_prune
  ON outbound_deliveries(updated_at) WHERE status <> 'pending';
```

- Extending `event_type`/`event_types` to new values = a follow-up
  migration altering the CHECKs, consistent with the repo's
  `ALTER TYPE ... ADD VALUE` pattern for enums.
- `UNIQUE (project_id, dedup_key)` is **producer** idempotency: if the
  same logical event is ever published twice (e.g. a future worker emitter
  retrying), the insert is `ON CONFLICT (project_id, dedup_key) DO
  NOTHING` and fan-out is gated on a row actually being inserted. `UNIQUE (event_id, destination_id)`
  is consumer-side: one delivery row per event × destination.
- Naming note: `outbound_*` distinguishes these from `error_events`
  (inbound SDK wire events) and the frozen `POST /api/v1/events` contract,
  which this feature does not touch.

### Webhook URL encryption (guardrail compliance)

The Slack webhook URL is a credential and is **never stored in plaintext**.

- **Key**: 32 bytes via HKDF-SHA256 over `JWT_SECRET` with info label
  `opslane/notification-destination-config/v1`. (HKDF precedent:
  `packages/ingestion/auth/agentkey.go`; that helper itself is an X25519
  sealed-box and is *not* reused — this is a new small symmetric helper in
  the `notify` package. `golang.org/x/crypto/hkdf` is already a
  dependency.)
- **Format**: `nonce (12 bytes, crypto/rand) || AES-256-GCM ciphertext`.
- **AAD**: `destination_id || project_id || type` — binds the ciphertext
  to its row so it cannot be transplanted across destinations, projects,
  or tenants. This is why `notification_destinations.id` is generated
  app-side before insert. URL replacement re-seals with the same AAD.
- Documented caveat: rotating `JWT_SECRET` invalidates stored destination
  configs; users re-enter webhook URLs. Acceptable for v1 and documented
  in `docs/reference/environment-variables.md`.
- `config_fingerprint` stores the masked display form (host + last 4
  chars) so list endpoints never decrypt.
- `last_error` never contains the webhook URL; response bodies are capped
  (see retry policy).

## Publish flow

In the `is_new` branch of `InsertErrorEventAndGroup`, after the group and
job rows are written, still inside the transaction. Ordered so the
no-subscriber case exits after one cheap indexed query, and so no fallible
Go code sits between ingest and commit:

1. `SELECT id FROM notification_destinations WHERE project_id = $1 AND
   enabled AND 'issue.created' = ANY(event_types) LIMIT 1` — if no row,
   **stop**: nothing else runs (one indexed lookup is the entire overhead
   for projects without integrations; no event/delivery writes, no name
   lookups).
2. `SELECT p.name, e.name FROM projects p, environments e WHERE ...` —
   project/environment names for the payload (`IngestParams` carries only
   IDs). Two PK lookups inside the tx; an SQL error here fails the
   transaction, consistent with the atomicity trade-off — there is no
   "skip publish on error" path, because a skipped publish would silently
   lose a notification.
3. Build the payload in Go: plain-struct `json.Marshal` plus a pure
   URL-builder (invalid/absent `DASHBOARD_URL` deterministically omits the
   link). A `json.Marshal` error — vanishingly unlikely on plain structs
   but possible — fails the transaction like any other publish error;
   there is no skip path.
4. One CTE writes event + deliveries, gated on matching destinations and
   on producer dedup:

```sql
WITH dests AS (
  SELECT id FROM notification_destinations
  WHERE project_id = $1 AND enabled AND $2 = ANY(event_types)
), ev AS (
  INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
  SELECT $1, $2, $3, $4
  WHERE EXISTS (SELECT 1 FROM dests)
  ON CONFLICT (project_id, dedup_key) DO NOTHING
  RETURNING id
)
INSERT INTO outbound_deliveries (event_id, destination_id)
SELECT ev.id, dests.id FROM ev CROSS JOIN dests;
```

v1 `dedup_key` is `issue.created:<error_group_id>` — a brand-new group
publishes exactly once even if grouping logic ever double-fires.

Trade-off accepted: events are not retroactively deliverable to
destinations added later — expected semantics for notifications.

### Payload (`issue.created`)

```json
{
  "version": 1,
  "event_type": "issue.created",
  "issue": {
    "id": "…",
    "title": "TypeError: x is not a function",
    "first_seen": "2026-07-19T…Z"
  },
  "project": { "id": "…", "name": "storefront" },
  "environment": "production",
  "dashboard_url": "https://app.example.com/incidents/<id>?project_id=<pid>"
}
```

- No `status` field: the same transaction moves the group to `queued`, so
  a status snapshot would publish a state that never exists externally.
- `version: 1`, add-only: this shape becomes the public generic-webhook
  body later.
- `dashboard_url` mirrors the worker's reader-facing link contract
  (`buildIncidentUrl`, `packages/worker/src/narrative.ts:204`): built from
  a new ingestion env var `DASHBOARD_URL` (same name/semantics as the
  worker's — explicit HTTP(S), loopback rejected, credentials rejected),
  path `/incidents/{id}?project_id={pid}`. Omitted when unset or invalid.
  `DASHBOARD_ORIGIN` (a CORS setting) is intentionally **not** used and
  not a fallback — same rule the worker follows.

## Dispatcher (Go, in ingestion)

New package `packages/ingestion/notify`. Claim semantics mirror the
existing `error_group_jobs` queue: explicit in-flight status + lease +
reaper. This removes the round-2 races (a `delivering` row is untouchable
until its lease expires, and the lease outlives any in-flight request).

- `Dispatcher` — started from `main.go` as a goroutine with the pgx pool
  and a context. Lifecycle honesty: `main.go` has no graceful shutdown
  (blocking `ListenAndServe`); we do not refactor that. Process death
  stops the goroutine mid-flight; the lease reaper makes such rows
  claimable again. Poll interval 5s, batch size 10.
- **Claim** (attempts are consumed at claim time; exhausted rows are never
  claimed):

```sql
UPDATE outbound_deliveries d SET
  status = 'delivering',
  attempts = d.attempts + 1,
  lease_generation = d.lease_generation + 1,
  lease_expires_at = now() + interval '90 seconds',
  updated_at = now()
WHERE d.id IN (
  SELECT id FROM outbound_deliveries
  WHERE status = 'pending'
    AND next_attempt_at <= now()
    AND attempts < max_attempts
  ORDER BY next_attempt_at LIMIT 10
  FOR UPDATE SKIP LOCKED
)
RETURNING d.id, d.event_id, d.destination_id, d.attempts, d.max_attempts,
          d.lease_generation;
```

- **Deliver**: claimed rows are delivered **concurrently** (one goroutine
  per row, bounded by the batch size), so batch wall-time is bounded by
  the 10s HTTP timeout — far inside the 90s lease. Each delivery
  goroutine wraps its work in its own `defer recover()` (a recover in the
  batch loop cannot catch a child goroutine's panic; an uncaught panic in
  any goroutine kills the process); a recovered panic is treated as a
  retryable failure.
- **Fenced completion** (same guard pattern as `error_group_jobs`,
  `packages/worker/src/db.ts:217`): every post-attempt update carries the
  claim's fencing token and only lands if the claim is still current —
  `WHERE id = $1 AND status = 'delivering' AND lease_generation = $2`. A
  stale claimant (its lease expired, the row was reaped and possibly
  re-claimed) matches zero rows and its result is discarded — it can
  never clobber a newer claim. Outcomes, using the `attempts` and
  `max_attempts` returned by the claim:
  - Success → `status = 'delivered'`, `delivered_at = now()`.
  - Retryable failure and `attempts < max_attempts` → `status =
    'pending'`, `next_attempt_at = now() + backoff(attempts)`,
    `last_error` recorded.
  - Retryable failure and `attempts >= max_attempts`, or permanent
    failure → `status = 'failed'` + WARN log.
- **Reaper** (each loop, using the stale index): `delivering` rows with
  `lease_expires_at < now()` (crashed mid-flight) go back to `pending`
  with `next_attempt_at = now() + backoff(attempts)` — or to `failed
  ('lease expired on final attempt')` when attempts are exhausted. Only
  expired leases are touched (90s lease vs 10s request cap), and any
  late-finishing stale claimant is fenced out by `lease_generation`.
- Backoff schedule: 30s, 2m, 10m, 30m, 1h (5 attempts total).
- **Delivery contract stated precisely**: at-least-once *per attempt
  budget*. Duplicates are possible (crash after POST, before the
  `delivered` update). Loss is possible only when all `max_attempts`
  claims fail to produce a 2xx — including pathological cases like a
  crash-looping process consuming claims without completing requests —
  and every such exhaustion terminates in a visible `failed` row + WARN
  log + metric, never a silent drop.

### Retry policy (HTTP result classification)

| Result | Classification |
| --- | --- |
| 2xx | delivered |
| 429 | retry; honor `Retry-After` (both delta-seconds and HTTP-date forms; invalid/absent → default backoff; capped at 1h) |
| 408 | retry with backoff |
| Other 4xx (incl. Slack 404 `no_service`, 403 `invalid_token`, 400 payload errors) | permanent → `failed` immediately |
| 3xx (redirect attempted) | permanent → `failed` (webhooks must not redirect; `CheckRedirect` refuses) |
| 5xx, network error, timeout | retry with backoff |

Response bodies are read with a 4 KB cap; `last_error` stores status code
plus the first 500 chars, never the webhook URL.

### Formatter interface (the extensibility seam)

```go
type Formatter interface {
    // Format renders the outbound HTTP request body for one event.
    Format(event Event, dest Destination) (body []byte, contentType string, err error)
}
// registry: map[string]Formatter{"slack": slackFormatter}
```

A new destination type = one formatter + one config validator + a UI card.
A new event type = one emit site + a template case in each formatter.
(Scope honesty: a *public* generic-webhook destination additionally needs
a frozen payload contract, HMAC signing, and an SSRF policy for arbitrary
hosts; future worker-side emitters need their own dedup keys and a shared
publish helper. The formatter seam does not cover those; they are
follow-up design work. Ordering across events is not guaranteed and not
contracted.)

### Slack message (Block Kit) — untrusted content rules

Issue titles are attacker-influenced (they come from thrown errors) and
can embed user data. Before rendering, the title passes through the
existing egress masking layer — `masking.RedactBody` + `masking.RedactURL`
(`packages/ingestion/masking`) — the same scrubbing applied to
breadcrumbs/context at ingest, then Slack-specific escaping:

- Header block (`plain_text`): `New issue in {project.name}` — plain_text
  blocks do no mrkdwn parsing; truncated to 150 chars.
- Section (`mrkdwn`): masked title with `&`, `<`, `>` escaped per Slack's
  rules and backticks stripped before wrapping in a code span; truncated
  to 2,900 chars (Slack section limit 3,000). Fields for environment +
  first seen (escaped the same way).
- Button: "View in Opslane" → `dashboard_url`; omitted when absent.

### Housekeeping (separate cadence, not the 5s loop)

Hourly ticker in the same goroutine, bounded batches via CTE (Postgres has
no `DELETE ... LIMIT`):

```sql
WITH del AS (
  SELECT id FROM outbound_deliveries
  WHERE status <> 'pending' AND status <> 'delivering'
    AND updated_at < now() - interval '30 days'
  LIMIT 1000
)
DELETE FROM outbound_deliveries WHERE id IN (SELECT id FROM del);
```

At most 5 batches per tick (a backlog drains over successive hours rather
than monopolizing the dispatcher goroutine), then a same-shape bounded
delete of `outbound_events` rows with no remaining deliveries. Failed rows
therefore remain inspectable for 30 days.

## API (ingestion, chi)

Session auth + project-in-org scoping via the existing
`verifyProjectAccess` pattern (`github_settings.go` is the model).

**Authorization for mutations** — `RequireRole` cannot be used as-is: it
returns 404 whenever cloud auth is disabled (`handler/auth.go:250`), which
would brick the feature for OSS/self-host installs. Instead, a small
`requireIntegrationAdmin` middleware:

- Cloud auth enabled → chain `RequireMembership` + `RequireRole("admin")`
  (org admins only, like the invitations routes).
- Cloud auth disabled (OSS embedded auth, no role model) → any
  authenticated session user of the org.

Both modes get tests. Listing is available to any member.

The dashboard must not infer permissions from `active_role` — `AuthMe`
omits it outside cloud mode (`handler/auth_handlers.go:334`), which would
leave authorized OSS users with a permanently read-only UI. Instead the
list response carries a server-computed `can_manage` boolean (evaluated by
the same `requireIntegrationAdmin` logic), and the UI keys off that alone.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET    /api/v1/projects/{projectID}/notification-destinations` | member | list; returns `can_manage`, `config_fingerprint` + delivery health, never the URL |
| `POST   /api/v1/projects/{projectID}/notification-destinations` | integration admin | create |
| `PATCH  /api/v1/projects/{projectID}/notification-destinations/{destID}` | integration admin | rename / replace URL / enable / disable |
| `DELETE /api/v1/projects/{projectID}/notification-destinations/{destID}` | integration admin | delete (cascades deliveries) |
| `POST   /api/v1/projects/{projectID}/notification-destinations/{destID}/test` | integration admin | send a sample message synchronously; return the classification |

Cross-org access returns **403** (matching `verifyProjectAccess`,
`packages/ingestion/handler/read_api.go:169`); tests assert 403.
`event_types` values are validated at the API layer against the known set
(defense in depth with the DB CHECK).

### URL validation (slack type)

Proper parse, not a string prefix check:

- `url.Parse` must succeed; scheme exactly `https`; hostname exactly
  `hooks.slack.com`; no userinfo; port empty or 443; path non-empty.
- The delivery `http.Client` sets `CheckRedirect` to refuse all redirects
  (Go follows them by default) and a 10s total timeout.
- **Test/e2e escape hatch**: env var `NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS`
  (comma-separated `host[:port]`, empty by default) extends the allowlist
  and permits `http` for those hosts only. Setting it logs a startup
  WARNING naming the hosts. The name, the warning, and the docs all mark
  it dev/test-only. Residual risk accepted: env vars are
  deployer-controlled trusted config; a tenant (org admin) cannot set
  them. This is how the live smoke points a destination at a local sink
  without weakening the default validation path — the validation code
  itself is identical in both modes.

## Dashboard UI

`Settings.vue` gains an `integrations` tab (fifth pill):

- List of destinations: name, type badge, enabled toggle, masked URL
  (`config_fingerprint`), **last delivery status** (delivered/failed +
  time + reason for failed), Test and Delete actions.
- "Add Slack notification" form: name + webhook URL + link to Slack's
  incoming-webhook docs. When the list response's `can_manage` is false,
  the UI is read-only (see API section — never inferred from
  `active_role`, which is absent in OSS mode).
- Test button calls the test endpoint and shows the result inline.
- **State scoping**: destinations are fetched keyed by the current project
  id and refetched on project switch — not cached globally, avoiding the
  existing stale-tab-data pattern in `Settings.vue` where cached arrays
  survive a project change.

## Observability (failed deliveries must be visible)

- The list endpoint joins a per-destination aggregate — last delivery
  status/time/error and count of failures in the last 7 days — served by
  the `(destination_id, updated_at DESC)` index; the UI renders it.
- Terminal failures log at WARN with destination id, project id, reason.
- Prometheus counter on the existing `/metrics` endpoint:
  `opslane_notification_deliveries_total{type, outcome}`.
- Failed rows are retained 30 days (housekeeping) for inspection.

## Error handling summary

| Failure | Behavior |
| --- | --- |
| Slack 5xx / network / timeout / 408 | retry per backoff, then `failed` + WARN |
| 429 | retry honoring `Retry-After` (delta or HTTP-date, cap 1h) |
| Other 4xx (revoked webhook, bad payload) or any redirect | `failed` immediately + WARN |
| Destination disabled after enqueue | dispatcher marks `failed` with reason `destination_disabled` |
| Crash mid-delivery | lease expires → reaper requeues (or fails if exhausted); duplicate possible, silent drop impossible |
| No destinations configured | one indexed SELECT, then nothing — no writes, no name lookups |
| Outbox SQL failure (any cause) | ingest transaction rolls back (accepted trade-off, see Architecture) |
| Panic in a delivery goroutine | recovered inside that goroutine (a batch-level recover cannot catch it); marked retryable; loop continues |

## Testing

- **Go unit/integration** (existing test-DB patterns in
  `packages/ingestion`): publish fan-out (0/1/2 destinations — assert
  zero `outbound_events` rows in the 0 case; increment path writes
  nothing), dedup-key conflict publishes once (and is per-project: same
  key in two projects publishes twice), empty `event_types` rejected,
  claim excludes exhausted rows, lease/reaper transitions (expired
  `delivering` → pending; exhausted → failed), **fencing** (a completion
  update carrying a stale `lease_generation` matches zero rows and cannot
  clobber a re-claimed row), a panicking delivery goroutine is recovered
  and marked retryable, backoff schedule, encryption round-trip + AAD
  mismatch rejection (ciphertext moved to another row fails to open),
  pruning bounds (CTE batches).
- **Migration idempotency**: `018` passes the existing re-apply test
  (`migrations_test.go`).
- **Formatter**: golden-file test for Block Kit JSON, including an
  injection-attempt title (`<!channel> *bold* ```  `) asserting
  masking, escaping, and truncation.
- **Dispatcher HTTP**: `httptest` fake Slack covering 200, 400, 404, 429
  with `Retry-After` (both forms), 500, timeout, and a redirect
  (asserting refusal + permanent fail); concurrent batch delivery.
- **Handlers**: CRUD, authorization in both auth modes (cloud: member
  gets 403 on mutate; OSS: session user can mutate), fingerprint-only
  responses, URL validation matrix (http, wrong host, userinfo, port,
  redirect), `event_types` validation, cross-org 403.
- **Dashboard**: colocated Vitest for the new API client functions
  (pattern: `api-project-settings.test.ts`) and project-switch refetch.
- **Live smoke** (required — this touches the ingest transaction): apply
  migration, seed via `scripts/seed-e2e.sql`, start a sink on the host
  and set `NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=host.docker.internal:9999`
  on the ingestion service (ingestion runs in a Compose container, so
  `localhost` would point at the container itself; `host.docker.internal`
  reaches the host on Docker Desktop — on Linux CI, add
  `extra_hosts: host-gateway` or run the sink as a Compose service and
  allowlist its service name), add a destination via the API, send an
  event to `http://localhost:8082/api/v1/events`,
  confirm the delivery row reaches `delivered` and the sink received
  Block Kit JSON; send a second identical event and confirm no second
  notification; confirm ingest works unchanged with no destination
  configured.

## Out of scope (explicitly)

- Slack OAuth app, channel pickers, interactive buttons, threads.
- Generic webhook destination (schema-ready; needs frozen payload
  contract, HMAC signing, arbitrary-host SSRF policy).
- Events beyond `issue.created` (worker status transitions later; that
  design must define its own dedup keys and a shared publish helper).
- Org-level subscriptions, environment filters, per-destination rate
  limiting, digest/batching, manual retry UI.
- Exactly-once delivery and cross-event ordering guarantees.
- Graceful-shutdown refactor of `main.go`.

## License

All new code lands in `packages/ingestion` and `packages/dashboard` — AGPL-3.0-only, consistent with existing server/dashboard code.
