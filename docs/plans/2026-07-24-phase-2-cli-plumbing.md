# Phase 2 — Deterministic CLI Plumbing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build every non-AI, non-TTY piece of `opslane onboard` — key minting, login gate with refresh, poll seam, env writer, wait-for-app, run log — fully unit-tested with injected fetch, plus one Go task closing the cross-flow duplicate-project gap.

**Architecture:** The CLI (never the agent) owns key material and the server poll. A shared `pollSessionOnce` speaks the server's status vocabulary verbatim; callers translate. Provisioning is synchronous (`POST /api/v1/onboard/provision`, landed) with **poll-first resume**. The env writer is the sole key-to-disk path. Sources of truth: the Phase 2 section of `docs/plans/2026-07-22-onboarding-10x-implementation.md` (refreshed 2026-07-24 by eng review — 16 findings folded) and `docs/design/2026-07-22-onboard-engineering-design.md`.

**Tech Stack:** Node 22 + strict TypeScript (ESM), Vitest (colocated `__tests__`), Go 1.24 + chi/pgx for Task 1. No new dependencies.

**Branch:** `git fetch origin main` first, then create `abhishekray07/onboard-phase-2-plumbing` off **`origin/main`** (975b74d or later — it must contain `cli/src/onboard/engine.ts`, landed by squash-merge #190). Local `main` is stale (c18fc7d) and lacks every Phase 1 prerequisite; do NOT branch from it. Sanity check after branching: `test -f cli/src/onboard/engine.ts && echo ok`.

**Lanes (parallelizable):** Lane A = Task 1 (Go, independent). Lane B = Tasks 2→3→4→5→6 (sequential). Lane C = Tasks 7, 9 (independent of B). Task 8 needs Task 2. Task 10 last.

**Key contracts (memorize before starting):**
- Server poll statuses (DB domain, `packages/ingestion/db/queries.go:3277`): `pending | provisioned | key_ok | app_reporting | completed | expired | failed`. HTTP mappings: 404→`not_found`, 410→`expired`, 429→`rate_limited`, 500→`internal_error`.
- Two wire dialects: `agentJSON` emits `{"status": ...}`; `writeJSONError` emits `{"error": "..."}` with **no** status field (400/401/403). Branch on HTTP status for the latter.
- The poll **re-delivers the raw `api_key` on every poll** while `api_key_sealed` is set and `now < expires_at` (`handler/agent_setup.go:192-207`). This is why resume is poll-first.
- The agent's handoff is `OnboardingPlan` (`cli/src/onboard/tools.ts:47`): `app_dir`, `env_prefix`, `env_vars.{api_key, endpoint}` — names only, single app.
- `/onboard/provision` is admin-gated in cloud (`RequireRoleIfCloud("admin")`, `routes.go:113`) — 403 is a distinct, non-retryable error.

---

### Task 1: Go server guard — adopt an existing project for the same repo (+ copy fix)

**Why:** `ProvisionOnboardSession` dedupes only via idempotency token `"onboard:"+lower(repo)`. Projects created by the GitHub-App setup flow have **no** token, so onboarding such a repo mints a duplicate project and splits events. The fix: inside the existing transaction, tag exactly one untagged org-scoped project for this repo, so the existing `INSERT ... ON CONFLICT (org_id, idempotency_token)` upsert converges onto it. Do NOT use `FindProjectByRepoURL` (`db/queries.go:3418`) — it is not org-scoped, and ingestion guardrails require org scoping.

**Files:**
- Modify: `packages/ingestion/db/onboard_provision.go` (inside `ProvisionOnboardSession`, before the `provisionProjectTx` call at line 64)
- Modify: `packages/ingestion/handler/agent_setup.go:193` (copy fix)
- Test: `packages/ingestion/db/onboard_provision_test.go` (extend, reusing its existing org/user/project fixtures)

**Step 1: Write the failing test**

Read `packages/ingestion/db/onboard_provision_test.go` first and reuse its existing setup helpers (org + user creation, `DATABASE_URL` skip guard). Add:

Note: `CreateProjectTx` requires a `pgx.Tx` (`db/queries.go:3166`) — seed the untagged project with plain SQL instead:

```go
func TestProvisionOnboardSessionAdoptsExistingUntaggedProject(t *testing.T) {
	// setup: org + user via the file's existing helpers; then create a project
	// the way the GitHub-App setup flow does — no idempotency token:
	var existingID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name, github_repo) VALUES ($1, 'web', 'Acme/Web') RETURNING id`,
		orgID).Scan(&existingID); err != nil { t.Fatal(err) }

	result, err := q.ProvisionOnboardSession(ctx, db.OnboardProvisionInput{
		OrgID: orgID, ProvisionedBy: userID, Repo: "acme/web", // case differs on purpose
		PollTokenHash: hash, AgentKeyPub: pub, SealKey: sealFn,
	})
	if err != nil { t.Fatal(err) }

	if result.ProjectID != existingID {
		t.Fatalf("adopted project = %s, want existing %s", result.ProjectID, existingID)
	}
	// exactly one project for this org+repo — no duplicate row
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM projects WHERE org_id = $1 AND lower(github_repo) = lower($2)`,
		orgID, "acme/web").Scan(&count); err != nil { t.Fatal(err) }
	if count != 1 { t.Fatalf("project count = %d, want 1", count) }
}
```

Add two more tests:
1. **Two orgs, same repo** → each keeps its **own** project (no cross-org adoption).
2. **Dirty coexistence (convergence definition):** the org already has BOTH an
   onboard-tagged project (token `onboard:acme/web`) AND an untagged GitHub-flow
   project for the same repo. Provisioning must return the **tagged** project,
   leave the untagged row untouched, and NOT error — a naive unconditional tag
   would collide with the partial unique index `(org_id, idempotency_token)`
   and 500. Assert: `result.ProjectID` = the tagged project's id; untagged row
   still exists with `idempotency_token IS NULL`.

**Step 2: Run the test — verify it fails**

```bash
cd packages/ingestion
DATABASE_URL='postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable' go test ./db -run TestProvisionOnboardSessionAdopts -v
```
Expected: FAIL — `adopted project = <new-id>, want existing <id>` (a duplicate was created).
**CAUTION:** without `DATABASE_URL` these tests `t.Skip` and print ok — that is NOT a pass. Start deps first if needed: `docker compose up -d postgres minio && docker compose run --rm migrate`.

**Step 3: Implement the adopt step**

In `db/onboard_provision.go`, immediately after `defer tx.Rollback(ctx)` and before the `provisionProjectTx` call, insert:

```go
	// Adopt an existing untagged project for this org+repo (e.g. created by the
	// GitHub-App setup flow) so onboarding converges on it instead of minting a
	// duplicate. Tag exactly one row — the oldest — and only when no project in
	// this org already carries this token: the partial unique index on
	// (org_id, idempotency_token) forbids two tagged rows, and if a tagged
	// project already exists it wins (the untagged duplicate is pre-existing
	// dirty state we tolerate, not worsen).
	if _, err := tx.Exec(ctx, `
		UPDATE projects
		SET idempotency_token = $3
		WHERE id = (
			SELECT id FROM projects
			WHERE org_id = $1
			  AND lower(github_repo) = lower($2)
			  AND idempotency_token IS NULL
			ORDER BY created_at ASC
			LIMIT 1
			FOR UPDATE
		)
		AND NOT EXISTS (
			SELECT 1 FROM projects
			WHERE org_id = $1 AND idempotency_token = $3
		)`,
		in.OrgID, repo, "onboard:"+strings.ToLower(repo),
	); err != nil {
		return nil, fmt.Errorf("provision onboard session: adopt existing project: %w", err)
	}
```

**Step 4: Copy fix.** In `handler/agent_setup.go:193`, change:

```go
resp["message"] = "key delivery window closed; re-run setup to mint a new key"
```
to:
```go
resp["message"] = "key delivery window closed; run \"opslane login\" then \"opslane setup --relink\" for an existing project, or re-run provisioning"
```
Check `handler/agent_setup_test.go` for an assertion on the old string and update it.

**Step 5: Run tests — verify they pass**

```bash
DATABASE_URL='postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable' go test ./db ./handler -v 2>&1 | tail -20
go build ./...
```
Expected: PASS (and no unexpected skips in the onboard tests).

**Step 6: Commit**

```bash
git add packages/ingestion/db/onboard_provision.go packages/ingestion/db/onboard_provision_test.go packages/ingestion/handler/agent_setup.go packages/ingestion/handler/agent_setup_test.go
git commit -m "fix(ingestion): onboard provisioning adopts an existing project for the same repo"
```

---

