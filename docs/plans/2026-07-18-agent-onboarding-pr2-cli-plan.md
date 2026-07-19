# Agent Onboarding PR 2 — CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the `@opslane/cli` agent-safe against the PR 1 server contract (poll token, machine bodies, failure states), fix the broken codemods to emit the real SDK API, add origin-aware credentials and recovery, publish the formal CLI contract, and ship the first npm release.

**Architecture:** The CLI stays a thin JSON-first Commander app. New pieces: a canonical-origin utility, an origin+repo-keyed credential store (with migration from the old single-object shape), a pending-session store so `--poll` in a fresh process inherits the right server and poll token, and structural codemods with per-aspect idempotency. The blocking `opslane setup` UX is preserved for humans; agents use `--start`/`--poll`.

**Tech Stack:** Node 22, TypeScript strict ESM, Commander 13, vitest (fetchFn injection pattern), pnpm workspace. No new runtime dependencies.

**Context you need (read before starting):**
- Design doc: `docs/plans/2026-07-18-agent-first-onboarding-design.md` (v5) — PR 2 section, decisions 7, 11, 12; dispositions R3-4, R3-6, R3-7, R4-7.
- **The landed PR 1 server contract** (`packages/ingestion/handler/agent_setup.go` — read it, it is authoritative):
  - `POST /api/v1/agent/setup` → 201 `{status:"auth_required", auth_url, poll_id, poll_token, message}`; 200 `{status:"already_configured", repo, message}` (NO org/project IDs); 429 `{status:"rate_limited", retry_after:60}` + `Retry-After` header.
  - `GET /api/v1/agent/poll/{id}` REQUIRES header **`X-Opslane-Poll-Token`**; missing/wrong/unknown → 404 `{status:"not_found"}`; 200 `{status:"pending"}` | `{status:"completed", repo, org_id, project_id, api_key?}` (key absent after the 15-min window, with a `message`) | `{status:"failed", failure_reason, message}`; 410 `{status:"expired"}`; 429 `{status:"rate_limited", retry_after:60}`.
  - Failure reasons: `identity_unverified`, `installation_not_yours`, `repo_not_granted`, `org_exists_needs_invite`, `repo_already_configured`.
  - **The current CLI cannot complete setup against this server** (it never sends the poll token) — this PR is what reconciles them.
