# Environments and projects as first-class citizens

Status: design v4 — final (codex rounds 1–3 incorporated)
Date: 2026-07-18

## Context

Opslane's schema already has the full Sentry-style hierarchy — `org → project → environment → environment_api_key` (`packages/ingestion/db/migrations/001_baseline.sql`) — and every `error_event` and `session` row records both `project_id` and `environment_id`. But above the storage layer, both concepts degrade:

- **Environment is write-only for errors.** Events record it; nothing reads it. `error_groups` are keyed `(project_id, fingerprint)` with `environment_id` NULL for every error incident (populated only by friction). No read endpoint filters by environment; the dashboard has no environment picker outside Settings.
- **Project is single-tenant in practice.** The API supports multiple projects per org, but the dashboard silently picks `projects[0]` after login (`post-auth.ts:15-21`) and offers no switcher. There is no "New Project" UI.
- **The SDK cannot express environment.** `SdkInitOptions` has no `environment` option, yet the CLI codemods already emit `OpslaneSDK.init({ apiKey, environment: 'production' })` (`cli/src/codemods/react-vite.ts:36-39` and siblings) — a field the SDK's TypeScript types reject and the runtime ignores (pre-existing defect, fixed by D2).

Goal: make both dimensions usable end to end — SDK → ingest → grouping/reads → dashboard — the way Sentry users expect, without breaking the append-only wire contract or the investigation pipeline.

## Design decisions

### D1. Error-group identity stays `(project_id, fingerprint)`; a per-environment rollup table makes environment a real read dimension

Groups are NOT split per environment (Sentry parity; splitting would double-investigate and double-PR the same bug). A rollup table provides environment-scoped filtering AND environment-scoped aggregates:

```sql
CREATE TABLE error_group_environments (
  error_group_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  environment_id UUID NOT NULL REFERENCES environments(id),
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen  TIMESTAMPTZ NOT NULL,
  occurrence_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (error_group_id, environment_id)
);
CREATE INDEX ON error_group_environments (environment_id, last_seen DESC, error_group_id);
```

The secondary index is the access path for "sparse environment, ordered by recency"; **filtered lists order by `ege.last_seen`**, not global `eg.last_seen` (round-2 fix — the PK alone cannot serve that query).

**Writers (all sources, not just error ingest — round-2 fix):**
- `InsertErrorEventAndGroup` (`queries.go:373-450`): one `INSERT ... ON CONFLICT (error_group_id, environment_id) DO UPDATE` (bump `last_seen`, `occurrence_count += 1`) inside the existing tx. The tx already serializes on the `error_groups` row, so the added rollup upsert extends an already-serialized section; the concurrency benchmark in Verification bounds the cost.
- The friction **fold** path (folded friction signals incrementing an error-kind group, `promotion-db.ts` fold/`applyBucketOutcome` paths) performs the same upsert with the signal's `environment_id`.
- Friction **retraction/supersession** rebuilds the affected group's rollup rows from source tables (`error_events` + active folded `friction_signals`) — never decrements blindly.
- **Friction-kind groups never have rollup rows**; every reader is kind-gated.

**Kind gating** uses the real discriminator — `error_groups.kind TEXT NOT NULL CHECK (kind IN ('error','friction')) DEFAULT 'error'` (`004_friction.sql:14`) — not a fingerprint-prefix heuristic:

```sql
AND (
  (eg.kind = 'friction' AND eg.environment_id = $N)
  OR (eg.kind = 'error' AND EXISTS (
        SELECT 1 FROM error_group_environments ege
        WHERE ege.error_group_id = eg.id AND ege.environment_id = $N))
)
```

**Environment-scoped aggregates when the filter is active**: the list query joins the rollup and returns `ege.first_seen/last_seen/occurrence_count` for error-kind rows (friction rows use their own columns), so "production" never shows a `last_seen` caused by staging. `affected_users_count` remains project-wide in v1, labeled in the UI ("users across all environments"); per-env user rollup is a follow-up.

**Combined account/end-user × environment filters correlate kind-specifically** (round-2: linkage exists; no "disable the combination" cop-out): error-kind via `error_events` rows carrying both linkages plus active folded friction signals; friction-kind via `eg.environment_id` + the `error_group_affected_users` junction (`001_baseline.sql:273`, populated from both events and signals). Never intersect the two filters independently at group level.

