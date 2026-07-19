# Agent Onboarding PR 2 — CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **Status:** Tasks 1–2 DONE (branch `abhishekray07/agent-cli`: `origin.ts`, `config.ts`, `exitWithStatus`). Tasks 3–11 pending. **Revised after round-5 review (8 findings, 3 P0) — see "Round-5 amendments" below; the affected task bodies already fold the fixes in.**

## Round-5 amendments (binding — read before Tasks 3–11)

Contract-level decisions settled here so the tasks below are consistent:

- **R5-1 (`--force` never strands a key):** `--force` bypasses *local credential validation* only. It must NOT delete the existing credential entry up front. It re-runs setup; the old entry is overwritten only after a completed session saves a replacement key. If the server answers `already_configured`, the old entry stays intact and the CLI prints the relink remediation (exit 1).
- **R5-2 (`completed` without a key is a terminal state):** the server returns `{status:"completed"}` with **no `api_key`** after the 15-min window (`agent_setup.go:192`). The CLI maps this to `exitWithStatus('key_unavailable', {remediation: 'run "opslane login" then "opslane setup --relink"'}, 1)`, deletes the pending session, and does NOT tell the user to re-run setup (the project now exists, so setup returns `already_configured`). Note: the server's own window-closed `message` still says "re-run setup" — that server copy is misleading and is filed as a PR 1 follow-up; the CLI ignores that message and uses its own remediation.
- **R5-3 (legacy PKCE tokens are never reused across origins):** the old `~/.opslane/credentials.json` single-object token file has **no origin** (`auth.ts`). Do NOT associate it with an arbitrary `--api-url` — that could send a bearer token to the wrong server. Policy: legacy tokens are ignored for `--relink`; recovery requires a fresh `opslane login` for the requested origin, which then writes the v2 origin-keyed shape. A one-time note is printed if a legacy file is found.
- **R5-4 (one-JSON invariant vs blocking setup):** the invariant "exactly one JSON document on **stdout**" holds by routing the interim `auth_required` document to **stderr** in blocking mode; only the terminal result (`completed` / `key_unavailable` / `failed` / …) goes to stdout. `--start` (non-blocking) prints `auth_required` to stdout as its single terminal document. `already_configured` is **exit 0** everywhere (it is not a failure) — Task 5 and Task 10 both use exit 0; the earlier exit-1-under-`--force` note is superseded by R5-1 (force doesn't reach an exit-1 `already_configured`; it prints remediation and exits 1 only when it cannot proceed, with `status:"already_configured"` carrying the remediation — the exit code for that specific "force but server refuses" case is 1, distinct from the plain informational `already_configured` exit 0).
- **R5-5 (credential resolution is strict):** the single-entry fallback is allowed **only** when repo detection fails *and* the canonical origin matches the single entry's origin. When a repo is detected, an exact origin+repo match is required; no cross-repo fallback. A `--repo <owner/repo>` flag selects explicitly. **All consumers change together:** `setup`, `snippet`, `verify`, `status`, `errors`, **and** `doctor` (six, not three).
- **R5-6 (kill every wrong-key path, not just codemods):** Task 7 also fixes `cli/src/ai-fallback.ts` (emits the nonexistent `OpslaneSDK` API) and `cli/src/init.ts` (substitutes a literal API key into generated source at `:124-130` and into `.opslane.json` at `:181-182`). Remove plaintext-key persistence entirely — keys live only in the git-ignored env file. Next App Router: the layout must **render** the `'use client'` component, not merely import it, or the browser never executes it.
- **R5-7 (relink cross-org behavior is defined):** `GET /api/v1/projects` returns only the token's active-org projects (`read_api.go:124`, `OrgIDFromCtx`). If the repo's project is not in the active org, `--relink` returns `exitWithStatus('project_not_in_active_org', {remediation: 'switch org in the dashboard, or pass --org <id>', ...}, 1)` — not a generic "not found". (A `--org` switch is optional polish; the specific remediation is required.)
- **R5-8 (the contract doc must be drift-proof):** `scripts/check-docs-drift.mjs` has no CLI-contract check — dropping a file in `docs/reference/` is not automatically deterministic. Task 10 emits a **machine-readable status table** (a generated JSON or a fenced table the CLI itself can print via a hidden `--contract` command) and a drift test that compares the doc's table against the CLI's actual status enum, failing on divergence.

Smaller corrections folded into the relevant tasks: export `applyPatches` (Task 7/9); subprocess tests run with a temp `HOME` and `cwd` (Task 10); credential map read/merge/write uses a unique temp filename (`${path}.<pid>.<rand>.tmp`) and tolerates concurrent writers (Task 3); poll IDs are validated (UUID) before building filenames and `--timeout` is parsed as a finite positive number (Tasks 4/5); add explicit `POST /agent/setup` tests for 429, malformed JSON, `internal_error`, and unrecognized bodies (Task 5).

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

## Task 1: Canonical-origin utility — ✅ DONE

Landed on `abhishekray07/agent-cli` (`cli/src/origin.ts` uses `new URL(input).origin.toLowerCase()`; `URL.origin` already strips default ports). Tests green.

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

---## Task 2: Status-shaped output + hosted default — ✅ DONE

Landed: `exitWithStatus(status, data, code)` in `output.ts`; `defaultApiUrl()` (function form, env read at call time) in `config.ts`, wired into `setup.ts`/`login.ts`/`doctor.ts`; `config.test.ts` locks the default + override. Tests green (92 total).

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
- **Concurrency-safe atomic writes (R3-7 + R5 smaller correction):** written via a **unique** temp file `${path}.${pid}.${rand}.tmp` + `rename`, final mode 0600. A fixed `${path}.tmp` is atomic but two writers clobber each other's temp file — use unique names. Test: after save, no leftover temp files and `(await stat(file)).mode & 0o777 === 0o600`.
- Repo A's creds never returned for repo B (the F7 bug): save under repo A, load for repo B → null.
- **Strict resolution (R5-5):** `resolveCredentials({repo?, apiUrl?})` returns the exact origin+repo entry when a repo is known; the single-entry fallback fires **only** when repo detection failed AND the lone entry's canonical origin matches the requested `apiUrl`. Test all three: exact match hit; repo-known-but-absent → null (no fallback); repo-detection-failed + one entry + origin match → that entry; repo-detection-failed + origin mismatch → null.

**Step 2:** Run → FAIL.

**Step 3: Implement.** Keep `AgentCredentials` shape per entry. New file layout:

```ts
interface CredentialsFileV2 { version: 2; credentials: Record<string, AgentCredentials>; }
export function credentialKey(apiUrl: string, repo: string): string {
  return `${canonicalOrigin(apiUrl)}|${repo.toLowerCase()}`;
}
```

`load`: parse; if the object has the five v1 string fields → treat as `{[credentialKey(v1.api_url, v1.repo)]: v1}`. `save`: read-migrate-merge, write to the unique temp file then `rename`. Expose `resolveCredentials({repo?, apiUrl?})` implementing R5-5. **Update ALL SIX consumers together (R5-5):** `setup.ts`, `snippet.ts`, `verify.ts`, `status.ts`, `errors.ts`, `doctor.ts` — each resolves via `resolveCredentials` (repo from `detectRepoFromGit`, origin from `--api-url`/`defaultApiUrl()`, optional `--repo <owner/repo>` override). No match → `exitWithStatus('no_credentials', {message: 'Run "opslane setup" in this repo first.'}, 1)`.

**Step 4:** Tests → PASS (update verify/status/errors tests for the new resolution rules).
**Step 5:** Commit: `feat(cli): origin+repo-keyed credentials with v1 migration and atomic writes`

---

## Task 4: Pending-session store

**Files:** Create `cli/src/pending.ts`, `cli/src/__tests__/pending.test.ts`.

**Step 1: Failing tests:** `savePendingSession({poll_id, poll_token, api_url, repo, created_at})` writes `~/.opslane/pending/<poll_id>.json` (0600, atomic); `loadPendingSession(pollId)` round-trips; `deletePendingSession(pollId)` removes; `loadPendingSession` on garbage/missing → null. **Poll IDs are validated as UUIDs before being used in a filename** (R5 smaller correction) — `savePendingSession`/`loadPendingSession` reject a non-UUID `poll_id` (prevents path traversal via a hostile `poll_id`); test with `../evil`. All take an optional base-dir param for tests (mirror `agent-credentials.ts`'s injectable path pattern).

**Step 2–4:** Implement (~40 lines, same atomic-write helper as Task 3 — extract `writeFileAtomic(path, data)` into a small `cli/src/fsutil.ts` shared by both), tests PASS.

**Step 5:** Commit: `feat(cli): pending-session store so --poll inherits origin and poll token`

---

## Task 5: `setup` rework — `--start` / `--poll` / poll token / status mapping / `--force`

**Files:** Modify `cli/src/setup.ts`, `cli/src/index.ts`; tests `cli/src/__tests__/setup.test.ts`.

**Step 1: Failing tests** (fetchFn injection; temp dirs for cred/pending paths):

1. `--start`: POSTs setup, prints the server body verbatim to **stdout** (single JSON doc), writes the pending file (including `poll_token`), exits 0, does NOT poll.
2. `--poll <id>`: loads the pending file, sends `X-Opslane-Poll-Token` header on every poll request, uses the pending file's `api_url` even when `OPSLANE_API_URL` differs (R4 origin persistence). `--timeout` is parsed as a **finite positive number** (R5 smaller correction); a non-numeric/≤0 value → `exitWithStatus('usage_error', ..., 1)`.
3. Poll status mapping — each server body produces the documented CLI output and exit code:
   - `{status:"pending"}` within `--timeout` → keeps polling; on timeout exit 0 with `{status:"pending", poll_id, message}` (pending is NOT an error; pending file kept so a later `--poll` resumes).
   - 404 `{status:"not_found"}` → `exitWithStatus('not_found', ..., 1)` + pending file deleted.
   - 410 `{status:"expired"}` → `exitWithStatus('expired', {remediation:'re-run setup'}, 1)` + pending file deleted.
   - 429 → waits `retry_after` (from body or `Retry-After` header) before the next attempt (test with fake timers).
   - `{status:"failed", failure_reason}` → `exitWithStatus('failed', {failure_reason, message}, 1)` + pending file deleted.
   - `{status:"completed"}` **with** `api_key` → credentials saved under origin+repo key, pending file deleted, prints completed body to stdout, exit 0.
   - **`{status:"completed"}` WITHOUT `api_key` (R5-2):** the 15-min window closed. → `exitWithStatus('key_unavailable', {project_id, remediation:'run "opslane login" then "opslane setup --relink"'}, 1)` + pending file deleted. Do NOT save credentials, do NOT tell the user to re-run setup (the project now exists). Explicit test for this body.
   - Network error → retries until timeout, then `exitWithStatus('api_unreachable', {api_url}, 1)`. JSON parse failure → `exitWithStatus('internal_error', {message:'unparseable server response'}, 1)` (guarded — R3-7). Unrecognized `{status}` value → `exitWithStatus('internal_error', {message:'unrecognized server status', server_status}, 1)`.
4. Default `setup` (no flags): `--start` semantics + internal poll loop (blocking, human UX). **One-JSON invariant (R5-4):** the interim `auth_required` document goes to **stderr**; only the terminal result goes to stdout. Assert: exactly one JSON doc on stdout, the auth URL present on stderr, token passed on polls.
5. Existing valid creds for THIS origin+repo → validate via `GET /api/v1/projects/{id}/event-count` with `X-API-Key`: 2xx → `exitWithStatus('already_configured', {...}, 0)` (exit 0); 401/403 → `exitWithStatus('credentials_invalid', {remediation:'run "opslane setup --force" (new repo) or "opslane login" + "opslane setup --relink" (existing project)'}, 1)`.
6. **`--force` (R5-1 — never strands a key):** skips local credential validation and re-runs setup **without deleting the existing entry first**. On `{status:"completed"}` with a key → the new key overwrites the old entry (save-then-done). If the server answers `already_configured` → the old entry is left intact and the CLI prints `exitWithStatus('already_configured', {remediation:'run "opslane login" then "opslane setup --relink"'}, 1)` (the server refuses new keys — decision 11). Test both branches assert the old entry survives the refuse branch.
7. **POST `/agent/setup` error bodies (R5 smaller correction):** explicit tests for 429 (`rate_limited`, honors `Retry-After`), malformed JSON body, `{status:"internal_error"}`, and an unrecognized body shape — each maps to a defined `exitWithStatus`, never an unhandled throw.

**Step 2:** Run → FAIL. **Step 3: Implement.** Key skeleton:

```ts
export interface SetupOptions {
  start?: boolean; poll?: string; timeout?: number; force?: boolean; repo?: string;
  apiUrl?: string; repoUrl?: string; agentName?: string;
  credentialsPath?: string; pendingDir?: string; fetchFn?: typeof fetch; // test seams
}
```

- `--start` and `--poll` are mutually exclusive → `exitWithStatus('usage_error', {message}, 1)`.
- `pollOnce(apiUrl, pollId, pollToken, fetchFn)` returns a discriminated result; `pollLoop` owns timing (default timeout 15 min blocking, `--timeout <seconds>` default 60 for `--poll`) and the 429 backoff. Interim `auth_required` output uses a `writeStderr` helper; terminal output uses `jsonOutput`/`exitWithStatus` (stdout).
- Register in `index.ts`: `setup` gains `--start`, `--timeout <seconds>`, `--force`, `--repo <owner/repo>` (keep `--poll <id>`, `--api-url`, `--repo-url`, `--agent-name`).

**Step 4:** `pnpm --filter @opslane/cli build && pnpm --filter @opslane/cli test` → PASS.
**Step 5:** Commit: `feat(cli): non-blocking setup, poll-token contract, status mapping, --force`

---

## Task 6: Recovery — origin-keyed PKCE tokens + `setup --relink`

**Files:** Modify `cli/src/auth.ts`, `cli/src/setup.ts` (or new `cli/src/relink.ts`), `cli/src/index.ts`; tests.

**Step 1: Failing tests:**
- `auth.ts`: tokens stored per canonical origin — file becomes `{version:2, tokens: {"<origin>": TokenPair}}`. **v1 legacy handling (R5-3):** a v1 single-object token file has NO origin, so it is NOT migrated into an origin bucket and is NEVER used for `--relink` against an arbitrary origin (that could leak a bearer token to the wrong server). On read, a legacy file yields no token for any origin lookup; `loadTokens(origin)` returns null for it. A one-time stderr note tells the user to `opslane login` again (which writes v2). Test: a v1 file → `loadTokens('https://api.opslane.com')` is null; after `persistTokens(origin, pair)` the file is v2 and the entry is retrievable.
- `--relink` (fetchFn injected): with valid v2 PKCE tokens for the target origin, it (a) finds the project by repo via `GET /api/v1/projects` (Bearer auth; match `github_repo` case-insensitively), (b) lists `GET /api/v1/projects/{id}/environments`, picks `production` (else the first), (c) `POST /api/v1/environments/{envID}/api-keys`, (d) **saves the new key only after success** — the old credential entry must still be present if any step fails (R3 "never strand keyless"), (e) prints `{status:"relinked", project_id, api_key}`.
- **Cross-org (R5-7):** `GET /api/v1/projects` returns only the token's ACTIVE-org projects (`read_api.go:124`, `OrgIDFromCtx`). When the repo's project is not in that list → `exitWithStatus('project_not_in_active_org', {repo, remediation:'switch to the owning org in the dashboard, or pass --org <id>'}, 1)` — a specific status, NOT a generic "project not found". (Honoring `--org` by switching org is optional polish; the specific remediation is required.)
- No/expired tokens (or legacy-only file) → `exitWithStatus('login_required', {message:'Run "opslane login" first (requires a browser).'}, 1)`.

**Step 2:** FAIL. **Step 3: Implement.** Before coding the endpoint calls, read `packages/ingestion/handler/read_api.go` (`ListProjects`, `CreateAPIKeyEndpoint`) for the exact response field names — do not guess; the key mint response contains the raw key exactly once. `login.ts` keeps its human chalk output (documented exemption — R3-4) but persists tokens under the canonical origin of its `apiUrl`.

**Step 4:** PASS. **Step 5:** Commit: `feat(cli): origin-keyed login tokens + authenticated setup --relink recovery`

---

## Task 7: Codemod rework — real SDK API, env vars, per-aspect idempotency

**Files:** Modify `cli/src/codemods/{types,registry,react-vite,vue-vite,nextjs,nuxt}.ts`, `cli/src/snippet.ts`, `cli/src/ai-fallback.ts` (R5-6), `cli/src/init.ts` (export `applyPatches`; remove literal-key substitution — R5-6), `cli/src/detect.ts` (no change expected); tests `cli/src/__tests__/codemods.test.ts`, `snippet.test.ts`, `init.test.ts`.

**Step 1: Failing tests** (table-driven per framework; fixtures as inline strings + temp dirs):

For each framework assert the generated patches:
1. Use the **real SDK API**: `import { init } from '@opslane/sdk'` (vue also `opslaneVuePlugin`), `init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY })` for vite frameworks, `process.env.NEXT_PUBLIC_OPSLANE_API_KEY` for Next, Nuxt runtime config for nuxt. **No `environment` option, no `OpslaneSDK`, never a literal key in source.**
2. Per-aspect idempotency (R3-6): a file that already imports another symbol from `@opslane/sdk` still gets the `init(...)` call; a file that already calls `init(` from the sdk import gets nothing added twice; running `generate` on already-patched output yields zero patches. Aspects detected independently: import / init call / (vue) plugin registration.
3. Structural anchors: vue `app.use(opslaneVuePlugin)` inserts after the complete `createApp(...)` **statement** — test a multiline `createApp(\n  App\n)` fixture; react/vue init inserts after the last import line, not mid-expression.
4. **Next App Router (R5-6):** a `create` patch for `app/opslane-client.tsx` (`'use client'` component calling `init` in a module-level guard) AND a `modify` on `app/layout.tsx` that both imports **and renders** `<OpslaneClient />` inside the body — importing without rendering means the browser never loads it. Test asserts the render, not just the import. Pages router: `_app` with env-var key.
5. `snippet` output gains: `env: { var: 'VITE_OPSLANE_API_KEY' | 'NEXT_PUBLIC_OPSLANE_API_KEY', value: <key from creds>, file: '.env.local', gitignore: true }`, `endpoint: <origin>` **only when** the credential origin ≠ `https://api.opslane.com` (then the emitted `init` includes `endpoint`), and `install` chosen by lockfile: `pnpm-lock.yaml`→`pnpm add @opslane/sdk`, `yarn.lock`→`yarn add`, `bun.lockb`→`bun add`, else `npm install` (F24; detect in the project root).
6. **`ai-fallback.ts` (R5-6):** its unknown-framework output must use `import { init } from '@opslane/sdk'` + `init({...})` with the env-var key — NOT the current `OpslaneSDK.init` / `OpslaneSDK.captureException`. Test the emitted content.
7. **`init.ts` stops persisting plaintext keys (R5-6):** delete the `<YOUR_API_KEY>` → literal-key substitution (`init.ts:124-130`) and the `.opslane.json` `apiKey` write (`init.ts:181-182`). Keys live only in the git-ignored env file the codemods reference. `init.test.ts` asserts no key ever lands in patched source or `.opslane.json`.

**Step 2:** FAIL. **Step 3: Implement.** **Export `applyPatches`** from `init.ts` (currently a private `async function` at `init.ts:48`) so Task 9's build test can import it. Extend `FilePatch` minimally if needed (e.g. `insertAfterLineMatching?: RegExp-source string` handled by `applyPatches`) — keep the patch format JSON-serializable since `snippet` emits it for agents to apply. Keep each codemod a pure `generate(projectRoot)` that reads the target files to decide aspects.

**Step 4:** PASS, including old codemod tests updated. **Step 5:** Commit: `fix(cli): codemods emit real SDK API with env-var keys and per-aspect idempotency`

---

## Task 8: `doctor` agent-aware

**Files:** Modify `cli/src/doctor.ts`; test `cli/src/__tests__/doctor.test.ts`.

Auth check passes on agent credentials for the current origin+repo (via `resolveCredentials`, R5-5 — doctor is one of the six consumers) OR v2 PKCE tokens for the origin; `.opslane.json` missing → info, not failure; API-key validity checked via `event-count` with `X-API-Key`. `--fix` stays unimplemented. TDD as above; commit `feat(cli): doctor understands agent credentials`.

---

## Task 9: Fixtures + build-level codemod checks + browser event test

**Files:** Create `test-fixtures/codemod-react/`, `codemod-vue/`, `codemod-next/`, `codemod-nuxt/` (minimal CLEAN apps — the existing `react-app`/`vue-app` fixtures already have the SDK wired and are e2e fixtures, not codemod targets). Each: `package.json` (workspace member, `@opslane/sdk: workspace:*`, a `check` script running the framework's typecheck — `tsc --noEmit` / `vue-tsc --noEmit` / `next lint`-free `tsc`), the framework's minimal entry files, AGPL license field matching the other fixtures.

**Steps:**
1. Add fixtures; `pnpm install` (updates lockfile).
2. Vitest suite `cli/src/__tests__/codemod-apply.test.ts`: for each fixture — copy fixture `src/` (and config) to a temp dir **inside the fixture** (`.codemod-check/`, gitignored), run `generate` + the now-exported `applyPatches` (Task 7), then `execSync('pnpm run check')` in the fixture with the patched copy wired via the check script's `-p` project path. Gate the suite behind `process.env['CODEMOD_BUILD']` (skip otherwise) so unit runs stay fast; CI and the Task 11 gate run it with `CODEMOD_BUILD=1`.
3. Browser event-capture test (design R7): extend the existing e2e suite — read `test-e2e/AGENTS.md` and its existing browser test first, then add one case: patched `codemod-react` fixture served by vite, a scripted error, assert one `POST /api/v1/events` arrives at a stub server. Follow whatever browser harness test-e2e already uses; do not introduce a new one.
4. Commit: `test(cli): clean codemod fixtures with apply+typecheck and browser event capture`

---

## Task 10: Formal CLI contract doc + subprocess tests

**Files:** Create `docs/reference/cli-agent-contract.md`; create `cli/src/contract.ts` (the single source-of-truth status enum) + a hidden `opslane --contract` printer; create `cli/src/__tests__/contract.subprocess.test.ts` and `cli/src/__tests__/contract-drift.test.ts`.

**Step 1 — drift-proof contract (R5-8):** the doc dropping into `docs/reference/` is NOT automatically deterministic — `check-docs-drift.mjs` has bespoke checks only for routes/env/SDK-options/reason-codes, nothing for the CLI. So make the status table machine-checkable:
- `cli/src/contract.ts` exports the canonical `AGENT_STATUSES` (each: `status`, `exitCode`, `stream: 'stdout'|'stderr'`, one-line meaning). Every `exitWithStatus` call site uses a status from this enum.
- `docs/reference/cli-agent-contract.md` (reference tier: no frontmatter; opening paragraph names `cli/src/contract.ts` + `cli/src/setup.ts` as sources) renders one table per command, plus a canonical status table generated from `AGENT_STATUSES`.
- `contract-drift.test.ts` parses the status table out of the markdown and asserts it exactly equals `AGENT_STATUSES` (fails on any add/remove/exit-code change) — the deterministic guarantee the reference tier promises. Also add a line to `scripts/check-docs-drift.mjs` (or its `docs-map.mjs` registration) so root `pnpm test` runs this check, matching how the other reference docs are wired.
- Documented invariants in the doc: exactly one JSON document on stdout; diagnostics + interim `auth_required` on stderr; `pending`/`auth_required`/`already_configured`(informational) exit 0; `login`/`init` interactive, exempt (R3-4); `X-Opslane-Poll-Token`; canonical-origin algorithm; atomic 0600 writes.

**Step 2 — subprocess tests (R9), hermetic:** build the CLI, then spawn `node cli/dist/index.js <cmd>` against a local `http.createServer` stub implementing the PR 1 contract. **Run each subprocess with a temp `HOME` and temp `cwd` (R5 smaller correction)** so tests never read or mutate the real `~/.opslane`. Assert: stdout parses as exactly one JSON document; stderr carries the interim `auth_required` in blocking mode; exit codes for completed, `key_unavailable`, failed, expired, not_found, and usage conflict (`--start --poll`).

**Step 3:** Commit: `docs(cli): drift-checked agent contract + hermetic subprocess tests`

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
