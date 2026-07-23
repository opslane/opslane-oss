# Phase 1 — Engine Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build every deterministic piece of the `opslane onboard` agent engine — the MCP tools, a secret-aware `search`, the goal-based spec, the event reducer + ordered edit lifecycle, and the two-layer permission policy — all unit-tested, no live model, no TTY.

**Architecture:** The engine is `@anthropic-ai/claude-agent-sdk` `query()`, which spawns the bundled Claude Code subprocess (authenticated by `ANTHROPIC_API_KEY` from the environment; the CLI constructs no Anthropic client). Our code:
- The agent uses **built-in `Read`/`Glob`/`Edit`/`Write`** (keeping built-in `Read` preserves Claude Code's read-cache so `Edit` doesn't fail "file not read yet"). Built-in **`Grep` is disabled** (it returns `.env` content and can't be scoped) and replaced by a secret-aware **`search`** MCP tool.
- An in-process MCP server exposes `ask_user`, `finish_onboarding`, and `search`.
- `renderSpec` (goal + constraints + SDK contract) — it instructs the agent to **investigate the repository itself** (framework, env convention, entry point, package manager, existing SDK). There is no separate deterministic survey (see the design note below).
- An event reducer + an **ordered `EditTracker`**.
- The permission policy: a **PreToolUse hook** (un-shadowable hard denials, applied to *every* path-bearing tool) + a `canUseTool` approval callback, under `permissionMode: 'default'`, `settingSources: []`, `strictMcpConfig: true`.
- **One shared path/secret module** (`paths.ts`) used by the finish tool, search, hook, and tracker — so containment and the `.env*` definition can't drift.

**Design note — why no static survey (decided 2026-07-22, from a live eval):** an earlier draft ran a deterministic `surveyRepo()` pre-pass to detect framework/prefix/entry and injected it into the prompt. A live eval removed that pre-pass and let the agent read the repo itself. Result: correctness was identical — the agent chose the right convention on 5 fixture repos and both real repos (`asset-management-jira/vue3/client` → `VITE_APP_`, `verify-cloud/dashboard` → plain `VITE_`), with survey **off**. The survey only saved latency (~40% fewer turns), was framework-biased (reported `unknown` on a Create-React-App repo the agent handled correctly), and risked being *confidently wrong* on configs its regex missed — a wrong fact is worse than a blank one because the agent trusts it. So the static survey is dropped. If a later phase needs the package manager for an install step, that step reads the lock file inline where it's needed — no separate survey module. The one real defect the eval surfaced (the agent named a var `VITE_APP_DEFENDER_API_KEY`, picking up the repo's existing "Defender" wording instead of "Opslane") is fixed in the spec with an explicit naming guard (Task 1.4).

**Verified SDK facts (0.3.217, `sdk.d.ts` + spikes + codex review):**
- `permissionMode: 'default'` consults `canUseTool` for any tool NOT in `allowedTools`; `bypassPermissions` and bare `allowedTools` entries shadow it.
- Hooks: `hooks: { PreToolUse: [{ hooks: [cb] }] }`; `cb(input, toolUseID, {signal}) => Promise<HookJSONOutput>`; deny via `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }`; returning `{}` is "no opinion" and falls through to `canUseTool` (hook runs *before* permission resolution). `PreToolUseHookInput = { tool_name, tool_input, tool_use_id }`.
- `canUseTool(toolName, input, {signal}) => Promise<{behavior:'allow'} | {behavior:'deny', message}>`.
- `settingSources: []` loads no user/project/local settings; `strictMcpConfig: true` loads no external MCP.
- `createSdkMcpServer({name, version, tools})`; `tool(name, description, zodShape, handler)` (the SDK wraps the raw zod shape in a default Zod object, so unknown keys are stripped before the handler); `.handler` is callable for unit tests.
- Cancellation is via `options.abortController` (an `AbortController`), not a raw signal. The `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning is emitted by `process.emitWarning` in the parent — not in the generator stream or child stderr.

**Tech Stack:** TypeScript (ESM, strict), Node 22, `@anthropic-ai/claude-agent-sdk@0.3.217`, `zod@^4.0.0`, Vitest colocated in `__tests__`. All new code in `cli/src/onboard/`.
**Deps deferred to Phase 3 (the TUI):** `ink`, `react`, `@inkjs/ui`, `@types/react`. Phase 1 excludes the TUI, so it does not add them — no extra dependency/license surface for code that proves no engine seam.

**Out of scope for Phase 1:** the Ink TUI, controller, provisioning, CLI command (Phase 2/3). Prototype (UX/spec donor) in the clone `/Users/abhishekray/Projects/opslane/opslane-oss`: `git show prototype/onboard-tui:prototype/onboard/src/<file>`.

---

## Task 1.0: Shared path + secret-file policy (TDD)

One module so containment and the `.env*` rule can't drift across the finish tool, search, hook, and tracker (review #7).

**Files:** Create `cli/src/onboard/paths.ts`; test `cli/src/onboard/__tests__/paths.test.ts`.

**Step 1: Failing test** (real `mkdtemp` fixtures + a symlink):
```ts
import { describe, expect, it } from 'vitest';
import { isSecretFile, containedRepoRelative } from '../paths.js';