- CLI facts: JSON via `cli/src/output.ts` (`jsonOutput` pretty-prints to stdout; `exitWithError` prints `{error}` + exit 1). Tests are vitest with **`fetchFn` dependency injection** (see `cli/src/__tests__/verify.test.ts`), temp dirs via `mkdtemp`, imports use `.js` suffixes. Agent creds: `~/.opslane/agent-credentials.json`, single object `{org_id, project_id, api_key, repo, api_url}`. PKCE tokens: `~/.opslane/credentials.json`, `{accessToken, refreshToken, expiresAt}` (`cli/src/auth.ts`). `setup.ts` currently: blocking poll, no token, `DEFAULT_API_URL = localhost:8082`.
- Codemod facts: they emit `OpslaneSDK.init({apiKey:'<YOUR_API_KEY>', environment:'production'})` — **wrong on three axes**: the real SDK entrypoint is `init` (see `test-fixtures/vue-app/src/main.ts`: `import { init, opslaneVuePlugin } from '@opslane/sdk'`), `environment` is not an SDK option (`packages/sdk/src/config.ts`), and the vue transform's `insertAfter: 'createApp('` splices mid-expression. `cli/src/init.ts:applyPatches` is the only consumer that writes patches.
- Docs tiers (`scripts/docs-map.mjs`): `docs/reference/**` = deterministic tier, NO frontmatter, drift-checked; prose tiers need `covers:`. The new contract doc goes in `docs/reference/` — check `scripts/check-docs-drift.mjs` after adding it and register it the way the other reference docs are.
- Canonical-origin algorithm (fixed by design R3-7): lowercase scheme+host, strip default ports 80/443, no trailing slash, no path. Atomic file writes: temp file + rename, mode 0600.

---

## Task 0: Preflight

**Step 1:** `git status` clean on the feature branch; `pnpm install --frozen-lockfile`.
**Step 2:** Baseline: `pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test` — green before changes.
**Step 3:** Read `packages/ingestion/handler/agent_setup.go` end to end. The response shapes above must match what you see; if they differ, the server is authoritative — adjust this plan's expectations and note it in the commit message.

---

## Task 1: Canonical-origin utility

**Files:** Create `cli/src/origin.ts`, `cli/src/__tests__/origin.test.ts`.

**Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { canonicalOrigin } from '../origin.js';

describe('canonicalOrigin', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalOrigin('HTTPS://API.Opslane.com')).toBe('https://api.opslane.com');
  });
  it('strips default ports but keeps explicit ones', () => {
    expect(canonicalOrigin('https://api.opslane.com:443')).toBe('https://api.opslane.com');
    expect(canonicalOrigin('http://localhost:80')).toBe('http://localhost');
    expect(canonicalOrigin('http://localhost:8082')).toBe('http://localhost:8082');
  });
  it('drops path, query, trailing slash', () => {
    expect(canonicalOrigin('https://api.opslane.com/api/v1/?x=1')).toBe('https://api.opslane.com');
  });
  it('throws on garbage', () => {
    expect(() => canonicalOrigin('not a url')).toThrow();
  });
});
```

**Step 2:** Run `pnpm --filter @opslane/cli test -- origin` → FAIL (module missing).

**Step 3: Implement**

```ts
/**
 * Canonical origin (design R3-7): lowercase scheme + host, default ports
 * stripped, no path/trailing slash. Used as the key prefix for credential
 * and token storage so hosted and self-hosted servers never share state.
 */
export function canonicalOrigin(input: string): string {
  const url = new URL(input);
  return url.origin.toLowerCase(); // URL.origin already strips default ports and path
}
```

(Verify with the tests that `URL.origin` handles the port cases; if `http://localhost:80` keeps the port on your Node version, normalize manually.)

**Step 4:** Test → PASS. **Step 5:** `git add cli/src/origin.ts cli/src/__tests__/origin.test.ts && git commit -m "feat(cli): canonical origin utility"`

---## Task 2: Status-shaped output + hosted default

**Files:** Modify `cli/src/output.ts`, create `cli/src/config.ts`; tests `cli/src/__tests__/output.test.ts`.

**Step 1: Failing test** (append to output.test.ts): `exitWithStatus('expired', {message:'m'}, 1)` prints `{"status":"expired","message":"m"}` and exits 1; `exitWithStatus('pending', {}, 0)` exits 0.

**Step 2: Implement** in `output.ts` (keep `jsonOutput`/`exitWithError` — existing callers stay valid):

```ts
/** Terminal states in the agent contract always carry a "status" field.
 *  Exit code 0 = the state is not an error (pending, auth_required);
 *  1 = terminal failure. Exactly one JSON document per invocation. */
export function exitWithStatus(status: string, data: Record<string, unknown> = {}, code = 1): never {
  jsonOutput({ status, ...data });
  process.exit(code);
}
```

**Step 3:** New `cli/src/config.ts`:

```ts
/** Hosted default (design decision 2). Self-host overrides via OPSLANE_API_URL. */
export const DEFAULT_API_URL = process.env['OPSLANE_API_URL'] ?? 'https://api.opslane.com';
```

Replace the three `'http://localhost:8082'` fallbacks (`setup.ts:5`, `login.ts` DEFAULT_AUTH_CONFIG, `doctor.ts`) with imports of this constant.

**Step 4:** `pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test` → PASS (update any test that asserted the localhost default; keep a test that `OPSLANE_API_URL` overrides — set env in test with `vi.stubEnv`... note the constant is read at import time, so test via a function `defaultApiUrl()` if stubbing fails; prefer the function form if needed).

**Step 5:** Commit: `feat(cli): status-shaped exits + hosted API default`

---

## Task 3: Origin+repo-keyed credential store