Also add `error_groups (project_id, last_seen DESC)` (missing; serves the unfiltered list sort).

### D2. Optional `environment` on SDK init and wire payload — opt-in per project, existing-session-wins, observable

`environment?: string` is added to `SdkInitOptions` (`packages/sdk/src/config.ts`) and `ErrorEventPayload` (`shared/src/types.ts:38-70`) — contract-legal (append-only, optional-only, `docs/contracts/events.md:12`). The SDK sends the same value on session init and events.

- **Opt-in per project.** `projects.allow_payload_environment BOOLEAN NOT NULL DEFAULT false` + Settings toggle. Default off: environment stays fully key-bound; nothing changes for existing projects. The honest threat model (round-2 wording fix): the boundary being relaxed is *possession of an environment-bound key* — `allowed_origins` and `friction_autonomy` are project-level today, so they are unaffected either way. Crossing the key boundary is a deliberate project-level choice because environment drives friction gating and (future) env-scoped policy.
  - **The flag is admin-gated server-side**: `PATCH /projects/{projectID}` currently checks org access but no role (`read_api.go:459`); changing `allow_payload_environment` requires `admin`+ in cloud mode (see D6 for the cloud-conditional role helper). UI-only gating is not enforcement.
  - **Zero extra read cost**: `LookupAPIKey` (`queries.go:180-197`) already joins `projects`; it returns `allow_payload_environment` into the authenticated request context.