it('isSecretFile catches every dotenv shape', () => {
  for (const f of ['.env', '.env.production', '.env.local', '.env-example', '.envrc'])
    expect(isSecretFile(`/x/${f}`)).toBe(true);
  expect(isSecretFile('/x/src/env.ts')).toBe(false);
});

// containedRepoRelative(root, p): returns canonical repo-relative path, or throws.
it('contains real paths, rejects escapes and symlink aliases', async () => {
  // fixture: root/, root/src/main.ts, root/link -> /etc  (symlink)
  expect(containedRepoRelative(root, `${root}/src/main.ts`)).toBe('src/main.ts');
  expect(containedRepoRelative(root, `${root}/pkg/../src/main.ts`)).toBe('src/main.ts');
  expect(() => containedRepoRelative(root, '/etc/passwd')).toThrow(/contain/i);
  expect(() => containedRepoRelative(root, `${root}/link/passwd`)).toThrow(/contain/i); // symlink escape
  // a not-yet-created file inside root resolves via its nearest existing parent
  expect(containedRepoRelative(root, `${root}/src/new.ts`)).toBe('src/new.ts');
});
```

**Step 2:** FAIL. **Step 3: Implement.**
- `isSecretFile(p)`: `path.basename(p).startsWith('.env')` — catches `.env`, `.env.*`, `.env-*`, `.envrc` (the old regex missed `.envrc`/`.env-example`).
- `containedRepoRelative(root, p)`: normalize separators; resolve `p` against `root`; `realpath` the target if it exists, else `realpath` the **nearest existing ancestor** and append the remaining segments; realpath `root`; throw `outside repo` unless the resolved path is `realRoot` or under `realRoot + sep`; return `path.relative(realRoot, resolved)`. This is the single symlink-safe containment used everywhere.

**Step 4:** green. **Step 5: Commit** — `feat(cli): shared onboard path + secret-file policy`

---

## Task 1.1: Dependencies + discoverable colocated tests

**Files:** Modify `cli/package.json`, `cli/vitest.config.ts`.

**Step 0 (blocking):** `cli/vitest.config.ts` has `include: ['src/__tests__/**/*.test.ts']`, so `cli/src/onboard/__tests__/` tests are **never discovered**. Widen to `include: ['src/**/*.test.ts']`. Verify the existing suite still runs.

**Step 1:** Add to `dependencies`:
```json
"@anthropic-ai/claude-agent-sdk": "0.3.217",
"zod": "^4.0.0"
```
(zod 4 — the SDK peers `zod@^4`; its `tool()` uses zod-4 `AnyZodRawShape`/`InferShape`. Confirm no other CLI code pins zod 3.) Add `"engines": { "node": ">=22" }`. **Do not** add `ink`/`react`/`@inkjs/ui`/`@types/react` — those are Phase 3.

**Step 2:** `pnpm install`. If `scripts/check-licenses.mjs` flags the Agent SDK's `SEE LICENSE IN README.md`, add a targeted allowlist entry citing the 2026-07-22 reversal (`docs/decisions/anthropic-agent-sdk-terms.md`).

**Step 3:** `pnpm --filter @opslane/cli build` — green. **Step 4: Commit.**

---

## Task 1.2: `ask_user` (per-run) + `finish_onboarding` MCP tools (TDD)

No module-global resolver (review #6): `createAskUserTool(resolver)` is constructed per `runOnboardingAgent`. The finish report is untrusted; the handler validates every **value**. The SDK wraps the raw shape in a Zod object, which by default **strips** unknown keys before the handler runs — so unknown keys are dropped, not a threat, and handler-level unknown-key rejection is not the boundary. Value validation on the known fields is.

**Files:** Create `cli/src/onboard/tools.ts`; test `cli/src/onboard/__tests__/tools.test.ts`.

**Step 1: Failing test** — uses a **real `mkdtemp` app fixture** (so realpath + the `devScript`-exists check pass):
```ts
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createAskUserTool, createFinishTool, type OnboardingReport } from '../tools.js';
const call = (t: any, input: unknown) => t.handler(input, {} as never);