### Task 2: `pollSessionOnce` — the typed poll seam

**Files:**
- Create: `cli/src/agent-protocol.ts`
- Modify: `cli/src/setup.ts` (delete its private `responseJSON`/`retryAfterSeconds`, import from the new module; rewire `pollLoop`)
- Test: `cli/src/__tests__/agent-protocol.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { pollSessionOnce } from '../agent-protocol.js';

const OPTS = {
  apiUrl: 'http://localhost:8082',
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
  pollToken: 'tok_abc',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('pollSessionOnce', () => {
  it('sends the poll token header to the poll endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'pending' }));
    await pollSessionOnce({ ...OPTS, fetchFn });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`http://localhost:8082/api/v1/agent/poll/${OPTS.sessionId}`);
    expect((init.headers as Record<string, string>)['X-Opslane-Poll-Token']).toBe('tok_abc');
  });

  it('passes provisioned/key_ok/app_reporting through verbatim with payloads', async () => {
    for (const status of ['provisioned', 'key_ok', 'app_reporting'] as const) {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, {
        status, api_key: 'opk_raw', org_id: 'org1', project_id: 'proj1', repo: 'acme/web',
      }));
      const result = await pollSessionOnce({ ...OPTS, fetchFn });
      expect(result.status).toBe(status);            // never collapsed
      if (result.status === status) {
        expect(result.apiKey).toBe('opk_raw');
        expect(result.orgId).toBe('org1');
        expect(result.projectId).toBe('proj1');
      }
    }
  });

  it('maps 404 to not_found verbatim, never a generic failed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(404, { status: 'not_found' }));
    expect((await pollSessionOnce({ ...OPTS, fetchFn })).status).toBe('not_found');
  });

  it('maps 429 to rate_limited with retryAfter from the body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(429, { status: 'rate_limited', retry_after: 7 }));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    expect(result.status).toBe('rate_limited');
    if (result.status === 'rate_limited') expect(result.retryAfterSeconds).toBe(7);
  });

  it('falls back to the Retry-After header when the body has no retry_after', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(429, { status: 'rate_limited' }, { 'Retry-After': '11' }));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    if (result.status === 'rate_limited') expect(result.retryAfterSeconds).toBe(11);
  });

  it('returns unreachable on fetch rejection — never throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    expect(result.status).toBe('unreachable');
  });

  it('maps malformed JSON to internal_error carrying the raw body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    expect(result.status).toBe('internal_error');
    if (result.status === 'internal_error') expect(result.message).toContain('oops');
  });

  it('handles the {"error": ...} dialect (valid JSON, no status field) by HTTP status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid session id' }));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    expect(result.status).toBe('internal_error');   // 400 on poll = client bug
    if (result.status === 'internal_error') expect(result.message).toBe('invalid session id');
  });

  it('non-2xx HTTP wins over a contradicting body status', async () => {
    const cases = [
      { http: 500, body: { status: 'pending' }, want: 'internal_error' },        // never trust "pending" on a 500
      { http: 401, body: { status: 'completed', api_key: 'k' }, want: 'internal_error' },
      { http: 410, body: { status: 'pending' }, want: 'expired' },
      { http: 404, body: { status: 'wat' }, want: 'not_found' },                 // unknown body never shadows a mapped HTTP error
    ] as const;
    for (const { http, body, want } of cases) {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(http, body));
      expect((await pollSessionOnce({ ...OPTS, fetchFn })).status).toBe(want);
    }
  });

  it('surfaces an unknown server status as unknown with the raw string', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'wat' }));
    const result = await pollSessionOnce({ ...OPTS, fetchFn });
    expect(result.status).toBe('unknown');
    if (result.status === 'unknown') expect(result.serverStatus).toBe('wat');
  });
});
```

**Step 2: Run tests — verify they fail**

```bash
pnpm --filter @opslane/cli exec vitest run src/__tests__/agent-protocol.test.ts
```
Expected: FAIL — `Cannot find module '../agent-protocol.js'`.

**Step 3: Implement `cli/src/agent-protocol.ts`**

```typescript
/**
 * Shared wire protocol for GET /api/v1/agent/poll/{sessionId}.
 *
 * This module returns the SERVER's status vocabulary verbatim — deliberately
 * NOT the CLI contract statuses in contract.ts. contract.ts describes what the
 * `setup` command prints to users; this seam reports what the server said, and
 * each caller (setup's pollLoop, onboard's waitForAppReporting) translates.
 * Collapsing here would erase the key_ok vs app_reporting distinction the
 * onboarding aha depends on.
 *
 * Purity rules: no console, no process.exit, no state deletion, never throws.
 */
import { canonicalOrigin } from './origin.js';

export type ServerPollStatus =
  | 'pending' | 'provisioned' | 'key_ok' | 'app_reporting'
  | 'completed' | 'failed' | 'not_found' | 'expired'
  | 'rate_limited' | 'internal_error';

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'provisioned', 'key_ok', 'app_reporting',
  'completed', 'failed', 'not_found', 'expired', 'rate_limited', 'internal_error',
]);

export interface PollPayload {
  apiKey: string | null;
  orgId: string | null;
  projectId: string | null;
  repo: string | null;
  message: string | null;
  failureReason: string | null;
  retryAfterSeconds: number | null;
}

export type PollResult =
  | ({ status: ServerPollStatus } & PollPayload)
  | ({ status: 'unknown'; serverStatus: string } & PollPayload)
  | { status: 'unreachable'; error: string };

export interface PollSessionOptions {
  apiUrl: string;
  sessionId: string;
  pollToken: string;
  fetchFn?: typeof fetch;
}

type JsonBody = Record<string, unknown>;

export async function responseJSON(response: Response): Promise<JsonBody | null> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as JsonBody
      : null;
  } catch {
    return null;
  }
}

export function retryAfterSeconds(response: Response, body: JsonBody): number {
  const bodyValue = Number(body['retry_after']);
  if (Number.isFinite(bodyValue) && bodyValue > 0) return bodyValue;
  const headerValue = Number(response.headers.get('Retry-After'));
  return Number.isFinite(headerValue) && headerValue > 0 ? headerValue : 60;
}

function str(body: JsonBody, key: string): string | null {
  return typeof body[key] === 'string' ? body[key] as string : null;
}

function payload(response: Response, body: JsonBody): PollPayload {
  return {
    apiKey: str(body, 'api_key'),
    orgId: str(body, 'org_id'),
    projectId: str(body, 'project_id'),
    repo: str(body, 'repo'),
    message: str(body, 'message'),
    failureReason: str(body, 'failure_reason'),
    retryAfterSeconds: retryAfterSeconds(response, body),
  };
}

const EMPTY: PollPayload = {
  apiKey: null, orgId: null, projectId: null, repo: null,
  message: null, failureReason: null, retryAfterSeconds: null,
};

function statusFromHTTP(code: number): ServerPollStatus {
  if (code === 404) return 'not_found';
  if (code === 410) return 'expired';
  if (code === 429) return 'rate_limited';
  return 'internal_error';
}

