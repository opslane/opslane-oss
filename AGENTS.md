# AGENTS.md

Opslane is an AI-powered production error-resolution engine. It ingests browser errors, investigates root causes, and either opens a verified fix PR or creates an actionable `needs_human` incident.

## Stack

| Area | Runtime and tools |
| --- | --- |
| `packages/ingestion` | Go 1.24, chi, pgx, Postgres 16, S3-compatible storage |
| `packages/worker` | TypeScript, Node 22, Anthropic SDK, Octokit, Vitest |
| `packages/dashboard` | Vue 3, Vite, Tailwind CSS |
| `packages/sdk` | Browser TypeScript SDK, React/Vue integrations, Vite source-map plugin |
| `shared` | Shared TypeScript contracts with no runtime dependencies |
| `cli` | Node 22, Commander, Inquirer, Chalk |
| `eval` | Evaluation runner and framework fixtures |
| `test-e2e` | Vitest end-to-end contracts |

The server, worker, dashboard, eval, and test code are AGPL-3.0-only. The SDK, CLI, and shared types are MIT licensed.

## Repository structure

```text
packages/
  ingestion/          Go API, database access, migrations, grouping, masking
  worker/             Job poller, investigation/fix pipeline, PR creation
  dashboard/          Vue application served by ingestion
  sdk/                Browser SDK and framework/build-tool integrations
shared/               Shared TypeScript contracts
cli/                  Opslane CLI and framework codemods
eval/                 Evaluation runner, cases, and standalone apps
test-e2e/             End-to-end contract tests
test-fixtures/         Local applications used by browser/E2E tests
docs/                 Install, privacy, agent, and public contract docs
scripts/              Development, migration, and seed scripts
```

## Commands

```bash
pnpm install
pnpm -r build
pnpm test

cd packages/ingestion
go build ./...
go test ./...
cd ../..

docker compose config --quiet
docker compose up -d
docker compose ps
pnpm db:migrate
```

Useful focused checks:

```bash
pnpm --filter @opslane/worker test
pnpm --filter @opslane/sdk test
pnpm --filter @opslane/cli test
pnpm --filter @opslane/dashboard build
cd packages/ingestion && go test ./db ./handler
```

`docker compose down -v` and `./scripts/restart-services.sh --wipe-db` destroy local data. Use them only when the task explicitly requires a clean database.

## Verification

Verify the smallest relevant surface while iterating, then run every check needed to prove the final claim. Do not report completion from an unverified edit.

| Change | Required verification |
| --- | --- |
| Shared types or workspace metadata | `pnpm -r build` and affected tests |
| Worker or pipeline | worker build/tests; Docker E2E smoke for flow changes |
| SDK or integrations | SDK build/tests, including browser contract tests |
| CLI | CLI build/tests |
| Dashboard | dashboard build/tests |
| Ingestion | `go build ./...` and `go test ./...` |
| Migration SQL | apply to a clean DB and an existing DB; verify idempotency |
| Compose or health checks | `docker compose config --quiet`, start services, inspect health |
| Dockerfiles | build the affected Compose image |

For a full repository gate:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Pipeline changes require a live smoke test: apply migrations, run `scripts/seed-e2e.sql`, rebuild ingestion and worker, send an event to `http://localhost:8082/api/v1/events`, and confirm the resulting job reaches its expected terminal state. Use the repository-local `test-fixtures/vue-app` when an E2E test needs a browser fixture.

## Engineering conventions

### Go and database

- Keep HTTP handlers in `handler/` and database operations in `db/`.
- Every database helper must take and enforce the required project or organization scope.
- Postgres is both the system of record and the job queue. Claim work with `FOR UPDATE SKIP LOCKED` and preserve lease ownership semantics.
- `001_baseline.sql` is the consolidated baseline. New schema changes are append-only migrations starting at `002`.
- Every migration must be safe to reapply. Prefer `IF NOT EXISTS` and equivalent guarded operations.
- Every terminal `needs_human` result must include `reason_code`, `reason_message`, and `remediation`.

### TypeScript and Vue

- Use ESM, strict TypeScript, and `unknown` plus narrowing instead of `any`.
- Keep tests colocated in `__tests__` and use Vitest.
- Use Vue 3 Composition API with `<script setup>`.
- Keep dashboard API calls in `packages/dashboard/src/api.ts` and API contracts in `types/api.ts`.
- Sanitize untrusted error text and model output before rendering it or interpolating it into HTML/Markdown.

### Naming and licensing

- Use the `@opslane/` package scope and the `opslane` CLI name.
- Local Postgres user/database names are `opslane`; Compose services are `ingestion`, `worker`, `postgres`, and `minio`.
- New server-side packages default to `AGPL-3.0-only`. Add code to the MIT SDK/CLI/shared boundary only when that distribution choice is intentional.

## Guardrails

- Do not introduce Redis, BullMQ, or another queue without an explicit architectural decision.
- Do not write unscoped tenant queries.
- Do not store production API keys in plaintext; use the existing envelope-encryption path.
- Do not add legacy compatibility shims unless a documented public contract requires them.
- Do not broaden the current issue into unrelated product expansion.
- Do not add a dependency without checking for an existing utility and reviewing its license.
- Do not weaken terminal-status or lease contracts to make a test pass.
- Do not run destructive database commands unless the task explicitly calls for them.

## Agent workflow

- Work directly when a task is clear; ask only when a decision is destructive, externally side-effectful, or materially ambiguous.
- Preserve unrelated worktree changes and keep diffs small and reviewable.
- Prefer deletion and existing patterns over new abstractions.
- Read current code and tests before changing behavior.
- Use the repository's GitHub tracker from the repository root so `gh` infers the current remote.

Progressive references:

- Issue operations: `docs/agents/issue-tracker.md`
- Triage vocabulary: `docs/agents/triage-labels.md`
- Domain and ADR discovery: `docs/agents/domain.md`
- Installation: `docs/install.md`
- Replay privacy: `docs/replay-privacy.md`
- Public contracts: `docs/contracts/`