describe('ask_user (per-run factory)', () => {
  it('routes to its own resolver; throws with no resolver', async () => {
    const t = createAskUserTool(async ({ options }) => [options[1]!]);
    expect((await call(t, { question: 'Which?', options: ['a','b'], multi: false })).content[0])
      .toEqual({ type: 'text', text: 'User chose: b' });
    const bad = createAskUserTool(null);
    await expect(call(bad, { question: 'x', options: ['a'], multi: false })).rejects.toThrow();
  });
});

describe('finish_onboarding validation (untrusted report, real fixture)', () => {
  let root: string; let report: OnboardingReport;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fin-'));
    mkdirSync(join(root, 'web', 'src'), { recursive: true });
    writeFileSync(join(root, 'web', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    writeFileSync(join(root, 'web', 'src', 'main.ts'), '');
    report = { apps: [{ dir: 'web', apiKeyVar: 'VITE_OPSLANE_API_KEY', endpointVar: 'VITE_OPSLANE_ENDPOINT',
      packageManager: 'pnpm', devScript: 'dev' }], editedFiles: ['web/src/main.ts', 'web/package.json'] };
  });
  const finish = (state = { finished: false }) => createFinishTool(root, state, () => {});

  it('accepts a valid report and sets finished on success', async () => {
    const state = { finished: false }; await call(createFinishTool(root, state, () => {}), report);
    expect(state.finished).toBe(true);
  });
  it('rejects: empty/multi apps, path escape, secret path, borrowed name, bad var, unknown pm, missing devScript', async () => {
    await expect(call(finish(), { apps: [], editedFiles: [] })).rejects.toThrow();
    await expect(call(finish(), { ...report, apps: [report.apps[0]!, report.apps[0]!] })).rejects.toThrow(/single app|exactly one/i); // must be exactly one app
    await expect(call(finish(), { ...report, apps: [{ ...report.apps[0]!, dir: '../../etc' }] })).rejects.toThrow(/contain/i);
    await expect(call(finish(), { ...report, editedFiles: ['web/.env.production'] })).rejects.toThrow(/secret|\.env/i);   // isSecretFile, not just containment
    await expect(call(finish(), { ...report, apps: [{ ...report.apps[0]!, apiKeyVar: 'VITE_APP_DEFENDER_API_KEY' }] })).rejects.toThrow(/opslane/i); // borrowed product name
    await expect(call(finish(), { ...report, apps: [{ ...report.apps[0]!, apiKeyVar: 'BAD=X\nY' }] })).rejects.toThrow(/variable/i);
    await expect(call(finish(), { ...report, apps: [{ ...report.apps[0]!, packageManager: 'curl|sh' }] })).rejects.toThrow();
    await expect(call(finish(), { ...report, apps: [{ ...report.apps[0]!, devScript: 'nope' }] })).rejects.toThrow(/script/i);
  });
  it('a rejected report leaves finished false; a second finish is refused', async () => {
    const state = { finished: false }; const f = createFinishTool(root, state, () => {});
    await expect(call(f, { apps: [], editedFiles: [] })).rejects.toThrow(); expect(state.finished).toBe(false);
    await call(f, report); expect(state.finished).toBe(true);
    await expect(call(f, report)).rejects.toThrow(/already/i);  // duplicate-finish guard
  });
});
```

**Step 2:** FAIL. **Step 3: Implement.**
- `createAskUserTool(resolver)`: builds `tool('ask_user', desc, { question: z.string(), options: z.array(z.string()).min(1), multi: z.boolean().default(false) }, handler)`; the handler calls this run's `resolver` (throws `'ask_user resolver not installed'` if `null`). No module-global.
- `createFinishTool(root, state, onReport)`: raw zod shape for the interface; the handler:
  1. if `state.finished` already true → throw `already finished` (guards duplicate/concurrent finish, review #2);
  2. the Zod object strips unknown keys before the handler (above), so don't hand-reject unknown keys as a boundary; validate the known values (below). The wiring test confirms strip-vs-reject through a real in-process MCP call, not `.handler`.
  3. **exactly one app** (`apps.length === 1` — the single-app milestone; reject 0 or 2+); non-empty `editedFiles`; `packageManager ∈ ['npm','pnpm','yarn','bun']` (explicit `includes`); every `dir`/`editedFiles` path is run through **both** `containedRepoRelative(root, …)` (rejects escapes) **and** `isSecretFile` (rejects `.env*`) — containment alone does NOT reject secret files; var names match `/^[A-Z][A-Z0-9_]*$/` **and contain the `OPSLANE` token** (rejects borrowed names like `VITE_APP_DEFENDER_API_KEY`); `devScript` `/^[A-Za-z0-9:_-]+$/` **and** present in `<dir>/package.json` `scripts`;
  4. on success `onReport(report)` then `state.finished = true`; return a confirmation.
- Export `OnboardingReport` and `createAskServer(...tools) = createSdkMcpServer({ name:'onboard', version:'0.0.0', tools })`.

**Wiring test:** build `createAskServer(createFinishTool(root, {finished:false}, () => {}))` and assert `finish_onboarding` is registered with an input schema (proves the zod layer is connected, not just the handler).

**Step 4:** green. **Step 5: Commit.**

---

## Task 1.3: Secret-aware `search` tool (TDD)

Replaces built-in `Grep`. **Literal substring only** (no model-supplied regex), bounded (review #8).

**Files:** Create `cli/src/onboard/search-tool.ts`; test `cli/src/onboard/__tests__/search-tool.test.ts`.

**Step 1: Failing test** (`mkdtemp` fixture with a `.env.production` containing the query, a binary file, and a normal source hit):
- `search({ query, glob? })` returns `path:line` matches from in-root text files; a string that exists **only** in `.env.production` returns nothing; `node_modules`/`.git`/binary files are skipped; a symlink to outside is not traversed; results capped and total bytes scanned capped.

**Step 2:** FAIL. **Step 3: Implement** `createSearchTool(root)` as a `tool()` with `{ query: z.string().min(1), glob: z.string().optional() }`. Walk `root` with `node:fs` (skip `.git`/`node_modules`, any `isSecretFile`, and symlinks pointing outside via `containedRepoRelative`), match the query as a **literal substring** (not a regex the model controls), skip files that look binary (NUL byte in the first 8KB) and files over a per-file byte cap, stop at a total-bytes-scanned cap and a max-results cap, and emit `repoRel:line`. **Step 4:** green. **Step 5: Commit.**

---

## Task 1.4: Goal-based spec (TDD)

Live-validated: goal + constraints, with the agent told to read the repo itself, makes it match the repo's own convention (chose `VITE_APP_OPSLANE_API_KEY` on a `VITE_APP_` repo, plain `VITE_OPSLANE_API_KEY` on a default-prefix repo). No fixed filename, no baked-in prefix, **no injected survey**. The spec also pins the product name so the agent doesn't borrow another product's wording (the `VITE_APP_DEFENDER_API_KEY` slip from the eval).

**Files:** Create `cli/src/onboard/spec.ts`; test `cli/src/onboard/__tests__/spec.test.ts`.

**Step 1: Failing test**
```ts
import { renderSpec } from '../spec.js';
it('goal-framed, tells the agent to investigate, bakes in no convention, guards the product name', () => {
  const spec = renderSpec({ cwd: '/repo/x' });
  expect(spec).toContain('/repo/x');
  expect(spec).not.toContain('VITE_OPSLANE_');                     // no baked-in prefix
  expect(spec.toLowerCase()).toContain('read the repository');     // investigate-first, not a survey dump
  expect(spec).toMatch(/name the opslane variables after opslane/i); // naming guard (Defender fix)
  expect(spec).toMatch(/never name them after another product/i);
  for (const n of ['goal','follow','endpoint','ask_user','migrate','finish_onboarding','never write','do not run installs'])
    expect(spec.toLowerCase()).toContain(n);
});
```
**Step 2:** FAIL. **Step 3: Implement** `renderSpec({ cwd })` — a single string with:
- **Goal:** `init` runs once at the app's real entry point, reading key + required endpoint from THIS repo's env convention; `@opslane/sdk` added to that app's deps.
- **Investigate first:** the agent reads the repo itself to determine framework, env naming convention, entry point, package manager, and any existing error SDK. No survey is injected.
- **SDK contract:** `init({ apiKey, endpoint })`, endpoint required (a contract, not a code template).
- **Constraints:** follow the repo's own prefix/config; **name the Opslane variables after Opslane (e.g. `PREFIX_OPSLANE_API_KEY`), never after another product in the repo** (the finish validator also enforces the `OPSLANE` token, but the prompt guard keeps the agent from writing the wrong name into source in the first place); env vars by name only — **never write** literal secrets or environment-variable values (this exact phrasing keeps the spec test's `never write` assertion honest); migrate an existing SDK rather than duplicate; ask before editing; do not run installs; `devScript` must be an existing script; **single app this milestone — if the repo has more than one plausible app, call `ask_user` (`multi:false`) to have the user pick exactly one before any edit**; end with exactly one `finish_onboarding`, no edits after.

Add to the test: `expect(spec).toMatch(/more than one|multiple/i)` and `expect(spec).toMatch(/pick|select/i)` to pin the multi-app→ask_user instruction.

**Step 4:** green. **Step 5: Commit.**

---

## Task 1.5: Event reducer + ordered `EditTracker` (TDD)

The reducer drives task lines; the tracker records an **ordered** tool lifecycle so the Phase-3 controller can reject edits at-or-after the accepted finish (review #2 — sets can't).

**Files:** Create `cli/src/onboard/events.ts`; test `cli/src/onboard/__tests__/events.test.ts`.

**Step 1: Failing test**
```ts
import { labelFor, reduceTasks, EditTracker, type TaskLine } from '../events.js';
const asst = (blocks: any[]) => ({ type:'assistant', message:{ content: blocks } });
const tu = (id: string, name: string, input: any) => ({ type:'tool_use', id, name, input });
const usr = (blocks: any[]) => ({ type:'user', message:{ content: blocks } });
const tr = (id: string, err = false) => ({ type:'tool_result', tool_use_id:id, is_error: err });