export async function pollSessionOnce(options: PollSessionOptions): Promise<PollResult> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(
      `${canonicalOrigin(options.apiUrl)}/api/v1/agent/poll/${encodeURIComponent(options.sessionId)}`,
      { headers: { 'X-Opslane-Poll-Token': options.pollToken } },
    );
  } catch (error) {
    return { status: 'unreachable', error: error instanceof Error ? error.message : String(error) };
  }

  const raw = await response.clone().text().catch(() => '');
  const body = await responseJSON(response);
  if (!body) {
    return {
      status: 'internal_error', ...EMPTY,
      message: `unparseable server response: ${raw.slice(0, 200)}`,
    };
  }

  const serverStatus = str(body, 'status');

  // Non-2xx HTTP takes precedence over the body: {"status":"pending"} on a 500
  // (or "completed" on a 401) must not be trusted — a broken proxy or auth
  // layer could otherwise put a caller into an infinite wait or a fake success.
  // This also absorbs the {"error": "..."} dialect (writeJSONError), which
  // only ever rides on non-2xx responses.
  if (!response.ok) {
    return {
      status: statusFromHTTP(response.status),
      ...payload(response, body),
      message: str(body, 'message') ?? str(body, 'error')
        ?? (serverStatus
          ? `server said ${JSON.stringify(serverStatus)} with HTTP ${response.status}`
          : `unexpected response (HTTP ${response.status})`),
    };
  }

  if (!serverStatus) {
    return {
      status: 'internal_error', ...EMPTY,
      message: str(body, 'error') ?? 'response omitted status',
    };
  }
  if (!KNOWN_STATUSES.has(serverStatus)) {
    return { status: 'unknown', serverStatus, ...payload(response, body) };
  }
  return { status: serverStatus as ServerPollStatus, ...payload(response, body) };
}
```

**Step 4: Run the new tests — verify they pass**

```bash
pnpm --filter @opslane/cli exec vitest run src/__tests__/agent-protocol.test.ts
```
Expected: PASS (all 9).

**Step 5: Rewire `setup.ts` — behavior byte-identical**

1. Delete `responseJSON` (setup.ts:74) and `retryAfterSeconds` (setup.ts:85); add
   `import { pollSessionOnce, responseJSON, retryAfterSeconds } from './agent-protocol.js';`
   (the two helpers are still used by `setup()`'s non-poll paths — keep those call sites).
2. Replace the body of `pollLoop`'s try/catch fetch + status ladder with a switch on `pollSessionOnce`:

```typescript
async function pollLoop(
  pending: PendingSession,
  timeout: number,
  options: SetupOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const pendingDir = options.pendingDir ?? defaultPendingDir();
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeout * 1_000;
  let reachedServer = false;
  let waitingForApp = false;

  while (Date.now() < deadline) {
    const result = await pollSessionOnce({
      apiUrl: pending.api_url, sessionId: pending.poll_id,
      pollToken: pending.poll_token, fetchFn,
    });

    if (result.status === 'unreachable') {
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleepFn(Math.min(interval, remaining));
      continue;
    }
    reachedServer = true;

    if (result.status === 'pending') {
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleepFn(Math.min(interval, remaining));
      continue;
    }
    if (result.status === 'rate_limited') {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await sleepFn(Math.min((result.retryAfterSeconds ?? 60) * 1_000, remaining));
      }
      continue;
    }
    if (result.status === 'provisioned' || result.status === 'key_ok'
      || result.status === 'app_reporting' || result.status === 'completed') {
      const apiKey = result.apiKey;
      if (!apiKey && result.status !== 'app_reporting') {
        await deletePendingSession(pending.poll_id, pendingDir);
        return exitWithStatus('key_unavailable', {
          project_id: result.projectId ?? undefined,
          remediation: 'run "opslane login" then "opslane setup --relink"',
        }, 1);
      }
      const orgId = result.orgId;
      const projectId = result.projectId;
      const repo = result.repo ?? pending.repo;
      if (!orgId || !projectId) {
        return exitWithStatus('internal_error', { message: 'provisioned response omitted project credentials' }, 1);
      }
      if (!apiKey) {
        const saved = await resolveCredentials({ apiUrl: pending.api_url, repo, filePath: credentialsPath });
        if (!saved || saved.project_id !== projectId || saved.org_id !== orgId) {
          await deletePendingSession(pending.poll_id, pendingDir);
          return exitWithStatus('key_unavailable', {
            project_id: result.projectId ?? undefined,
            remediation: 'run "opslane login" then "opslane setup --relink"',
          }, 1);
        }
      }
      if (apiKey) {
        try {
          await saveAgentCredentials({
            org_id: orgId, project_id: projectId, api_key: apiKey,
            repo, api_url: pending.api_url,
          }, credentialsPath);
        } catch {
          return exitWithStatus('internal_error', {
            message: 'could not save provisioned credentials; retry this poll while the key is available',
          }, 1);
        }
      }
      if (result.status !== 'app_reporting' && result.status !== 'completed') {
        waitingForApp = true;
        const remaining = deadline - Date.now();
        if (remaining > 0) await sleepFn(Math.min(interval, remaining));
        continue;
      }
      await deletePendingSession(pending.poll_id, pendingDir);
      jsonOutput({
        status: 'completed', api_key: apiKey ?? undefined,
        org_id: orgId, project_id: projectId, repo,
      });
      return;
    }
    if (result.status === 'failed') {
      await deletePendingSession(pending.poll_id, pendingDir);
      return exitWithStatus('failed', {
        failure_reason: result.failureReason ?? undefined,
        message: result.message ?? undefined,
      }, 1);
    }
    if (result.status === 'not_found') {
      await deletePendingSession(pending.poll_id, pendingDir);
      return exitWithStatus('not_found', { poll_id: pending.poll_id }, 1);
    }
    if (result.status === 'expired') {
      await deletePendingSession(pending.poll_id, pendingDir);
      return exitWithStatus('expired', { remediation: 're-run setup' }, 1);
    }
    if (result.status === 'internal_error') {
      return exitWithStatus('internal_error', { message: result.message ?? 'server error' }, 1);
    }
    return exitWithStatus('internal_error', {
      message: 'unrecognized server status',
      server_status: result.status === 'unknown' ? result.serverStatus : result.status,
    }, 1);
  }

  if (!reachedServer) {
    return exitWithStatus('api_unreachable', { api_url: pending.api_url }, 1);
  }
  jsonOutput({
    status: 'pending',
    poll_id: pending.poll_id,
    message: waitingForApp
      ? 'Waiting for your app to report. Start it locally, then run setup --poll again.'
      : 'Authorization is still pending. Run setup --poll again.',
  });
}
```

**IMPORTANT — the regression gate:** the old `pollLoop` emitted `jsonOutput({ ...body, status: 'completed' })` (whole server body). If `cli/src/__tests__/setup.test.ts` or the subprocess suite asserts on extra fields of that output, match the old shape exactly rather than the trimmed object above — the suites are the source of truth. Run them and reconcile.

**Step 6: Run the full CLI suite — the refactor's proof**

```bash
pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test
```
Expected: PASS — including `setup.test.ts`, `contract-drift.test.ts`, `contract.subprocess.test.ts`.

**Step 7: Commit**

```bash
git add cli/src/agent-protocol.ts cli/src/setup.ts cli/src/__tests__/agent-protocol.test.ts
git commit -m "refactor(cli): extract pollSessionOnce speaking the server status vocabulary"
```

---

### Task 3: `login()` throws typed errors and takes an injectable token path

**Why:** `login()` swallows errors, sets `process.exitCode = 1` (login.ts:166-170), and persists only to the hardcoded credentials file. `ensureLoggedIn` (Task 4) needs a throwing seam and a path-injectable persist.

**Files:**
- Create: `cli/src/onboard/errors.ts`
- Modify: `cli/src/login.ts`, `cli/src/index.ts:36-42`
- Test: `cli/src/__tests__/login.test.ts` (create if absent)

**Step 1: Create the shared error types** (`cli/src/onboard/errors.ts`):

```typescript
/** Typed failures for the deterministic onboarding plumbing (Phase 2). */

export class LoginFailedError extends Error {
  constructor(message = 'Login did not complete. Re-run to try again.') {
    super(message);
    this.name = 'LoginFailedError';
  }
}

export class NotAuthenticatedError extends Error {
  constructor(message = 'Your session is not valid. Log in again.') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

/** 403 from the admin-gated provision route — re-logging-in can never fix this. */
export class NotAuthorizedError extends Error {
  constructor(message = 'Provisioning requires an org admin. Ask an org admin to run onboarding or grant you admin.') {
    super(message);
    this.name = 'NotAuthorizedError';
  }
}

export class ApiUnreachableError extends Error {
  constructor(apiUrl: string) {
    super(`Could not reach the Opslane API at ${apiUrl}.`);
    this.name = 'ApiUnreachableError';
  }
}
```

**Step 2: Write the failing test** (`cli/src/__tests__/login.test.ts`) — only the new contract, not the browser flow:

Do NOT test by binding a privileged port — whether port 1 binds varies by
environment (as root it binds and the test hangs on the 5-minute callback
timeout). Inject the callback seam instead:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { login } from '../login.js';
import { LoginFailedError } from '../onboard/errors.js';

describe('login failure contract', () => {
  it('throws LoginFailedError instead of swallowing when the callback flow fails', async () => {
    await expect(login({
      apiUrl: 'http://localhost:8082', clientId: 'test', quiet: true,
      waitForCallbackFn: vi.fn().mockRejectedValue(new Error('OAuth error: access_denied')),
    })).rejects.toBeInstanceOf(LoginFailedError);
    expect(process.exitCode).not.toBe(1);   // no exit-code poisoning
  });

  it('quiet mode emits zero console output on the success path too', async () => {
    // waitForCallbackFn resolves a code; fetchFn (inject via global stub or an
    // exchangeFn seam) returns a token body; spy on console.log/error and
    // assert neither was called.
  });
});
```

**Step 3: Run — verify it fails** (`login` resolves today instead of rejecting, and `waitForCallbackFn` is not an accepted option):

```bash
pnpm --filter @opslane/cli exec vitest run src/__tests__/login.test.ts
```
Expected: FAIL — promise resolved instead of rejecting.

**Step 4: Modify `login.ts`:**

1. Extend the options: `export interface LoginOptions extends AuthConfig { tokenPath?: string; quiet?: boolean; waitForCallbackFn?: (port: number, expectedState: string) => Promise<string>; }` and change the signature to `login(config: LoginOptions = defaultAuthConfig())`.
2. Replace the final `catch` block: remove `process.exitCode = 1` and the `console.error`; rethrow as `LoginFailedError` with the underlying message (`import { LoginFailedError } from './onboard/errors.js'`).
3. Persist via `persistTokensTo(config.tokenPath ?? defaultTokenPath(), apiUrl, tokens)` (import both from `./auth.js`), replacing the bare `persistTokens` call.
4. Call `(config.waitForCallbackFn ?? waitForCallback)(port, state)`; gate **every** `console.log`/`console.error` in the function behind `if (!config.quiet)` — the intro block, the "Exchanging authorization code" line, AND the success line, so an embedding TUI stays byte-clean.
5. In `cli/src/index.ts` the login action becomes the catcher (preserves today's UX exactly):

```typescript
  .action(async (opts: { apiUrl?: string }) => {
    try {
      await login({
        apiUrl: opts.apiUrl ?? process.env['OPSLANE_API_URL'] ?? 'https://api.opslane.com',
        clientId: process.env['OPSLANE_CLIENT_ID'] ?? 'opslane-cli',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nLogin failed: ${message}`));
      process.exitCode = 1;
    }
  });
