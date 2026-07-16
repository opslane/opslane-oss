# Admin observability dashboard — v1 design

**Date:** 2026-07-15 (revised after review)
**Status:** Proposed
**Goal:** A cross-project, operator-only view that answers "is Opslane working?" — events flowing in, jobs completing, PRs going out — with Langfuse trace links for debugging investigations.

## Scope decisions

- **Cross-tenant operator view.** Aggregates across all orgs/projects. Normal customer sessions must never see it.
- **Lives in the existing Vue dashboard** as a new `/admin` route. No separate app.
- **Zero new dependencies.** Stat tiles + hand-rolled inline-SVG bar charts. No chart library, no Grafana, no new queue/metrics infra.
- **One migration (`006_admin_observability.sql`).** Review killed the zero-migration goal twice over: the global time-range scans need indexes, and the headline lifecycle metrics ("PRs created", "needs human") cannot be derived reliably from mutable columns (`TransitionOnPRClose` clears `pr_url`; heartbeats and event recurrence churn `updated_at`). Decision: **lifecycle metrics are exact from deploy forward**; rows predating the migration have NULL timestamps and are excluded, which is acceptable for a "is it working now" dashboard.

## Migration `006_admin_observability.sql`

Idempotent (`IF NOT EXISTS` guards), append-only per ingestion AGENTS.md:

- `ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS pr_created_at TIMESTAMPTZ;`
- `ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS needs_human_at TIMESTAMPTZ;`
- `CREATE INDEX IF NOT EXISTS idx_error_events_created_at ON error_events(created_at);`
- `CREATE INDEX IF NOT EXISTS idx_error_group_jobs_created_at ON error_group_jobs(created_at DESC);`

Verify per package AGENTS.md: apply to a disposable clean DB and a representative existing DB, then reapply for idempotency.

## Lifecycle data producers (prerequisites for exact metrics)

1. **Worker stamps transition times.** `updateGroupStatus` / `updateGroupInvestigation` (`packages/worker/src/db.ts`) set `pr_created_at = now()` when writing status `pr_created`, and `needs_human_at = now()` when writing `needs_human`. Timestamps are never cleared (PR close keeps `pr_created_at` so window counts survive `pr_url` being nulled). Known approximation: a group re-fixed after a closed PR overwrites `pr_created_at`, so the tile counts "incidents with a PR created in window", not raw PR count — label it that way.
2. **Webhook writes `pr_outcomes` receipts.** Today `handler/webhook.go` only transitions group status; nothing ever inserts into `pr_outcomes`, so merged/closed counts would be permanently zero. Extend the webhook handler: after a successful `TransitionOnPRMerge`/`TransitionOnPRClose` (extend `RETURNING` to include `project_id`), insert a receipt with `outcome`, `pr_number`, `occurred_at = now()`, and `github_delivery_id` from the `X-GitHub-Delivery` header. Insert with `ON CONFLICT (github_delivery_id) DO NOTHING` for redelivery idempotency. Tests: merge inserts receipt, redelivery inserts nothing, `no_match` inserts nothing.

## Backend (Go ingestion)

### Admin auth

- New env var **`ADMIN_EMAILS`** — comma-separated operator emails. Empty ⇒ admin API fully disabled (fail closed).
- New **`RequireAdmin`** middleware (in `handler/auth.go`): runs after `AuthenticateSession`, loads the user via `UserIDFromCtx`, checks email against `ADMIN_EMAILS`. Non-admins get **404** (not 403) so the surface is invisible to customers.
- Extend `GET /api/v1/auth/me` (`handler/auth_handlers.go:302`) with an `is_admin` boolean so the frontend can decide whether to render the Admin nav link.

### New endpoints (both `AuthenticateSession` + `RequireAdmin`; handlers in new `handler/admin.go`, queries in `db/`)

**`GET /api/v1/admin/overview`** — one payload for the whole page:

- `events`: totals for last 1h / 24h / 7d; hourly buckets for the last 48h; top 10 projects by 24h volume (project + org name + count).
  - **Bucket contract:** exactly 48 ordered UTC buckets over half-open hourly intervals `[hour, hour+1h)`, zero-filled via `generate_series` LEFT JOIN — `date_trunc` alone omits empty hours. Tests: empty DB (48 zeros), gaps, events exactly on a boundary land in the later bucket.