it('reducer: multi-block, fail on error result, all-fail on error result msg', () => {
  let t: TaskLine[] = reduceTasks([], asst([tu('a','Edit',{file_path:'/r/a'}), tu('b','Read',{file_path:'/r/b'})]));
  expect(t.length).toBe(2);
  t = reduceTasks(t, usr([tr('a'), tr('b', true)]));
  expect(t.find(x=>x.id==='a')!.state).toBe('done'); expect(t.find(x=>x.id==='b')!.state).toBe('fail');
});

it('EditTracker: ordered, commit on success, flags edit at/after finish', () => {
  const t = new EditTracker('/r');   // uses containedRepoRelative
  t.onMessage(asst([tu('e1','Edit',{file_path:'/r/src/main.ts'})])); t.onMessage(usr([tr('e1')]));
  t.onMessage(asst([tu('f','mcp__onboard__finish_onboarding',{})])); t.onMessage(usr([tr('f')]));
  t.onMessage(asst([tu('e2','Edit',{file_path:'/r/src/late.ts'})]));  t.onMessage(usr([tr('e2')]));
  t.markFinished('f');                                   // controller calls this when finish is accepted
  expect([...t.committedBeforeFinish()]).toEqual(['src/main.ts']);
  expect(t.editsAfterFinish()).toEqual(['src/late.ts']); // e2 landed after finish → flagged
});
```
**Step 2:** FAIL. **Step 3: Implement.**
- `reduceTasks(tasks, msg)`: iterate **every** content block; tool_use → append `run`; tool_result → mark id `done`, or `fail` when `is_error`; a `result` msg with an error subtype → all running `fail`, clean `result` → `done`. New array.
- `EditTracker(root)`: records an **ordered log** of `{seq, id, kind:'edit'|'finish', path?, committed:boolean}`. `onMessage` assigns a monotonic seq to each `tool_use`, and on a matching non-error `tool_result` marks it committed (an errored/denied edit is never committed — review). `markFinished(id)` records the seq of the accepted finish. `committedBeforeFinish()` = committed edit paths with seq < finish seq; `editsAfterFinish()` = committed edit paths with seq ≥ finish seq (what the controller rejects). Paths via `containedRepoRelative`.
- `labelFor` maps tool names to friendly labels.

**Step 4:** green. **Step 5: Commit.**

---

## Task 1.6: Permission policy — hook + approval (TDD)

The hook applies containment to **every path-bearing tool** (review #1 — Read/Glob/Edit/Write, not just mutators) plus the `.env` and Bash and post-finish rules. Approval is separate and does not touch finish-state.

**Files:** Create `cli/src/onboard/policy.ts`; test `cli/src/onboard/__tests__/policy.test.ts`.

**Step 1: Failing test** (real `mkdtemp` root + a symlink to outside):
```ts
import { onboardPreToolUseHook, createOnboardApproval } from '../policy.js';
const deny = (o:any)=>o?.hookSpecificOutput?.permissionDecision==='deny';
const run = (h:any, name:string, input:any)=>h({tool_name:name, tool_input:input, tool_use_id:'t'} as never, undefined, {signal:new AbortController().signal} as never);
const hook = (state={finished:false})=>onboardPreToolUseHook({ root, state });