```
Check whether `index.ts` already imports `chalk`; add if missing. Also confirm `program.parseAsync` vs `parse` — if the file still uses bare `parse()`, switch to `await program.parseAsync(process.argv)` so the async action's rejection isn't dropped.

**Step 5: Run — verify pass, then full suite:**

```bash
pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test
```
Expected: PASS.

**Step 6: Commit**

```bash
git add cli/src/onboard/errors.ts cli/src/login.ts cli/src/index.ts cli/src/__tests__/login.test.ts
git commit -m "refactor(cli): login throws typed errors and takes an injectable token path"
```

---

### Task 4: `ensureLoggedIn` with refresh grant

**Files:**
- Modify: `cli/src/auth.ts` (add `updateTokensAt` — locked read-modify-write over one origin's pair)
- Create: `cli/src/onboard/provision.ts` (started here, finished in Task 6)
- Test: `cli/src/onboard/__tests__/provision.test.ts`

**Why `updateTokensAt`:** two constraints meet here. (a) `loadTokensFrom` returns `null` for expired pairs (auth.ts:99), but the refresh path needs the **expired** pair's `refreshToken`. (b) The refresh grant **rotates** the token server-side and treats a second consumption of the same token as reuse — revoking the user's whole token family (`ConsumeRefreshToken` / `ErrTokenReuse` in `handler/auth_handlers.go`). So the read→refresh→persist sequence must be one atomic unit under the token file's lock, with a re-check inside it. `withFileLock` is not reentrant (nesting `persistTokensTo` inside it would deadlock into the 2s acquire timeout), so add a callback-style primitive to `auth.ts`:

```typescript
/**
 * Serialized read-modify-write over one origin's token pair. The callback
 * receives the stored pair (expired included; null if absent) and returns the
 * replacement to persist, or null to leave the file unchanged. Holding the
 * lock across the callback is the point: it makes a refresh-grant rotation
 * atomic, so two CLI processes can never consume the same refresh token
 * (the server would treat the loser as token reuse and revoke the family).
 */
export async function updateTokensAt(
  filePath: string,
  apiUrl: string,
  update: (current: TokenPair | null) => Promise<TokenPair | null>,
): Promise<TokenPair | null> {
  return withFileLock(filePath, async () => {
    const file = await readTokenFile(filePath, false);
    const origin = canonicalOrigin(apiUrl);
    const next = await update(file.tokens[origin] ?? null);
    if (next) {
      file.tokens[origin] = next;
      await writeFileAtomic(filePath, `${JSON.stringify(file, null, 2)}\n`);
    }
    return next;
  });
}
```

Known bound: a second process waiting on the lock gives up after `withFileLock`'s 2s acquire deadline and errors visibly — acceptable; a visible error beats a silently revoked token family.

**Step 1: Write the failing tests** (in `provision.test.ts`; use `fs.mkdtemp` + `persistTokensTo` to seed token files):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistTokensTo } from '../../auth.js';
import { ensureLoggedIn } from '../provision.js';
import { LoginFailedError } from '../errors.js';

const API = 'http://localhost:8082';
const LIVE = { accessToken: 'live', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 };
const DEAD = { accessToken: 'dead', refreshToken: 'r2', expiresAt: Date.now() - 1_000 };

async function tokenFile(pair?: typeof LIVE) {
  const dir = await mkdtemp(join(tmpdir(), 'opslane-auth-'));
  const path = join(dir, 'credentials.json');
  if (pair) await persistTokensTo(path, API, pair);
  return path;
}

describe('ensureLoggedIn', () => {
  it('a live token skips both refresh and login', async () => {
    const tokenPath = await tokenFile(LIVE);
    const loginFn = vi.fn();
    const fetchFn = vi.fn();
    const tokens = await ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn });
    expect(tokens.accessToken).toBe('live');
    expect(loginFn).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an expired token tries the refresh grant before any browser', async () => {
    const tokenPath = await tokenFile(DEAD);
    const loginFn = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'fresh', refresh_token: 'r3', expires_in: 900,
    }), { status: 200 }));
    const tokens = await ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn });
    expect(tokens.accessToken).toBe('fresh');
    expect(loginFn).not.toHaveBeenCalled();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${API}/auth/refresh`);
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'r2' });
  });

  it('refresh rejected → login exactly once, then re-load succeeds', async () => {
    const tokenPath = await tokenFile(DEAD);
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid or expired refresh token',
    }), { status: 401 }));
    const loginFn = vi.fn(async () => { await persistTokensTo(tokenPath, API, LIVE); });
    const tokens = await ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn });
    expect(tokens.accessToken).toBe('live');
    expect(loginFn).toHaveBeenCalledTimes(1);
  });

  it('login ran but produced no live token → LoginFailedError, login not retried', async () => {
    const tokenPath = await tokenFile();          // empty
    const loginFn = vi.fn(async () => {});        // "user closed the tab"
    await expect(ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn: vi.fn() }))
      .rejects.toBeInstanceOf(LoginFailedError);
    expect(loginFn).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers refresh exactly once — the loser reuses the winner\'s tokens', async () => {
    // Regression for token-family revocation: the refresh grant rotates the
    // refresh token; a second consumption of the same one revokes the family.
    const tokenPath = await tokenFile(DEAD);
    const fetchFn = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));   // slow refresh, both callers in flight
      return new Response(JSON.stringify({
        access_token: 'fresh', refresh_token: 'r3', expires_in: 900,
      }), { status: 200 });
    });
    const loginFn = vi.fn();
    const [a, b] = await Promise.all([
      ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn }),
      ensureLoggedIn({ apiUrl: API, tokenPath, loginFn, fetchFn }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);        // one consumption of r2, ever
    expect(a.accessToken).toBe('fresh');
    expect(b.accessToken).toBe('fresh');
    expect(loginFn).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run — verify FAIL** (module not found).

**Step 3: Implement in `cli/src/onboard/provision.ts`:**

```typescript
import { canonicalOrigin } from '../origin.js';
import {
  loadTokensFrom, updateTokensAt, type TokenPair,
} from '../auth.js';
import { LoginFailedError } from './errors.js';

export interface EnsureLoggedInOptions {
  apiUrl: string;
  tokenPath: string;
  loginFn: () => Promise<void>;
  fetchFn?: typeof fetch;
}

async function refreshTokens(
  apiUrl: string,
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<TokenPair | null> {
  try {
    const response = await fetchFn(`${apiUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    if (typeof record['access_token'] !== 'string'
      || typeof record['refresh_token'] !== 'string'
      || typeof record['expires_in'] !== 'number') return null;
    return {
      accessToken: record['access_token'],
      refreshToken: record['refresh_token'],
      expiresAt: Date.now() + record['expires_in'] * 1000,
    };
  } catch {
    return null;
  }
}