- **Resolution**: by name, scoped to the key's project (`SELECT id FROM environments WHERE project_id = $keyProject AND name = $1`). Never by client-supplied ID, never cross-project (invariant pattern: `queries.go:373-384`). **No auto-create.**
- **Override-only rejection semantics** (round-2 consistency fix): a non-conforming name (>64 chars or outside `[a-zA-Z0-9._-]`) rejects the *override*, never the event — the event is accepted (202) into the key-bound environment. Fallback reasons are all counted: `ingest_env_override_fallback_total{reason=unknown_name|invalid_name|disabled}`. Logs are sampled/rate-limited for `disabled` (the CLI already emits `environment`, so disabled-fallback is the common case); unknown/invalid names may log per-event.
- **Environment-name hygiene**: `CreateEnvironmentEndpoint` (`read_api.go:568`) enforces the charset/length for new names. The DB CHECK constraint is added **`NOT VALID`** (forward-only enforcement; legacy arbitrary names — allowed up to 100 chars today — are inventoried and remediated separately; `VALIDATE CONSTRAINT` later). No case normalization: names keep case-sensitive identity.
- **Cache**: positive entries in a bounded LRU (1k/instance, 60s TTL); misses cached 5s in the same LRU (bounded, so attacker-controlled names can't grow it). TTL-based invalidation is correct across replicas.
- **Existing-session-wins invariant** (round-2: "session wins" is unenforceable under out-of-order delivery, which ingest explicitly supports — `queries.go:407` accepts events for not-yet-registered sessions):
  - **All session lookups are tenant-scoped `(session_id, project_id)`** (round-3: `sessions.id` is a globally unique client-generated PK, `002_sessions.sql:17` — an unscoped "existing session wins" would let a session squatted in another project supply its environment cross-tenant). A session id that exists under a *different* project is treated as absent for this project's events and **rejected** on session init (metric `ingest_session_cross_project_conflict_total`).
  - If the event's `session_id` matches an existing **same-project** session row, the session's environment wins.
  - If the session doesn't exist yet (out-of-order delivery is supported, `queries.go:407`), the event uses its own resolution; the divergence window is accepted, documented, and counted (`ingest_env_session_divergence_total`) — no retroactive rewriting.
  - Session init on an existing **same-project** session id with a different resolved environment does not silently `DO NOTHING` (`sessions.go:29`): first registration wins, conflict increments the divergence metric.
- Replay ingest: `ReplayInit` gains a check that the claimed session belongs to the authenticated project (`replay.go:86` accepts any nonempty session id today — round-2 hardening); `session_replays` keeps no env column, environment is inferred through the session and documented as such.

### D3. Dashboard: project switcher done correctly, environment filter via shared composable

- **ProjectSwitcher** in the header next to `OrgSwitcher` (`App.vue:130-134`), same select + pure-helper + colocated-test pattern (`org-switcher.ts`). Switching: writes localStorage, **strips any `?project_id=` URL override** (it wins in `getProjectId()`, `utils.ts:16-23`), **clears environment/account filter state**, and **navigates to `/`** (detail routes hold foreign IDs). Replaces the one-time selection modal (`App.vue:57-82`).
- **Environment selection is a shared composable** — `SessionsList.vue` does not use `FilterBar` (it has its own applied-filter form + keyset pagination). `useEnvironmentFilter(projectId)` (options from `listEnvironments`, state synced to URL query + localStorage) feeds (a) a new select in `FilterBar.vue` for the incidents list and (b) a select in SessionsList's filter form, which **resets the pagination cursor** on change.
- **Incident detail**: environment chips — friction from `eg.environment_id`; error-kind from rollup rows with per-env counts. `GetIncident` gains `environments: [{id, name, occurrence_count, last_seen}]`.
- Dashboard type mirrors are explicit surfaces: `Incident`, `IncidentFilters`, `SessionFilters`, `SessionSummary`, `Project` (gains `allow_payload_environment`) in `packages/dashboard/src/types/api.ts`.

### D4. Read API changes

- `ErrorGroupFilters` (`queries.go:598-603`): add `EnvironmentID *string`; `ListErrorGroups` gains the D1 clause, rollup join for scoped aggregates, and `ege.last_seen` ordering when filtered. `ListIncidents` (`read_api.go:194-203`) parses + UUID-validates `environment_id` and verifies it belongs to the project (`VerifyEnvironmentAccess` pattern, `queries.go:2572-2589`).
- Sessions: `SessionFilters` (`db/sessions_read.go:30`) gains `EnvironmentID`; `ListSessions` (`sessions_read.go:68`) gains the WHERE arm; parsing in **`handler/session_read.go`** (`ListSessionsEndpoint`). New index `sessions (project_id, environment_id, started_at DESC, id DESC)` preserving the keyset access path.
- `GetIncident`: `environments` array (kind-gated source per D1).
- Out of scope, documented: standalone env filters on accounts/affected-users (no `environment_id` on `end_users`); `GetFixStats` stays project-scoped.

### D5. Worker/pipeline: no structural change; environment context is fenced; release semantics stated

- Job queue, claim path, per-project policy columns: untouched.
- PR body (`pr.ts:345-399`) and investigation prompt gain "Environments: production, staging" — kind-gated source (rollup for error-kind, `eg.environment_id` for friction). Environment names are **untrusted**: charset-validated going forward (D2) *and* fenced/escaped like other external data in `agent-fix.ts` prompt construction — both layers, since legacy names predate validation.
- **Release semantics are project-global in v1, stated not implied**: `resolved_in_release` regression-reopen and `sample_event_id` replacement remain environment-blind. A staging occurrence can reopen a prod-resolved group — arguably correct (the fix isn't fully rolled out); env-aware reopen is a follow-up if it bites. Source maps stay keyed `(project_id, release, filename)`.
- Per-environment investigation policy ("auto-fix prod only"): follow-up, not v1.

### D6. Project provisioning and authorization

- **`POST /api/v1/projects` becomes composite provisioning**: project + "production" environment + API key in one tx (shape of `onboarding.go:19-101`), returning `{project, environment, api_key}` — the raw key is one-time-visible so it MUST be in the creation response. Internal session-authed API, not the frozen wire contract; `createProject()` (`api.ts:389-391`) and its Settings call site update together.
  - **Idempotency** (rounds 2–3: timeout after commit loses an unrecoverable key; project names aren't unique; concurrent retries must not duplicate): client sends an idempotency token persisted with **`UNIQUE(org_id, idempotency_token)`** on the project row — concurrent same-token requests collapse to one project. The provisioning key's id is stored alongside; a retry with the same token **atomically revokes the prior provisioning key and mints a replacement** in the response (no accumulation of live orphan keys; raw keys are never re-derivable). The UI requires explicit copy/acknowledge of the key.
- **Role gating via a cloud-conditional helper**: existing `RequireRole` returns 404 outside cloud mode (`auth.go:248`), so it cannot be reused as-is. New `RequireRoleIfCloud("admin")` — enforces `admin`+ when memberships exist (cloud), passes through in OSS mode. Applied to **every provisioning path**: `POST /projects`, `PATCH /projects` (at minimum for `allow_payload_environment`), environment creation, API-key creation, **and `POST /onboarding/setup`** (round-2: it mints the same bundle and was unguarded).
- CLI onboarding keeps creating "production" (`agent_provision.go:234`); no CLI changes in v1.

## Migration / rollout (round-2 rework — compose reruns migrations on every startup, `docker-compose.yml:79,128`; `run-migrations.sh` is plain psql)

Four-stage rollout with durable state, safe under re-run. Round-3 rework: **no watermark, no additive merge** — `error_events` (+ active folded `friction_signals`) is the complete source of truth, so the backfill is a **recompute-from-source**, which is exact and idempotent by construction (also: `error_events.received_at` does not exist; the only server timestamp is `created_at`, `001_baseline.sql:71` — the recompute design removes any dependency on it).

1. **Schema migration** (normal): rollup table + its index, `error_groups(project_id, last_seen DESC)` and the sessions index (small self-host tables run plain `CREATE INDEX`; the migration is written idempotently — `IF NOT EXISTS` — and docs/ops notes cover `CREATE INDEX CONCURRENTLY` guidance for large managed installs), `projects.allow_payload_environment`, env-name CHECK `NOT VALID`, and a `rollup_backfill_state` row (`pending`).
2. **Dual-write deploy**: new ingestion + worker code (rollup upserts on error ingest and friction fold) starts.
3. **Guarded online backfill** — an ingestion startup background task (NOT a migration; migrations rerun every boot):
   - **Single runner**: takes a global advisory lock; other replicas skip (round-3: multiple instances observing `pending`).
   - **Per-batch recompute under the ingest locks**: for each batch of error-kind group ids, one tx does `SELECT ... FROM error_groups WHERE id = ANY($batch) FOR UPDATE` (the same row lock ingest's group-upsert path holds), recomputes exact per-environment aggregates from `error_events` **`UNION ALL` active folded `friction_signals`** (round-3: events alone undercount folded-friction impact), upserts absolute values, and records the batch in a durable ledger. Restart replays are harmless — recompute writes the same values.
   - **Reconciliation sweep**: after the first pass, one repeat pass over the ledger (bounds any drift from old-version writers during a mixed-version rolling deploy), then mark `complete` durably. Later boots are a cheap state check.
4. **Read enablement**: env-filter UI appears when backfill state is `complete` (surfaced via a lightweight existing endpoint, e.g. project/environments response). Fresh installs are `complete` immediately (zero rows).

**D2 deployment order**: ingestion first, SDK publish after. SDK ships as **v1.1.0** with fixture pair `v1.1.0-{minimal,full}.json` in the same commit as the version bump (`wire-shape.test.ts:15` loads fixtures by package version); old fixtures stay frozen.

## Implementation surface (by package)

| Package | Changes |
| --- | --- |
| `shared` | `ErrorEventPayload.environment?`; `Incident.environments?`; `Project.allow_payload_environment` |
| `packages/ingestion` | migrations per rollout stage 1; rollup upsert in ingest tx; backfill task + state; env-name resolution + LRU + fallback/divergence metrics; `LookupAPIKey` returns the flag; kind-gated filter + scoped aggregates + `ege.last_seen` ordering; kind-specific combined-filter correlation; `SessionFilters.EnvironmentID` + index; `GetIncident` environments; param validation (`read_api.go`, `session_read.go`); composite + idempotent `CreateProject`; `RequireRoleIfCloud` on all provisioning routes incl. onboarding; name validation in `CreateEnvironmentEndpoint`; replay-init session-ownership check; every `projects` serializer/scan updated (`queries.go:72,2338`, `projectJSON` `read_api.go:103`) with scan-shape tests |
| `packages/worker` | rollup upsert in friction fold; rollup rebuild on retraction/supersession; env list in PR body/prompt (fenced) |
| `packages/sdk` | `environment` init option → session init + event payload; version → 1.1.0; wire-shape test |
| `test-fixtures/wire` | `v1.1.0-{minimal,full}.json` (append-only) |
| `packages/dashboard` | `ProjectSwitcher` (+ URL/filter/route reset); `useEnvironmentFilter` composable; FilterBar select; SessionsList filter + cursor reset; detail chips; Settings: New Project (key copy/acknowledge) + admin-only payload-env toggle; type mirrors |
| `cli` | codemod compile test against SDK types (closes the pre-existing silent-mismatch defect once `environment` exists) |
| `docs` | `contracts/events.md` (new optional field + fixtures), `reference/sdk-options.md` (drift-checked), `reference/http-routes.md`, replay-privacy note, large-install index/backfill ops note |
| `test-e2e` | add `listSessions` helper (only `listIncidents` exists, `helpers.ts:224`); tests below |

## Sequencing (each phase shippable)

1. **Read-path foundation**: rollout stages 1–3 (schema, dual-write incl. friction-fold writer, guarded backfill), kind-gated filter + scoped aggregates + ordering, combined-filter correlation, `GetIncident` environments, sessions filter + index, param validation.
2. **Dashboard filtering**: composable + FilterBar + SessionsList + detail chips, gated on backfill-complete signal.
3. **Project first-class**: `RequireRoleIfCloud` across provisioning (incl. onboarding), composite idempotent CreateProject, ProjectSwitcher, New Project UI.
4. **Worker context**: env names in PR body/prompt (fenced).
5. **SDK/wire**: flag + admin-gated toggle, ingest resolution (events + session init) + cache + metrics + existing-session-wins, replay-init check, SDK 1.1.0 + fixtures + docs. Ingestion deploys before SDK publish.

## Verification

- Go: `cd packages/ingestion && go build ./... && go test ./...`. New tests: rollup upsert (both writers) + retraction rebuild; backfill recompute exactness under concurrent ingest (locked batch), restart replay idempotency, single-runner lease, friction-signal inclusion; kind-gated filter both arms + cross-arm exclusion; combined account×env correlation per kind; env-name resolution (match/unknown/invalid/disabled) + override-only rejection; existing-session-wins (same-project) + divergence metric; cross-project session id rejection; session-init conflict; CreateProject idempotency (concurrent same-token → one project; retry revokes+replaces key); `RequireRoleIfCloud` cloud/OSS matrix incl. onboarding route; projects scan-shape tests; replay-init ownership.
- Concurrency benchmark (round-2): single hot fingerprint × one environment under concurrent ingest — measure lock waits/ingest latency delta from the rollup upsert; budget: no regression beyond noise at p95.
- Migration checks: apply on clean DB; re-apply on seeded DB (disposable Postgres per repo guardrail); `EXPLAIN (ANALYZE, BUFFERS)` for filtered list on ≥100k events with skewed env distribution, confirming the `(environment_id, last_seen DESC, ...)` path.
- TS: `pnpm -r build && pnpm test` — SDK wire-shape (± environment, v1.1.0 fixtures); dashboard helpers (switch reset semantics, env query sync, cursor reset); CLI codemod compile test.
- E2E: same fingerprint via two env keys → one group, correct per-env counts under each filter; override on → named env; off/unknown/invalid → fallback + correct metric reason; event-before-session then session init → divergence counted, existing-session-wins thereafter; project switch clears env filter; New Project returns copyable key; member (non-admin) blocked from provisioning + toggle in cloud mode.
- Live smoke per AGENTS.md: migrations + seed + event → terminal job state; manual pass with 2 projects × 2 environments.

## Review log

- Round 1 (codex, high): 14 P1 / 6 P2 — all incorporated in v2 (aggregates, correlation, kind-gating, index/backfill strategy, session divergence, provisioning contract, role gating, SDK versioning, fencing, sequencing).
- Round 2 (codex, high): 9 P1 / 8 P2 on the v2 revisions — all incorporated in v3 (rollup ordering index + friction writers, startup-task rollout, existing-session-wins, kind-specific correlation, admin-gated flag + `RequireRoleIfCloud` incl. onboarding, `NOT VALID` constraint, LookupAPIKey flag, idempotent CreateProject, serializer surfaces, replay-init check, override-only rejection, log sampling, honest threat-model wording, concurrency benchmark).
- Round 3 (codex, high): 6 P1 on the v3 mechanisms — all incorporated in v4: backfill switched from watermark+additive to locked recompute-from-source including active folded friction signals (fixes nonexistent `received_at`, rolling-deploy T0 hazard, restart/replica double-count in one design); tenant-scoped `(session_id, project_id)` session semantics with cross-project rejection; `UNIQUE(org_id, idempotency_token)` + revoke-and-replace key on CreateProject retry.

## Open questions

1. Per-env `affected_users_count` — follow-up, or fold into v1 if the junction query makes it cheap?
2. Env-aware regression reopen (staging recurrence reopening prod-resolved groups) — v1 keeps project-global as argued in D5; revisit on user feedback?