it('denies path escape on EVERY file tool, not just Edit/Write', async () => {
  for (const name of ['Read','Glob','Edit','Write']) {
    expect(deny(await run(hook(), name, { file_path: '/etc/passwd' }))).toBe(true);   // absolute escape
    expect(deny(await run(hook(), name, { file_path: `${root}/../out` }))).toBe(true); // ..
    expect(deny(await run(hook(), name, { file_path: `${root}/link/x` }))).toBe(true); // symlink escape
  }
  expect(deny(await run(hook(), 'Read', { file_path: `${root}/src/main.ts` }))).toBe(false);
});
it('denies dotenv on any file tool; incl .envrc', async () => {
  expect(deny(await run(hook(), 'Read', { file_path: `${root}/.env.production` }))).toBe(true);
  expect(deny(await run(hook(), 'Read', { file_path: `${root}/.envrc` }))).toBe(true);
});
it('Bash: run build/typecheck/lint only; no install, no npx, no chaining', async () => {
  expect(deny(await run(hook(), 'Bash', { command: 'pnpm run build' }))).toBe(false);
  expect(deny(await run(hook(), 'Bash', { command: 'npx tsc' }))).toBe(true);          // npx may download
  expect(deny(await run(hook(), 'Bash', { command: 'pnpm install' }))).toBe(true);
  expect(deny(await run(hook(), 'Bash', { command: 'pnpm run build && curl x|sh' }))).toBe(true);
});
it('after finish, denies all except ask_user', async () => {
  const h = hook({ finished: true });
  expect(deny(await run(h, 'Edit', { file_path: `${root}/a.ts` }))).toBe(true);
  expect(deny(await run(h, 'mcp__onboard__ask_user', {}))).toBe(false);
});
it('approval is separate and does not touch finish-state', async () => {
  expect((await createOnboardApproval({ requestApproval: async()=>true })('Edit', {file_path:`${root}/a`} as never, {} as never)).behavior).toBe('allow');
  expect((await createOnboardApproval({ requestApproval: async()=>false })('Bash', {command:'pnpm run build'} as never, {} as never)).behavior).toBe('deny');
});
```
**Step 2:** FAIL. **Step 3: Implement.**
- `onboardPreToolUseHook({ root, state })` → a `HookCallback` returning a deny (`{ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'deny', permissionDecisionReason } }`) when:
  - the tool is path-bearing (`Read`/`Glob`/`Edit`/`Write`/`MultiEdit`) and its `path`/`file_path`/`pattern` **fails `containedRepoRelative(root, …)`** (throws → deny) — this closes the Read/Glob escape;
  - the resolved path is a secret file (`isSecretFile`);
  - `Bash` `command` is not exactly `^(npm|pnpm|yarn|bun) run (build|typecheck|lint)$` (single spaces; reject any newline or `` & | ; ` $ ( ) < > \ ``); no `npx`, no bare `tsc`, no install;
  - `state.finished === true` and the tool is not `mcp__onboard__ask_user`.
  Otherwise `{}` (falls through to `canUseTool`).