**Files:** Modify `cli/src/agent-credentials.ts`; test `cli/src/__tests__/agent-credentials.test.ts`.

**Step 1: Failing tests** — new behavior:
- `saveAgentCredentials(creds)` stores under key `` `${canonicalOrigin(api_url)}|${repo.toLowerCase()}` `` in a map-shaped file `{version: 2, credentials: {"<key>": {...}}}`.
- `loadAgentCredentials({apiUrl, repo})` returns the entry for that origin+repo, or null.
- **Migration:** a v1 file (old single-object shape) is readable — `loadAgentCredentials` for the matching origin+repo returns it, and the next `save` rewrites the file as v2 keeping the old entry.
- **Atomic writes (R3-7):** file is written via temp-file + `rename`, final mode 0600. Test: after save, no `*.tmp` leftovers and `(await stat(file)).mode & 0o777 === 0o600`.
- Repo A's creds never returned for repo B (the F7 bug): save under repo A, load for repo B → null.

**Step 2:** Run → FAIL.

**Step 3: Implement.** Keep `AgentCredentials` shape per entry. New file layout:

```ts
interface CredentialsFileV2 { version: 2; credentials: Record<string, AgentCredentials>; }
export function credentialKey(apiUrl: string, repo: string): string {
  return `${canonicalOrigin(apiUrl)}|${repo.toLowerCase()}`;
}
```

`load`: parse; if the object has the five v1 string fields → treat as `{[credentialKey(v1.api_url, v1.repo)]: v1}`. `save`: read-migrate-merge, write `JSON.stringify(fileV2)` to `${path}.tmp` with mode 0600, `rename` over the target. Update the signatures of the three consumers (`verify.ts`, `status.ts`, `errors.ts`) — they must now resolve creds by the current repo (via `detectRepoFromGit`) and optional `--api-url`; when exactly one entry exists in the store, fall back to it (keeps `opslane verify` working right after setup without flags), otherwise require the repo match and error with `exitWithStatus('no_credentials', {message: 'Run "opslane setup" in this repo first.'})`.

**Step 4:** Tests → PASS (update verify/status/errors tests for the new resolution rules).
**Step 5:** Commit: `feat(cli): origin+repo-keyed credentials with v1 migration and atomic writes`

---

## Task 4: Pending-session store

**Files:** Create `cli/src/pending.ts`, `cli/src/__tests__/pending.test.ts`.