export async function ensureLoggedIn(options: EnsureLoggedInOptions): Promise<TokenPair> {
  const apiUrl = canonicalOrigin(options.apiUrl);
  const fetchFn = options.fetchFn ?? fetch;

  const live = await loadTokensFrom(options.tokenPath, apiUrl);
  if (live) return live;

  // Atomic under the token file's lock: re-check (a concurrent winner's
  // persist satisfies us with no second consumption), then refresh-and-persist
  // in one unit. See updateTokensAt for why this must not be three steps.
  const refreshed = await updateTokensAt(options.tokenPath, apiUrl, async (current) => {
    if (current && Date.now() < current.expiresAt) return current;   // winner already refreshed
    if (!current?.refreshToken) return null;
    return refreshTokens(apiUrl, current.refreshToken, fetchFn);
  });
  if (refreshed && Date.now() < refreshed.expiresAt) return refreshed;

  await options.loginFn();   // throws LoginFailedError on flow failure (Task 3)
  const after = await loadTokensFrom(options.tokenPath, apiUrl);
  if (!after) throw new LoginFailedError();
  return after;
}
```

**Step 4: Run — verify PASS. Step 5: Commit:**

```bash
git add cli/src/auth.ts cli/src/onboard/provision.ts cli/src/onboard/__tests__/provision.test.ts
git commit -m "feat(cli): onboard login gate with refresh grant and typed failure"
```

---

### Task 5: pending sessions gain `kind`; `findPendingByRepo`

**Files:**
- Modify: `cli/src/pending.ts`
- Test: `cli/src/__tests__/pending.test.ts` (extend)

**Step 1: Write the failing tests** (extend the existing file, reusing its temp-dir pattern):

```typescript
// New describe block. UUIDs must be valid v4-ish per UUID_PATTERN.
import { findPendingByRepo, savePendingSession } from '../pending.js';

const API = 'http://localhost:8082';
function session(pollId: string, overrides: Partial<PendingSession> = {}): PendingSession {
  return {
    kind: 'onboard', poll_id: pollId, poll_token: 't', api_url: API,
    repo: 'Acme/Web', created_at: new Date().toISOString(), ...overrides,
  };
}

describe('findPendingByRepo', () => {
  it('returns null when nothing matches', async () => { /* empty dir → null */ });
  it('matches case-insensitively on repo and canonically on origin', async () => {
    // save session('...1'); expect findPendingByRepo(API, 'acme/web', dir) to return it
  });
  it('same repo, different origin → null', async () => {
    // save with api_url 'http://other:9000'; expect null for API
  });
  it('a setup-kind session for the same repo is neither returned nor deleted', async () => {
    // save session with kind absent (legacy) AND one with kind: 'setup';
    // expect null, and both files still on disk
  });
  it('multiple onboard matches → newest returned, older deleted', async () => {
    // two sessions, created_at 1h apart; expect newest returned and old file gone
  });
  it('entries older than the TTL are pruned and not returned', async () => {
    // created_at 25h ago (TTL 24h) → null, file deleted
  });
  it('malformed files are skipped, not thrown', async () => {
    // write 'not json' to <uuid>.json → find still works
  });
});
```

Write each body out fully in the test file (they are 3-6 lines each with the helpers above).

**Step 2: Run — verify FAIL** (`findPendingByRepo` not exported).

**Step 3: Implement in `pending.ts`:**

```typescript
import { readdir, readFile, unlink } from 'node:fs/promises';   // add readdir

export interface PendingSession {
  kind?: 'onboard' | 'setup';   // absent = setup (pre-discriminator files)
  poll_id: string;
  poll_token: string;
  api_url: string;
  repo: string;
  created_at: string;
}

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;   // matches server onboardSessionTTL

// In isPendingSession, additionally accept the optional kind:
//   const kind = record['kind'];
//   if (kind !== undefined && kind !== 'onboard' && kind !== 'setup') return false;

export async function findPendingByRepo(
  apiUrl: string,
  repo: string,
  baseDir: string = DEFAULT_PENDING_DIR,
  ttlMs: number = PENDING_TTL_MS,
): Promise<PendingSession | null> {
  let entries: string[];
  try { entries = await readdir(baseDir); } catch { return null; }
  const origin = canonicalOrigin(apiUrl);
  const target = repo.toLowerCase();
  const matches: PendingSession[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(join(baseDir, name), 'utf8')); } catch { continue; }
    if (!isPendingSession(parsed)) continue;
    if ((parsed.kind ?? 'setup') !== 'onboard') continue;
    let sameTarget = false;
    try {
      sameTarget = canonicalOrigin(parsed.api_url) === origin && parsed.repo.toLowerCase() === target;
    } catch { continue; }
    if (!sameTarget) continue;
    const age = Date.now() - Date.parse(parsed.created_at);
    if (!Number.isFinite(age) || age > ttlMs) {
      await deletePendingSession(parsed.poll_id, baseDir).catch(() => undefined);
      continue;
    }
    matches.push(parsed);
  }
  matches.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const [newest, ...stale] = matches;
  for (const s of stale) await deletePendingSession(s.poll_id, baseDir).catch(() => undefined);
  return newest ?? null;
}
```

**Step 4: Run pending tests + full suite — PASS** (`setup.ts` needs no change: it never sets `kind`, and absent = setup). **Step 5: Commit:**

```bash
git add cli/src/pending.ts cli/src/__tests__/pending.test.ts
git commit -m "feat(cli): pending sessions carry a flow kind; add findPendingByRepo"
```

---

### Task 6: `ensureProvisioned` — synchronous mint with poll-first resume

**Files:**
- Modify: `cli/src/onboard/provision.ts` (add to Task 4's file)
- Test: `cli/src/onboard/__tests__/provision.test.ts` (extend)

**Step 1: Write the failing tests:**

```typescript
import { ensureProvisioned } from '../provision.js';
import { NotAuthenticatedError, NotAuthorizedError, ApiUnreachableError } from '../errors.js';
import { savePendingSession, loadPendingSession } from '../../pending.js';
import { loadAgentCredentials } from '../../agent-credentials.js';

const PROVISIONED = {
  status: 'provisioned', api_key: 'opk_raw', endpoint: 'http://localhost:8082',
  org_id: 'org1', project_id: 'proj1', repo: 'acme/web',
  poll_id: '123e4567-e89b-42d3-a456-426614174000', poll_token: 'ptok',
};