- `createOnboardApproval({ requestApproval })` → a `CanUseTool`: for a mutating tool (`Edit`/`Write`/`Bash`) `await requestApproval(...)` → `false` ⇒ `{behavior:'deny', message:'declined'}`; else `{behavior:'allow'}`. It does **not** read or set `finished` (that lives in the finish handler).

**Step 4:** green. **Step 5: Commit.**

---

## Task 1.7: Engine assembly + tested `runOnboardingAgent` (TDD)

`runOnboardingAgent` holds the failure-prone seams (cancellation, warning capture, terminal-result mapping), so it takes an **injectable `queryFn`** and is unit-tested with an async-generator stub — no model, no subprocess (review #5). No `survey` parameter — the spec tells the agent to investigate the repo itself.

**Files:** Create `cli/src/onboard/engine.ts`; test `cli/src/onboard/__tests__/engine.test.ts`.

**Step 1: Failing test**
```ts
import { engineOptions, runOnboardingAgent } from '../engine.js';

it('engineOptions locks the gate', () => {
  const o = engineOptions({ cwd:'/r', canUseTool: async()=>({behavior:'allow'}), hook: async()=>({}),
                            mcpServers:{} as never, abortController:new AbortController() });
  expect(o.permissionMode).toBe('default'); expect(o.settingSources).toEqual([]); expect(o.strictMcpConfig).toBe(true);
  expect(o.allowedTools).toEqual(['mcp__onboard__ask_user']);
  expect(o.disallowedTools).toEqual(expect.arrayContaining(['Grep','WebFetch','WebSearch']));
  expect(o.disallowedTools).not.toContain('Read');                 // Read stays (read-cache)
  expect(o.hooks?.PreToolUse?.[0]?.hooks?.length).toBe(1);
});

// async-generator stub for queryFn — no SDK, no subprocess:
const stub = (msgs: any[]) => ({ [Symbol.asyncIterator]: async function* () { for (const m of msgs) yield m; } });

// lifecycle tests need a dummy key — runOnboardingAgent short-circuits to no_api_key when ANTHROPIC_API_KEY is unset,
// so a hermetic env would otherwise fail the success/abort cases. Set it for these, restore the prior value after.
const priorKey = process.env.ANTHROPIC_API_KEY;
beforeAll(() => { process.env.ANTHROPIC_API_KEY = 'test-only'; });
afterAll(() => { if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey; });

it('runOnboardingAgent maps a clean result to ok:true', async () => {
  const r = await runOnboardingAgent({ cwd:'/r', onMessage(){}, onReport(){},
    requestApproval: async()=>true, signal: new AbortController().signal,
    queryFn: () => stub([{ type:'result', subtype:'success' }]) as never });
  expect(r.ok).toBe(true);
});
it('maps an error result / max-turns / missing result to ok:false (never throws normally)', async () => {
  for (const msgs of [[{type:'result', subtype:'error_max_turns'}], []]) {
    const r = await runOnboardingAgent({ cwd:'/r', onMessage(){}, onReport(){},
      requestApproval: async()=>true, signal: new AbortController().signal, queryFn: () => stub(msgs) as never });
    expect(r.ok).toBe(false);
  }
});
it('a caller-abort aborts the run; an already-aborted signal is handled', async () => {
  const ac = new AbortController(); ac.abort();
  const r = await runOnboardingAgent({ cwd:'/r', onMessage(){}, onReport(){},
    requestApproval: async()=>true, signal: ac.signal, queryFn: () => stub([]) as never });
  expect(r.ok).toBe(false); expect(r.aborted).toBe(true);
});
it('returns no_api_key and never queries when the key is missing', async () => {
  delete process.env.ANTHROPIC_API_KEY; let queried = false;
  const r = await runOnboardingAgent({ cwd:'/r', onMessage(){}, onReport(){}, requestApproval: async()=>true,
    signal: new AbortController().signal, queryFn: () => { queried = true; return stub([]) as never; } });
  process.env.ANTHROPIC_API_KEY = 'test-only';
  expect(r.reason).toBe('no_api_key'); expect(queried).toBe(false);
});
it('maps a thrown queryFn to ok:false without rethrowing', async () => {
  const r = await runOnboardingAgent({ cwd:'/r', onMessage(){}, onReport(){}, requestApproval: async()=>true,
    signal: new AbortController().signal, queryFn: () => { throw new Error('subprocess failed'); } });
  expect(r.ok).toBe(false); expect(r.reason).toMatch(/subprocess failed/);
});
```
**Step 2:** FAIL. **Step 3: Implement.**
- `engineOptions({ cwd, canUseTool, hook, mcpServers, abortController })`: `cwd`; `permissionMode:'default'`; `settingSources:[]`; `strictMcpConfig:true`; `allowedTools:['mcp__onboard__ask_user']`; `tools:['Read','Glob','Write','Edit','Bash']`; `disallowedTools:['Grep','WebFetch','WebSearch']`; `mcpServers`; `hooks:{PreToolUse:[{hooks:[hook]}]}`; `canUseTool`; `abortController`; `maxTurns:60`.
- `runOnboardingAgent({ cwd, onMessage, onReport, requestApproval, signal, askUser = null, queryFn = query })`:
  - if `!process.env.ANTHROPIC_API_KEY` → return `{ ok:false, reason:'no_api_key' }` (or throw a typed error — controller-friendly; pick one and test it).
  - `state = { finished:false }`; `hook = onboardPreToolUseHook({ root:cwd, state })`; `canUseTool = createOnboardApproval({ requestApproval })`; `mcpServers = { onboard: createAskServer(createAskUserTool(askUser), createFinishTool(cwd, state, onReport), createSearchTool(cwd)) }`.
  - **Cancellation:** create an `AbortController ac`; if `signal.aborted` already, `ac.abort()`; else add a one-shot `signal` listener that calls `ac.abort()`. Pass `ac` as `abortController`.
  - **Warning tripwire (safe):** register `const onWarn = (w) => { if isShadowWarning(w) and not the intentional ask_user shadow: shadowErr = new Error(...); ac.abort(); }; process.on('warning', onWarn)`. **Do not throw inside the listener** (uncaught process exception) — store it, abort, and reject after the loop. The `mcp__onboard__ask_user` shadow is intentional (it is in `allowedTools`) and must NOT trip the tripwire.
  - **`try`:** iterate `queryFn({ prompt: renderSpec({cwd}), options: engineOptions({cwd, canUseTool, hook, mcpServers, abortController: ac}) })` into `onMessage`, capturing the terminal `result` message.
  - **`catch`:** a thrown SDK/iterator error (subprocess spawn failure, mid-stream throw) is captured into `caughtError` and mapped to `{ ok:false, reason: err.message }` — never rethrown. (Aborting the controller mid-iteration surfaces here or via the aborted-signal check.)
  - **`finally`:** remove `onWarn` and the `signal` listener.
  - Return `{ ok, aborted, subtype, reason }`: `ok:false` if `shadowErr`, if `caughtError` (reason = its message), if aborted, if no terminal result was seen, or if the result subtype is an error/max-turns; `ok:true` only on a clean `result`. `runOnboardingAgent` **never decides success** beyond a clean result — the Phase-3 controller additionally requires a captured report reconciled against `EditTracker`.

**Step 4:** green. **Step 5: Commit.**

---

## Task 1.8: Phase 1 validation checkpoint

```bash
pnpm --filter @opslane/cli build
pnpm --filter @opslane/cli exec vitest run src/onboard
pnpm --filter @opslane/cli test    # whole existing CLI suite still green
```
All green = Phase 1 unit-complete. Every seam — including `runOnboardingAgent`'s lifecycle (via the injected `queryFn` stub) — is unit-tested; nothing spawns the subprocess or touches a TTY.

**Live run (required — standing preference: exercise the real running system, not just green tests):** with `ANTHROPIC_API_KEY` set, drive `runOnboardingAgent` against a throwaway copy of a real app and confirm: it reaches `ok:true`, wires `init()` at the entry point using the repo's own prefix and the `OPSLANE` product name, adds `@opslane/sdk` to deps, and the hook blocks a planted `.env` secret. Never run against a real project in place — copy to a temp dir first (the agent edits files).

---

## SDK facts confirmed by codex review (2026-07-22)

`tool()` exposes a callable `.handler`; a PreToolUse hook returning `{}` is "no opinion" and runs before permission resolution; `disallowedTools` reliably removes built-in `Grep`; built-ins + an in-process MCP server coexist in one `query()`. Cancellation is via `options.abortController`; the shadow warning is a parent-process `process.emitWarning`.