- `jobs`: counts by `job_status`; counts by `job_type`; oldest pending job age; dead-letters in last 7d.
- `workers`: **"workers with live claims"** = distinct `worker_id` where `status = 'claimed' AND lease_expires_at > now()` (excludes expired leases awaiting reaping); **"workers active in last 5m"** = distinct `worker_id` on rows with `updated_at > now() - interval '5 minutes'` (heartbeats update `updated_at`, so this is a liveness proxy that stays non-zero for busy workers; a fully idle fleet shows zero — acceptable for v1, noted in UI copy). Proxying the worker's own `/health` endpoint through ingestion is explicitly out of scope for v1.
- `outcomes`: `error_groups` counts by current status; **incidents with PR created** in last 24h / 7d (`pr_created_at` in window); **needs human** in last 7d (`needs_human_at` in window); **merged / closed** in last 7d from `pr_outcomes.occurred_at`.

**`GET /api/v1/admin/jobs?limit=50&status=&job_type=`** — recent jobs across all tenants. Precise contract:

- **Joins:** LEFT JOIN to `error_groups` and `projects` — `setup_pr` and `session_analysis` jobs may have no incident; incident title and `pr_url` are nullable in the response.
- **Filters:** `status` from the `job_status` enum values, `job_type` from `investigate|fix|error_fix|setup_pr|session_analysis`; reject unknown values with 400.
- **Limit:** default 50, capped at 200.
- **Ordering:** `created_at DESC, id DESC` (stable tie-break).
- **Duration semantics:** `pending` → null; `claimed` → `now() - claimed_at` (elapsed so far); terminal → `updated_at - claimed_at` (final write sets `updated_at` at the terminal transition; heartbeats stop then).
- **Fields:** job id, project name, `job_type`, `status`, `attempts`, `created_at`, duration (as above), redacted+truncated `last_error`, `trace_url` (Langfuse), nullable incident title + `pr_url`.

### Safety

- **`last_error` redaction:** it stores raw worker exception text which can embed credentials. Redact server-side before truncating (~300 chars): patterns for `ghp_`/`ghs_`/`github_pat_` tokens, `sk-` keys, `Bearer …`, and URL userinfo (`scheme://user:pass@`). Unit-test the redactor.
- Query params validated against allowlists; all admin queries parameterized (existing pgx convention).

### Conventions to respect

- Cross-tenant queries violate the "scope every helper to project/org" rule by design. Name them `Admin*` in `db/`, document the exception in a comment, and rely on `RequireAdmin` as the sole gate.
- Update `docs/reference/http-routes.md` (route-drift check fails `pnpm test` otherwise) and `docs/reference/environment-variables.md` (`ADMIN_EMAILS`).
- **Performance budget:** overview endpoint p95 < 500ms on representative data. Verify each aggregate with `EXPLAIN (ANALYZE, BUFFERS)` and confirm the new indexes are used (no seq scan on `error_events` for windowed counts).

## Frontend (packages/dashboard)

- New route `/admin` → `AdminView.vue`.
  - **Project-selection exemption:** the router guard (`router.ts:44-49`) redirects any authed route to `/setup` when `opslane_project_id` is unset, and `App.vue`'s `checkProject` does the same — exempt the `admin` route from both. Test: an operator with zero projects can load `/admin`.
  - **Error handling:** preserve the existing 401 → `fetchWithAuth` refresh → login flow untouched; only a server-returned **404** from the overview call redirects a non-admin to `/`.
- Nav link rendered only when `/auth/me` returns `is_admin: true` — customers never see the entry point.
- Layout (top to bottom):
  1. **Stat tiles:** Events 1h · Events 24h · Incidents w/ PR created 7d · Needs human 7d · Queue depth (pending) · Dead letters 7d · Workers w/ live claims.
  2. **Ingestion chart:** 48 hourly bars, inline SVG (~60-line component), count on hover via `title`.
  3. **Jobs by status** strip + **top projects by volume** table + **merged/closed 7d**.
  4. **Recent jobs table:** time, project, type, status badge, attempts, duration, last error (**rendered as text only**, already redacted server-side), Langfuse ⧉ and PR ⧉ links — both passed through the existing `safeUrl` helper (`src/utils.ts:50`) and rendered with `rel="noopener noreferrer" target="_blank"`.
  5. **Health card:** existing `GET /health` (ingestion, DB, MinIO). Worker health is represented by the heartbeat-derived tiles, not the worker's own `/health` endpoint (v2 candidate).