describe('ensureProvisioned', () => {
  it('fresh repo: POSTs with the bearer token, saves pending {kind: onboard} + credentials, returns the tuple', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(PROVISIONED), { status: 201 }));
    const result = await ensureProvisioned({ apiUrl: API, repo: 'acme/web', token: 'bearer1', fetchFn, ...tmpPaths() });
    expect(result).toMatchObject({
      apiKey: 'opk_raw', endpoint: 'http://localhost:8082', orgId: 'org1',
      projectId: 'proj1', sessionId: PROVISIONED.poll_id, pollToken: 'ptok',
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${API}/api/v1/onboard/provision`);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bearer1');
    const pending = await loadPendingSession(PROVISIONED.poll_id, pendingDir);
    expect(pending?.kind).toBe('onboard');
    expect((await loadAgentCredentials({ apiUrl: API, repo: 'acme/web', filePath: credentialsPath }))?.api_key).toBe('opk_raw');
  });

  it('resume: a live pending session is verified with ONE poll and reused — no POST', async () => {
    // seed pending {kind:'onboard'}; fetchFn answers the POLL url with key_ok + api_key
    // expect: no POST call, result.sessionId === pending.poll_id, result.apiKey from the poll
  });

  it('resume: poll says expired → stale pending deleted, falls through to fresh POST', async () => {
    // fetchFn: poll url → 410 {status:'expired'}; provision url → 201 PROVISIONED
    // expect: new sessionId, old pending file gone, new pending file saved
  });

  it('resume: poll completed WITHOUT api_key (window closed) → fresh POST', async () => { /* same shape */ });

  it('401 → NotAuthenticatedError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'authentication required' }), { status: 401 }));
    await expect(ensureProvisioned({ ...base, fetchFn })).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('403 (admin gate, {"error"} dialect) → NotAuthorizedError naming an org admin', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    await expect(ensureProvisioned({ ...base, fetchFn })).rejects.toBeInstanceOf(NotAuthorizedError);
  });

  it('429 waits retry_after then retries', async () => {
    // first call: 429 {status:'rate_limited', retry_after: 5}; second: 201
    // injected sleepFn records 5000ms; expect success after 2 fetch calls
  });

  it('a network error on the POST is NOT retried — one attempt, then ApiUnreachableError', async () => {
    // Retrying an ambiguous POST is unsafe: a lost response still rotated the
    // key server-side, so blind retries multiply state mutations.
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await expect(ensureProvisioned({ ...base, fetchFn, sleepFn })).rejects.toBeInstanceOf(ApiUnreachableError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('resume: an unreachable probe throws and PRESERVES the pending session — never falls through to a fresh rotation', async () => {
    // seed pending {kind:'onboard'}; fetchFn rejects (outage)
    // expect: ApiUnreachableError, fetchFn called once (no POST), pending file still on disk
  });

  it('201 missing org_id/project_id → typed error, no credentials saved', async () => { /* body without org_id */ });
});
```

Fill in the sketched bodies fully; `tmpPaths()` mints `{pendingDir, credentialsPath}` under `mkdtemp`.

**Step 2: Run — FAIL. Step 3: Implement** (append to `provision.ts`):

```typescript
import { pollSessionOnce } from '../agent-protocol.js';
import {
  findPendingByRepo, savePendingSession, deletePendingSession,
  validatePollId, defaultPendingDir, type PendingSession,
} from '../pending.js';
import { saveAgentCredentials, defaultCredentialsPath } from '../agent-credentials.js';
import { NotAuthenticatedError, NotAuthorizedError, ApiUnreachableError } from './errors.js';
import { responseJSON, retryAfterSeconds } from '../agent-protocol.js';

export interface ProvisionResult {
  apiKey: string;
  endpoint: string;
  orgId: string;
  projectId: string;
  sessionId: string;
  pollToken: string;
}

export interface EnsureProvisionedOptions {
  apiUrl: string;
  repo: string;
  token: string;                       // account bearer token from ensureLoggedIn
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  pendingDir?: string;
  credentialsPath?: string;
  max429Retries?: number;              // default 3; 429 is the ONLY retried failure
}

const RESUMABLE = new Set(['provisioned', 'key_ok', 'app_reporting', 'completed']);

export async function ensureProvisioned(options: EnsureProvisionedOptions): Promise<ProvisionResult> {
  const apiUrl = canonicalOrigin(options.apiUrl);
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pendingDir = options.pendingDir ?? defaultPendingDir();
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();

  // Poll-first resume: the poll re-delivers the raw key while the session lives,
  // so one poll proves server-side liveness, recovers a key that never reached
  // disk, and catches a key another machine rotated. A DEAD session falls
  // through to a fresh POST; an UNREACHABLE probe must NOT — provisioning
  // rotates the key and expires this session server-side, so falling through
  // during an outage would destroy a session that is still perfectly alive.
  const pending = await findPendingByRepo(apiUrl, options.repo, pendingDir);
  if (pending) {
    const probe = await pollSessionOnce({
      apiUrl, sessionId: pending.poll_id, pollToken: pending.poll_token, fetchFn,
    });
    if (probe.status === 'unreachable') {
      throw new ApiUnreachableError(apiUrl);   // pending record preserved; re-run resumes
    }
    if (probe.status !== 'unknown'
      && RESUMABLE.has(probe.status) && probe.apiKey && probe.orgId && probe.projectId) {
      const result: ProvisionResult = {
        apiKey: probe.apiKey, endpoint: apiUrl, orgId: probe.orgId,
        projectId: probe.projectId, sessionId: pending.poll_id, pollToken: pending.poll_token,
      };
      await saveAgentCredentials({
        org_id: result.orgId, project_id: result.projectId, api_key: result.apiKey,
        repo: options.repo, api_url: apiUrl,
      }, credentialsPath);
      return result;
    }
    // Dead or key-less session — a fresh POST replaces it.
    await deletePendingSession(pending.poll_id, pendingDir).catch(() => undefined);
  }

  // ONE attempt — no automatic retry after an ambiguous network failure. Every
  // successful POST rotates the key and expires prior sessions server-side, so
  // a lost RESPONSE means a blind retry mutates server state again (and again).
  // On failure the user re-runs; resume is poll-first, so a saved session is
  // recovered rather than re-minted. 429 alone is retried: the limiter rejects
  // BEFORE provisioning runs, so nothing was mutated.
  const max429Retries = options.max429Retries ?? 3;
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetchFn(`${apiUrl}/api/v1/onboard/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ repo_url: options.repo }),
      });
    } catch {
      throw new ApiUnreachableError(apiUrl);
    }
    if (response.status === 429 && attempt < max429Retries) {
      const body = await responseJSON(response.clone()) ?? {};
      await sleepFn(retryAfterSeconds(response, body) * 1_000);
      continue;
    }
    break;
  }

  if (response.status === 401) throw new NotAuthenticatedError();
  if (response.status === 403) throw new NotAuthorizedError();
  const body = await responseJSON(response);
  if (response.status !== 201 || !body || body['status'] !== 'provisioned') {
    const detail = body ? (body['error'] ?? body['message'] ?? body['status']) : 'unparseable response';
    throw new Error(`provisioning failed (HTTP ${response.status}): ${String(detail)}`);
  }

  const apiKey = body['api_key'];
  const orgId = body['org_id'];
  const projectId = body['project_id'];
  const pollId = body['poll_id'];
  const pollToken = body['poll_token'];
  const endpoint = typeof body['endpoint'] === 'string' ? body['endpoint'] : apiUrl;
  if (typeof apiKey !== 'string' || typeof orgId !== 'string' || typeof projectId !== 'string'
    || typeof pollId !== 'string' || typeof pollToken !== 'string') {
    throw new Error('provisioning response omitted required credentials');
  }
  validatePollId(pollId);

  const session: PendingSession = {
    kind: 'onboard', poll_id: pollId, poll_token: pollToken,
    api_url: apiUrl, repo: options.repo, created_at: new Date().toISOString(),
  };
  await savePendingSession(session, pendingDir);
  await saveAgentCredentials({
    org_id: orgId, project_id: projectId, api_key: apiKey,
    repo: options.repo, api_url: apiUrl,
  }, credentialsPath);

  return { apiKey, endpoint, orgId, projectId, sessionId: pollId, pollToken };
}
```

**Step 4: Run — PASS, then full suite. Step 5: Commit:**

```bash
git add cli/src/onboard/provision.ts cli/src/onboard/__tests__/provision.test.ts
git commit -m "feat(cli): ensureProvisioned with poll-first resume and typed auth errors"
```

---

### Task 7: `writeEnvLocal` — the sole key-to-disk path

**Files:**
- Create: `cli/src/envfile.ts`
- Modify: `cli/src/init.ts` (rewire `persistApiKeyEnvironment`, init.ts:108)
- Test: `cli/src/__tests__/envfile.test.ts`

**Step 1: Write the failing tests:**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEnvLocal } from '../envfile.js';

async function dir() { return mkdtemp(join(tmpdir(), 'opslane-env-')); }
async function mode(path: string) { return (await stat(path)).mode & 0o777; }

describe('writeEnvLocal', () => {
  it('creates .env.local with mode 0600 and returns the path', async () => {
    const d = await dir();
    const path = await writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'opk_1' });
    expect(path).toBe(join(d, '.env.local'));
    expect(await readFile(path, 'utf8')).toBe('VITE_OPSLANE_API_KEY=opk_1\n');
    expect(await mode(path)).toBe(0o600);
  });

  it('appends missing keys without touching existing lines', async () => {
    const d = await dir();
    await writeFile(join(d, '.env.local'), 'EXISTING=1\n');
    await writeEnvLocal(d, { VITE_OPSLANE_ENDPOINT: 'http://x' });
    expect(await readFile(join(d, '.env.local'), 'utf8'))
      .toBe('EXISTING=1\nVITE_OPSLANE_ENDPOINT=http://x\n');
  });

  it('replaces an existing value for the same key', async () => {
    const d = await dir();
    await writeFile(join(d, '.env.local'), 'VITE_OPSLANE_API_KEY=old\nOTHER=2\n');
    await writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'new' });
    expect(await readFile(join(d, '.env.local'), 'utf8')).toBe('VITE_OPSLANE_API_KEY=new\nOTHER=2\n');
  });

  it('tightens a pre-existing 0644 file to 0600', async () => {
    const d = await dir();
    const p = join(d, '.env.local');
    await writeFile(p, 'A=1\n');
    await chmod(p, 0o644);
    await writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'k' });
    expect(await mode(p)).toBe(0o600);
  });

  it('adds .env.local to the dir gitignore exactly once', async () => {
    const d = await dir();
    await writeEnvLocal(d, { A_B: '1' });
    await writeEnvLocal(d, { A_B: '2' });
    const lines = (await readFile(join(d, '.gitignore'), 'utf8')).split('\n').filter((l) => l === '.env.local');
    expect(lines).toHaveLength(1);
  });

  it('rejects var names failing the regex', async () => {
    const d = await dir();
    await expect(writeEnvLocal(d, { 'lower_case': 'x' })).rejects.toThrow(/variable name/);
    await expect(writeEnvLocal(d, { 'A=B\nINJECTED': 'x' })).rejects.toThrow(/variable name/);
  });
});
```