**Step 1: Failing tests:** `savePendingSession({poll_id, poll_token, api_url, repo, created_at})` writes `~/.opslane/pending/<poll_id>.json` (0600, atomic); `loadPendingSession(pollId)` round-trips; `deletePendingSession(pollId)` removes; `loadPendingSession` on garbage/missing → null. All take an optional base-dir param for tests (mirror `agent-credentials.ts`'s injectable path pattern).

**Step 2–4:** Implement (~40 lines, same atomic-write helper as Task 3 — extract `writeFileAtomic(path, data)` into a small `cli/src/fsutil.ts` shared by both), tests PASS.

**Step 5:** Commit: `feat(cli): pending-session store so --poll inherits origin and poll token`

---

## Task 5: `setup` rework — `--start` / `--poll` / poll token / status mapping / `--force`

**Files:** Modify `cli/src/setup.ts`, `cli/src/index.ts`; tests `cli/src/__tests__/setup.test.ts`.

**Step 1: Failing tests** (fetchFn injection; temp dirs for cred/pending paths):

1. `--start`: POSTs setup, prints the server body verbatim (single JSON doc), writes the pending file (including `poll_token`), exits 0, does NOT poll.
2. `--poll <id>`: loads the pending file, sends `X-Opslane-Poll-Token` header on every poll request, uses the pending file's `api_url` even when `OPSLANE_API_URL` differs (R4 origin persistence).
3. Poll status mapping — each server body produces the documented CLI output and exit code:
   - `{status:"pending"}` within `--timeout` → keeps polling; on timeout exit 0 with `{status:"pending", poll_id, message}` (pending is NOT an error).
   - 404 `{status:"not_found"}` → `exitWithStatus('not_found', ..., 1)`.
   - 410 `{status:"expired"}` → `exitWithStatus('expired', {remediation:'re-run setup'}, 1)` + pending file deleted.
   - 429 → waits `retry_after` (from body or `Retry-After` header) before the next attempt (test with fake timers).
   - `{status:"failed", failure_reason}` → `exitWithStatus('failed', {failure_reason, message}, 1)` + pending file deleted.
   - `{status:"completed", api_key...}` → credentials saved under origin+repo key, pending file deleted, prints completed body, exit 0.
   - Network error → retries until timeout, then `exitWithStatus('api_unreachable', {api_url}, 1)`. JSON parse failure → same (guarded — R3-7).
4. Default `setup` (no flags): behaves as `--start` + internal poll loop (blocking, current human UX) — assert it passes the token on polls.
5. Existing valid creds for THIS origin+repo → validate via `GET /api/v1/projects/{id}/event-count` with `X-API-Key`: 2xx → `{status:"already_configured"}` exit 0; 401/403 → `exitWithStatus('credentials_invalid', {remediation:'run "opslane setup --force" (new repo) or "opslane login" + "opslane setup --relink" (existing project)'})`.
6. `--force`: deletes this origin+repo's credential entry and pending files, then re-runs setup; if the server answers `already_configured`, prints it with the relink remediation and exits 1 (the server refuses new keys — decision 11).

**Step 2:** Run → FAIL. **Step 3: Implement.** Key skeleton:

```ts
export interface SetupOptions {
  start?: boolean; poll?: string; timeout?: number; force?: boolean;
  apiUrl?: string; repoUrl?: string; agentName?: string;
  credentialsPath?: string; pendingDir?: string; fetchFn?: typeof fetch; // test seams
}
```

- `--start` and `--poll` are mutually exclusive → `exitWithStatus('usage_error', {message}, 1)`.
- `pollOnce(apiUrl, pollId, pollToken, fetchFn)` returns a discriminated result; `pollLoop` owns timing (default timeout 15 min for the blocking mode, `--timeout <seconds>` default 60 for `--poll` mode) and the 429 backoff.
- Register in `index.ts`: `setup` gains `--start`, `--timeout <seconds>`, `--force` (keep `--poll <id>`, `--api-url`, `--repo-url`, `--agent-name`).

**Step 4:** `pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test` → PASS.
**Step 5:** Commit: `feat(cli): non-blocking setup, poll-token contract, status mapping, --force`

---

## Task 6: Recovery — origin-keyed PKCE tokens + `setup --relink`

**Files:** Modify `cli/src/auth.ts`, `cli/src/setup.ts` (or new `cli/src/relink.ts`), `cli/src/index.ts`; tests.

**Step 1: Failing tests:**
- `auth.ts`: tokens stored per canonical origin — file becomes `{version:2, tokens: {"<origin>": TokenPair}}` with v1 migration on read (same pattern as Task 3). `loadTokens(origin)` / `persistTokens(origin, pair)`.
- `--relink` (fetchFn injected): with valid PKCE tokens for the target origin, it (a) finds the project by repo via `GET /api/v1/projects` (Bearer auth; match `github_repo` case-insensitively), (b) lists `GET /api/v1/projects/{id}/environments`, picks `production` (else the first), (c) `POST /api/v1/environments/{envID}/api-keys`, (d) **saves the new key only after success** — the old credential entry must still be present if any step fails (R3 "never strand keyless"), (e) prints `{status:"relinked", project_id, api_key}`.
- No/expired tokens → `exitWithStatus('login_required', {message:'Run "opslane login" first (requires a browser).'})`.

**Step 2:** FAIL. **Step 3: Implement.** Before coding the endpoint calls, read `packages/ingestion/handler/read_api.go` (`ListProjects`, `CreateAPIKeyEndpoint`) for the exact response field names — do not guess; the key mint response contains the raw key exactly once. `login.ts` keeps its human chalk output (documented exemption — R3-4) but persists tokens under the canonical origin of its `apiUrl`.

**Step 4:** PASS. **Step 5:** Commit: `feat(cli): origin-keyed login tokens + authenticated setup --relink recovery`

---

## Task 7: Codemod rework — real SDK API, env vars, per-aspect idempotency

**Files:** Modify `cli/src/codemods/{types,registry,react-vite,vue-vite,nextjs,nuxt}.ts`, `cli/src/snippet.ts`, `cli/src/detect.ts` (no change expected), `cli/src/init.ts` (applyPatches stays the writer); tests `cli/src/__tests__/codemods.test.ts`, `snippet.test.ts`.

**Step 1: Failing tests** (table-driven per framework; fixtures as inline strings + temp dirs):

For each framework assert the generated patches:
1. Use the **real SDK API**: `import { init } from '@opslane/sdk'` (vue also `opslaneVuePlugin`), `init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY })` for vite frameworks, `process.env.NEXT_PUBLIC_OPSLANE_API_KEY` for Next, Nuxt runtime config for nuxt. **No `environment` option, no `OpslaneSDK`, never a literal key in source.**
2. Per-aspect idempotency (R3-6): a file that already imports another symbol from `@opslane/sdk` still gets the `init(...)` call; a file that already calls `init(` from the sdk import gets nothing added twice; running `generate` on already-patched output yields zero patches. Aspects detected independently: import / init call / (vue) plugin registration.
3. Structural anchors: vue `app.use(opslaneVuePlugin)` inserts after the complete `createApp(...)` **statement** — test a multiline `createApp(\n  App\n)` fixture; react/vue init inserts after the last import line, not mid-expression.
4. Next app router: a `create` patch for `app/opslane-client.tsx` (`'use client'` component calling `init` in a module-level guard) plus a `modify` importing it in `app/layout.tsx` — never `init()` directly in the Server Component. Pages router: `_app` with env-var key.
5. `snippet` output gains: `env: { var: 'VITE_OPSLANE_API_KEY' | 'NEXT_PUBLIC_OPSLANE_API_KEY', value: <key from creds>, file: '.env.local', gitignore: true }`, `endpoint: <origin>` **only when** the credential origin ≠ `https://api.opslane.com` (then the emitted `init` includes `endpoint`), and `install` chosen by lockfile: `pnpm-lock.yaml`→`pnpm add @opslane/sdk`, `yarn.lock`→`yarn add`, `bun.lockb`→`bun add`, else `npm install` (F24; detect in the project root).

**Step 2:** FAIL. **Step 3: Implement.** Extend `FilePatch` minimally if needed (e.g. `insertAfterLineMatching?: RegExp-source string` handled by `applyPatches`) — keep the patch format JSON-serializable since `snippet` emits it for agents to apply. Keep each codemod a pure `generate(projectRoot)` that reads the target files to decide aspects.

**Step 4:** PASS, including old codemod tests updated. **Step 5:** Commit: `fix(cli): codemods emit real SDK API with env-var keys and per-aspect idempotency`

---

## Task 8: `doctor` agent-aware

**Files:** Modify `cli/src/doctor.ts`; test `cli/src/__tests__/doctor.test.ts`.

Auth check passes on agent credentials for the current origin+repo OR PKCE tokens; `.opslane.json` missing → info, not failure; API-key validity checked via `event-count` with `X-API-Key`. `--fix` stays unimplemented. TDD as above; commit `feat(cli): doctor understands agent credentials`.

---

## Task 9: Fixtures + build-level codemod checks + browser event test

**Files:** Create `test-fixtures/codemod-react/`, `codemod-vue/`, `codemod-next/`, `codemod-nuxt/` (minimal CLEAN apps — the existing `react-app`/`vue-app` fixtures already have the SDK wired and are e2e fixtures, not codemod targets). Each: `package.json` (workspace member, `@opslane/sdk: workspace:*`, a `check` script running the framework's typecheck — `tsc --noEmit` / `vue-tsc --noEmit` / `next lint`-free `tsc`), the framework's minimal entry files, AGPL license field matching the other fixtures.

**Steps:**
1. Add fixtures; `pnpm install` (updates lockfile).
2. Vitest suite `cli/src/__tests__/codemod-apply.test.ts`: for each fixture — copy fixture `src/` (and config) to a temp dir **inside the fixture** (`.codemod-check/`, gitignored), run `generate` + `applyPatches`, then `execSync('pnpm run check')` in the fixture with the patched copy wired via the check script's `-p` project path. Gate the suite behind `process.env['CODEMOD_BUILD']` (skip otherwise) so unit runs stay fast; CI and the Task 11 gate run it with `CODEMOD_BUILD=1`.
3. Browser event-capture test (design R7): extend the existing e2e suite — read `test-e2e/AGENTS.md` and its existing browser test first, then add one case: patched `codemod-react` fixture served by vite, a scripted error, assert one `POST /api/v1/events` arrives at a stub server. Follow whatever browser harness test-e2e already uses; do not introduce a new one.
4. Commit: `test(cli): clean codemod fixtures with apply+typecheck and browser event capture`

---

## Task 10: Formal CLI contract doc + subprocess tests

**Files:** Create `docs/reference/cli-agent-contract.md`; create `cli/src/__tests__/contract.subprocess.test.ts`.

**Step 1:** Write the doc (reference tier: no frontmatter; opening paragraph names the source files like the other reference docs). One table per command (`setup`, `snippet`, `verify`, `status`) with: every `status` value, the HTTP condition that causes it, the JSON schema, the exit code, the retry rule. Document the invariants: exactly one JSON document on stdout; diagnostics on stderr; `pending`/`auth_required`/`already_configured` exit 0; `login` and `init` are interactive human commands exempt from the contract (R3-4); poll secret header `X-Opslane-Poll-Token`; canonical-origin algorithm; atomic 0600 writes. Run `pnpm test` at root — if `check-docs-drift.mjs` flags the new file, register it the way `docs-map.mjs` handles the other reference docs.

**Step 2:** Subprocess tests (R9): build the CLI (`pnpm --filter @opslane/cli build`), then spawn `node cli/dist/index.js <cmd>` against a local `http.createServer` stub implementing the PR 1 contract; assert stdout parses as exactly one JSON document, assert exit codes for: completed, failed, expired, not_found, usage conflict (`--start --poll`).

**Step 3:** Commit: `docs(cli): formal agent contract + compiled-CLI subprocess tests`

---

## Task 11: Publish readiness + SDK README fix + full gate

**Files:** Modify `cli/package.json`, `packages/sdk/README.md`, create `.changeset/agent-cli-first-release.md`.

1. `cli/package.json`: add `"publishConfig": { "access": "public" }`.
2. Changeset: `'@opslane/cli': minor` (0.0.1 → 0.1.0) with a summary of the agent contract. (`@opslane/sdk` unchanged unless its README edit warrants a patch — include `'@opslane/sdk': patch` for the README fix.)
3. Fix `packages/sdk/README.md` config table row: `replay.enabled` default is `true` in code (`packages/sdk/src/config.ts`), the table says `false`.
4. Full gate: `pnpm -r build && pnpm test` at root, `pnpm --filter @opslane/cli test` with `CODEMOD_BUILD=1`, plus a manual smoke against local compose: `OPSLANE_API_URL=http://localhost:8082 node cli/dist/index.js setup --start` then `setup --poll <id>` (server from PR 1 must accept the token).
5. Commit: `chore(cli): first publish prep (publishConfig, changeset) + sdk README replay default`
6. STOP — no push (repo hook). Remind the user: publication only completes when the Version Packages PR merges on main; the PR 7 activation gate checks `npm view @opslane/cli version`, not this merge.

## Out of scope

Quickstart content (PR 3 — planned after this lands, since it quotes this CLI's verbatim output), dashboard cards (PR 4), funnel (PR 5), smoke (PR 6), activation (PR 7).