- Auto-refresh every 60s. Types in `src/types/api.ts`, fetchers in `src/api.ts` (reuse `fetchWithAuth`).

## Deployment wiring

- `docker-compose.yml`: add `ADMIN_EMAILS: ${OPSLANE_ADMIN_EMAILS:-}` to the ingestion service environment; run `docker compose config --quiet` after editing.

## Explicitly out of scope (v1)

Alerting, historical rollups/retention, per-org drill-down, Prometheus/Grafana wiring, proxying worker `/health`, backfilling lifecycle timestamps for pre-migration rows, LLM cost tracking (Langfuse covers that once you're on the trace).

## Implementation order

1. Migration `006` + disposable-DB apply/reapply verification.
2. Worker: stamp `pr_created_at` / `needs_human_at` in status writes (+ worker tests).
3. Webhook: `pr_outcomes` receipt insertion with `X-GitHub-Delivery` idempotency (+ tests).
4. `ADMIN_EMAILS` + `RequireAdmin` + `is_admin` in `/auth/me` (+ tests: admin 200, non-admin 404, unset env 404).
5. `db/` admin queries + `/admin/overview` handler (+ tests incl. 48-bucket contract) + `EXPLAIN` check.
6. `/admin/jobs` handler with redaction (+ tests incl. null-incident jobs, filter validation, duration cases).
7. Docs: `http-routes.md`, `environment-variables.md`. Compose: `ADMIN_EMAILS` pass-through.
8. Dashboard: API types/fetchers → router/App.vue exemptions → `AdminView` tiles → SVG bars → jobs table → nav gating.
9. Live smoke.

## Verification

Rule: "done" means the checks below ran and their real output is in the completion report — command output, JSON responses, and screenshots. No claim rests on reading code alone.

### Layer 1 — deterministic checks

1. `cd packages/ingestion && go build ./... && go test ./...` (focused while iterating: `go test ./db ./handler`).
2. `pnpm -r build && pnpm test` (includes the routes-doc drift check); worker tests for timestamp stamping.
3. `docker compose config --quiet`.
4. Migration `006`: apply to a disposable clean DB and a representative existing DB, then reapply to prove idempotency.
5. `EXPLAIN (ANALYZE, BUFFERS)` on the windowed event count and recent-jobs queries against representative data; confirm the new indexes are used (no seq scan on `error_events`).

### Layer 2 — API evidence (curl, before/after)

Stack up via compose with `OPSLANE_ADMIN_EMAILS` set, migrations applied, `scripts/seed-e2e.sql` seeded:

1. Curl `/api/v1/admin/overview` as admin → baseline JSON.
2. POST events to `http://localhost:8082/api/v1/events`, run a worker job, curl overview again → show event totals and hourly buckets incrementing, job counts moving.
3. Curl `/api/v1/admin/jobs` → job row present with correct status, attempts, and duration semantics.
4. Curl both admin endpoints as a non-admin session → raw 404 body.

### Layer 3 — browser evidence (headless browser, screenshots in the report)

1. `/admin` as admin: every tile rendered and populated — events 1h/24h non-zero, ingestion bars showing the smoke-test spike, queue depth, jobs-by-status, top-projects table, recent-jobs table containing the triggered job.
2. Langfuse link: with `LANGFUSE_*` keys set, the trace link renders and resolves; without them, the trace column renders empty. State in the report which case ran.
3. Non-admin session: Admin nav link absent, and direct navigation to `/admin` redirects home (screenshot + the 404 in the network log).
4. Admin with zero projects: `/admin` loads without a `/setup` redirect.

### Evidence tiers for PR metrics

"PRs created / merged / closed" tiles need a real fix-pipeline run (Anthropic key, GitHub repo, E2B) to light up end-to-end. If those credentials are available, run the full pipeline and screenshot the tiles. If not, prove them two ways and label the evidence as simulated: (a) worker/webhook unit tests covering `pr_created_at`/`needs_human_at` stamping and `pr_outcomes` receipt insertion (including redelivery idempotency), and (b) representative rows inserted into the disposable DB, with a screenshot of the tiles rendering them. The completion report must state per metric whether evidence was end-to-end or simulated.