**Step 2: Run — FAIL. Step 3: Implement `cli/src/envfile.ts`:**

```typescript
/**
 * The single place a provisioned API key touches disk. Names come from the
 * agent's validated OnboardingPlan (tools.ts validatePlan); values come from
 * provisioning. Atomic write (fsutil), 0600 always.
 */
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

export async function writeEnvLocal(dir: string, vars: Record<string, string>): Promise<string> {
  for (const name of Object.keys(vars)) {
    if (!ENV_VAR_NAME.test(name)) {
      throw new Error(`invalid environment variable name: ${JSON.stringify(name)}`);
    }
  }
  const envPath = join(dir, '.env.local');
  let current = '';
  try { current = await readFile(envPath, 'utf8'); } catch { /* create below */ }
  let next = current;
  for (const [name, value] of Object.entries(vars)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    next = pattern.test(next)
      ? next.replace(pattern, line)
      : `${next}${next && !next.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  await writeFileAtomic(envPath, next);   // temp opened 0600 → rename
  await chmod(envPath, 0o600);            // covers pre-existing looser modes

  const gitignorePath = join(dir, '.gitignore');
  let gitignore = '';
  try { gitignore = await readFile(gitignorePath, 'utf8'); } catch { /* create below */ }
  if (!gitignore.split(/\r?\n/).includes('.env.local')) {
    gitignore += `${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}.env.local\n`;
    await writeFile(gitignorePath, gitignore, 'utf8');
  }
  return envPath;
}
```

**Step 4: Rewire `init.ts`** — replace the body of `persistApiKeyEnvironment` (init.ts:108-128) with:

```typescript
async function persistApiKeyEnvironment(cwd: string, framework: Framework, apiKey: string): Promise<void> {
  await writeEnvLocal(cwd, { [apiKeyEnvironmentVariable(framework)]: apiKey });
}
```
(add `import { writeEnvLocal } from './envfile.js';`; remove now-unused fs imports if any).

**Step 5: Run envfile + init tests + full suite — PASS. Step 6: Commit:**

```bash
git add cli/src/envfile.ts cli/src/init.ts cli/src/__tests__/envfile.test.ts
git commit -m "refactor(cli): shared atomic env writer; init rewired onto it"
```

---

### Task 8: `waitForAppReporting`

**Files:**
- Create: `cli/src/onboard/wait.ts`
- Test: `cli/src/onboard/__tests__/wait.test.ts`

**Step 1: Write the failing tests** — drive with a queue of poll responses:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { waitForAppReporting } from '../wait.js';

const OPTS = {
  apiUrl: 'http://localhost:8082',
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
  pollToken: 'ptok',
  timeoutMs: 60_000,
  sleepFn: vi.fn().mockResolvedValue(undefined),
};
function seq(...bodies: Array<{ status: number; body: unknown }>) {
  const fetchFn = vi.fn();
  for (const { status, body } of bodies) {
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  }
  return fetchFn;
}

describe('waitForAppReporting', () => {
  it('provisioned → key_ok → app_reporting resolves (provisioned counts as waiting)', async () => {
    const fetchFn = seq(
      { status: 200, body: { status: 'provisioned', api_key: 'k' } },
      { status: 200, body: { status: 'key_ok', api_key: 'k' } },
      { status: 200, body: { status: 'app_reporting' } },
    );
    await expect(waitForAppReporting({ ...OPTS, fetchFn })).resolves.toMatchObject({ status: 'app_reporting' });
  });

  it('completed resolves', async () => { /* single completed response */ });

  it('failed rejects with the failure_reason and is never retried', async () => {
    const fetchFn = seq({ status: 200, body: { status: 'failed', failure_reason: 'github_error' } });
    await expect(waitForAppReporting({ ...OPTS, fetchFn })).rejects.toThrow(/github_error/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('expired and not_found reject with remediation', async () => { /* 410 / 404 */ });

  it('rate_limited honors retryAfter before the next poll', async () => {
    // 429 {retry_after: 9} then app_reporting; expect sleepFn called with 9000
  });

  it('unreachable retries with backoff up to a bound, then rejects', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(waitForAppReporting({ ...OPTS, fetchFn, maxUnreachable: 3 })).rejects.toThrow(/unreachable/i);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('timeout rejects with a message naming the session id', async () => {
    // nowFn advancing past timeoutMs; pending-status responses; expect /123e4567/ in message
  });
});
```

**Step 2: Run — FAIL. Step 3: Implement `cli/src/onboard/wait.ts`:**

```typescript
/**
 * Poll until the SDK phones home (app_reporting) for this session.
 * Purity rule: never touches pending state — the controller owns state, and on
 * timeout the pending record must survive so a re-run resumes the wait.
 */
import { pollSessionOnce, type PollResult } from '../agent-protocol.js';

export interface WaitOptions {
  apiUrl: string;
  sessionId: string;
  pollToken: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxUnreachable?: number;
  nowFn?: () => number;
}

const WAITING = new Set(['pending', 'provisioned', 'key_ok']);

export async function waitForAppReporting(options: WaitOptions): Promise<PollResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.nowFn ?? Date.now;
  const interval = options.pollIntervalMs ?? 3_000;
  const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
  const maxUnreachable = options.maxUnreachable ?? 20;
  let unreachable = 0;

  while (now() < deadline) {
    const result = await pollSessionOnce({
      apiUrl: options.apiUrl, sessionId: options.sessionId,
      pollToken: options.pollToken, fetchFn,
    });

    if (result.status === 'app_reporting' || result.status === 'completed') return result;
    if (result.status === 'failed') {
      throw new Error(`onboarding session failed: ${result.failureReason ?? result.message ?? 'unknown'}`);
    }
    if (result.status === 'expired') {
      throw new Error(`session ${options.sessionId} expired — re-run onboarding to mint a new key`);
    }
    if (result.status === 'not_found') {
      throw new Error(`session ${options.sessionId} was not found — re-run onboarding`);
    }
    if (result.status === 'internal_error' || result.status === 'unknown') {
      throw new Error(`server error while waiting: ${'message' in result ? result.message ?? 'unknown' : 'unknown'}`);
    }
    if (result.status === 'unreachable') {
      unreachable += 1;
      if (unreachable >= maxUnreachable) {
        throw new Error(`API unreachable after ${unreachable} attempts while waiting for session ${options.sessionId}`);
      }
      await sleepFn(Math.min(interval * unreachable, 30_000));   // linear backoff, capped
      continue;
    }
    unreachable = 0;
    if (result.status === 'rate_limited') {
      await sleepFn((result.retryAfterSeconds ?? 60) * 1_000);
      continue;
    }
    if (WAITING.has(result.status)) {
      await sleepFn(interval);
      continue;
    }
  }
  throw new Error(`timed out waiting for your app to report (session ${options.sessionId}). ` +
    'Start your app, then re-run onboarding — it will resume this session.');
}
```

**Step 4: Run — PASS. Step 5: Commit:**

```bash
git add cli/src/onboard/wait.ts cli/src/onboard/__tests__/wait.test.ts
git commit -m "feat(cli): waitForAppReporting on the shared poll seam"
```

---

### Task 9: run log — metadata by default, keyed by local run id

**Files:**
- Create: `cli/src/onboard/runlog.ts`
- Test: `cli/src/onboard/__tests__/runlog.test.ts`

**Step 1: Write the failing tests:**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunLog } from '../runlog.js';

async function dir() { return mkdtemp(join(tmpdir(), 'opslane-runlog-')); }
const MSG = {
  type: 'tool_use', name: 'Read',
  input: { file_path: 'src/main.ts' },
  content: 'const SECRET = "opk_raw_key_123";',
};

describe('createRunLog', () => {
  it('metadata mode records ts/type/name/hash/bytes — never content or args', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r1', mode: 'metadata' });
    await log.record(MSG);
    await log.finish({ outcome: 'ok', turns: 1, toolCalls: 1, durationMs: 5, totalCostUsd: 0.01 });
    const text = await readFile(log.path, 'utf8');
    expect(text).not.toContain('opk_raw_key_123');
    expect(text).not.toContain('src/main.ts');
    const first = JSON.parse(text.split('\n')[0]!);
    expect(first).toMatchObject({ type: 'tool_use', name: 'Read' });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.bytes).toBeGreaterThan(0);
  });

  it('full mode redacts registered secrets even inside content', async () => {
    const d = await dir();
    const log = await createRunLog({
      dir: d, runId: 'r2', mode: 'full', redact: ['opk_raw_key_123'],
    });
    await log.record(MSG);
    const text = await readFile(log.path, 'utf8');
    expect(text).not.toContain('opk_raw_key_123');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('src/main.ts');   // non-secret content IS kept in full mode
  });

  it('full mode redacts sensitive FIELDS regardless of value — poll_token, refresh_token, accessToken, code_verifier', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r2b', mode: 'full' });
    await log.record({ poll_token: 'pval1', refresh_token: 'rval1', accessToken: 'aval1', code_verifier: 'vval1' });
    const text = await readFile(log.path, 'utf8');
    for (const secret of ['pval1', 'rval1', 'aval1', 'vval1']) expect(text).not.toContain(secret);
  });

  it('addSecret registers values discovered after creation — the provisioned key exists only post-provisioning', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r2c', mode: 'full' });
    log.addSecret('opk_minted_later');
    await log.record({ content: 'x opk_minted_later y' });
    expect(await readFile(log.path, 'utf8')).not.toContain('opk_minted_later');
  });

  it('a run that never provisions still logs; setSessionId records the join key later', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r3', mode: 'metadata' });
    expect(log.path).toContain('onboard-r3');
    await log.setSessionId('sess-42');
    expect(await readFile(log.path, 'utf8')).toContain('sess-42');
  });

  it('file mode is 0600', async () => {
    const d = await dir();
    const log = await createRunLog({ dir: d, runId: 'r4', mode: 'metadata' });
    await log.record(MSG);
    expect(((await stat(log.path)).mode & 0o777)).toBe(0o600);
  });

  it('retention keeps the newest N logs and prunes older on create', async () => {
    const d = await dir();
    for (const id of ['a', 'b', 'c']) {
      await writeFile(join(d, `onboard-${id}.jsonl`), '{}\n');
    }
    await createRunLog({ dir: d, runId: 'new', mode: 'metadata', maxLogs: 3 });
    const names = (await readdir(d)).sort();
    expect(names).toHaveLength(3);           // 2 survivors + the new file
    expect(names).toContain('onboard-new.jsonl');
  });
});
```

**Step 2: Run — FAIL. Step 3: Implement `cli/src/onboard/runlog.ts`:**

```typescript
/**
 * Debuggable trail for onboard runs (design R7). Metadata-only by default —
 * hashes and byte counts, never content — so the file is safe to attach to a
 * bug report. Full capture is an explicit opt-in with field redaction.
 * Keyed by a LOCAL run id so runs that die before provisioning still log;
 * setSessionId records the server session id as the join key once known.
 */
import { appendFile, chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface RunLogOptions {
  dir: string;
  runId: string;
  mode: 'metadata' | 'full';
  redact?: string[];        // initial raw secret values to strip in full mode
  maxLogs?: number;         // retention bound, default 20
  maxRecordBytes?: number;  // full-mode truncation, default 64 KiB
  nowFn?: () => number;
}

export interface RunLog {
  path: string;
  record(message: unknown): Promise<void>;
  /** Register a secret value discovered after creation (e.g. the provisioned key). */
  addSecret(secret: string): void;
  setSessionId(sessionId: string): Promise<void>;
  finish(summary: Record<string, unknown>): Promise<void>;
}

// Field-name redaction: substring match on purpose — it must catch poll_token,
// refresh_token, accessToken, code_verifier, api_key, Authorization, etc.
const SENSITIVE_FIELD = /(authorization|api[_-]?key|token|secret|verifier|password|credential)/i;

function redactDeep(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) {
      if (secret) out = out.split(secret).join('[REDACTED]');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_FIELD.test(k) ? '[REDACTED]' : redactDeep(v, secrets);
    }
    return out;
  }
  return value;
}

export async function createRunLog(options: RunLogOptions): Promise<RunLog> {
  const now = options.nowFn ?? Date.now;
  const maxLogs = options.maxLogs ?? 20;
  const maxRecordBytes = options.maxRecordBytes ?? 64 * 1024;
  const secrets = [...(options.redact ?? [])];
  await mkdir(options.dir, { recursive: true });

  // Retention: keep the newest maxLogs-1 existing logs, then this run's file.
  const existing = (await readdir(options.dir)).filter((n) => /^onboard-.*\.jsonl$/.test(n));
  const withTimes = await Promise.all(existing.map(async (name) => ({
    name, mtime: (await stat(join(options.dir, name))).mtimeMs,
  })));
  withTimes.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of withTimes.slice(Math.max(0, maxLogs - 1))) {
    await unlink(join(options.dir, name)).catch(() => undefined);
  }

  // Create the file NOW, not on first append — the log's existence is the
  // point for runs that die before ever recording (and retention counts it).
  const path = join(options.dir, `onboard-${options.runId}.jsonl`);
  await appendFile(path, '', { mode: 0o600 });
  await chmod(path, 0o600);
  async function append(line: Record<string, unknown>): Promise<void> {
    await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  return {
    path,
    addSecret(secret: string): void {
      if (secret) secrets.push(secret);
    },
    async record(message: unknown): Promise<void> {
      const raw = JSON.stringify(message) ?? 'null';
      const record = message as Record<string, unknown> | null;
      if (options.mode === 'metadata') {
        await append({
          ts: now(),
          type: typeof record?.['type'] === 'string' ? record['type'] : 'unknown',
          name: typeof record?.['name'] === 'string' ? record['name'] : undefined,
          hash: createHash('sha256').update(raw).digest('hex'),
          bytes: Buffer.byteLength(raw),
        });
        return;
      }
      const redacted = redactDeep(message, secrets);
      let serialized = JSON.stringify(redacted) ?? 'null';
      if (Buffer.byteLength(serialized) > maxRecordBytes) {
        serialized = JSON.stringify({ truncated: true, bytes: Buffer.byteLength(serialized) });
      }
      await append({ ts: now(), full: JSON.parse(serialized) });
    },
    async setSessionId(sessionId: string): Promise<void> {
      await append({ ts: now(), session_id: sessionId });
    },
    async finish(summary: Record<string, unknown>): Promise<void> {
      await append({ ts: now(), summary });
    },
  };
}
```

**Step 4: Run — PASS, then full suite. Step 5: Commit:**

```bash
git add cli/src/onboard/runlog.ts cli/src/onboard/__tests__/runlog.test.ts
git commit -m "feat(cli): onboard run log — metadata default, local run id, redacted full mode"
```

---

### Task 10: Phase validation checkpoint

**Step 1: Full verification.** Never pipe `go test` into `tail` on its own — the
pipeline would return tail's zero status and mask failures. Use `pipefail` + `tee`
and inspect skips explicitly:

```bash
pnpm --filter @opslane/cli build
pnpm --filter @opslane/cli test
cd packages/ingestion
go build ./...
set -o pipefail
DATABASE_URL='postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable' \
  go test ./... -v 2>&1 | tee /tmp/phase2-go-test.log
echo "go test exit: $?"                          # must print 0
grep -n -- "--- SKIP" /tmp/phase2-go-test.log    # inspect: NO onboard/provision test may appear here
cd ../..
docker compose config --quiet
pnpm -r build && pnpm test
```
Expected: every command exits 0; the SKIP list contains no onboard-related test.

**Step 2: Live smoke — REQUIRED, and it must reach `app_reporting`** (the server
provisioning changed in Task 1; `provisioned`/`key_ok` alone would not prove the
phone-home path still works end-to-end):

1. Rebuild and start the stack: `docker compose up -d --build postgres minio ingestion` (+ `docker compose run --rm migrate`).
2. Log in against the local server (`node cli/dist/index.js login --api-url http://localhost:8082`) — or reuse a seeded account per `scripts/seed-e2e.sql`.
3. Run a throwaway script chaining `ensureLoggedIn → ensureProvisioned` for a test repo; note the printed session id as `$SID`, and write the key with `writeEnvLocal` into `test-fixtures/vue-app`.
4. Start the fixture app (`pnpm dev` in `test-fixtures/vue-app`) and open it in a browser — the SDK phones home on page load.
5. Prove it **by this run's session id** (never project-wide; a stale row can fake a pass):
   ```bash
   docker compose exec postgres psql -U opslane -c \
     "select id, status from agent_sessions where id = '$SID'"
   ```
   Expected: `app_reporting`. Delete the throwaway script after.

**Step 3: Commit anything outstanding, push, open the PR** (per repo flow: user pushes via `! git push`, then `gh pr create`).

---

## Out of scope for this plan

`opslane onboard` command, Ink TUI, in-TUI consented execution, `runConsentedCommand` — all Phase 3 (see the parent plan's Phase 3 amendment). GitHub App install — later milestone. Member-level cloud provisioning — TODOS.md.
