# Phase 1 — Engine Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build every deterministic piece of the `opslane onboard` agent engine — the two MCP tools, the secret-aware survey tools, the deterministic survey pre-pass, the goal-based spec, the event reducer, and the two-layer permission policy — all unit-tested, no live model, no TTY.

**Architecture:** The engine is `@anthropic-ai/claude-agent-sdk` `query()`, which spawns the bundled Claude Code subprocess (authenticated by `ANTHROPIC_API_KEY` from the environment — the CLI constructs no Anthropic client). Our code is: (a) an in-process MCP server exposing `ask_user`, `finish_onboarding`, and secret-aware survey tools (`read_file`, `search`, `list_dir`); (b) a deterministic `survey` pre-pass the CLI runs and injects into the prompt; (c) `renderSpec` (goal + constraints + SDK contract); (d) an event reducer + edit tracker; (e) the permission policy — a **PreToolUse hook** for un-shadowable hard denials plus a `canUseTool` callback for human approval, run under `permissionMode: 'default'` with `settingSources: []` so no user/project settings can shadow the gate.

**Verified SDK facts (0.3.217, from `sdk.d.ts` + the 2026-07-22 spikes):**
- `permissionMode: 'default'` consults `canUseTool` for any tool NOT in `allowedTools`; `bypassPermissions` and bare `allowedTools` entries shadow it (spike-confirmed).
- Hooks: `hooks: { PreToolUse: [{ hooks: [cb] }] }`. `cb(input: PreToolUseHookInput, toolUseID, {signal}) => Promise<HookJSONOutput>`; deny via `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }`. `HookPermissionDecision = 'allow'|'deny'|'ask'|'defer'`. `PreToolUseHookInput = { tool_name, tool_input, tool_use_id }`.
- `canUseTool(toolName, input, {signal,...}) => Promise<PermissionResult>`; `{behavior:'allow', updatedInput?} | {behavior:'deny', message}`.
- `settingSources?: ('user'|'project'|'local')[]`; `settingSources: []` loads none.
- `createSdkMcpServer({name, version, tools})`; `tool(name, description, zodShape, handler)`; handler returns `{content:[{type:'text', text}]}`.

**Tech Stack:** TypeScript (ESM, strict), Node 22, `@anthropic-ai/claude-agent-sdk@0.3.217`, `zod@^3`, `ink@7.1.1` + `@inkjs/ui@2.0.0` + `react@19.2.8` (exact — `docs/decisions/tui-renderer.md`), Vitest colocated in `__tests__`. All new code in `cli/src/onboard/` (create it).

**Out of scope for Phase 1:** the Ink TUI, the controller, provisioning, the CLI command — those are Phase 3 (run-and-observe) and Phase 2 (plumbing). Phase 1 is only the CI-testable engine seams. The prototype at `prototype/onboard-tui` (in the clone `/Users/abhishekray/Projects/opslane/opslane-oss`) is a UX/spec donor: `git show prototype/onboard-tui:prototype/onboard/src/<file>`.

---

## Task 1.1: Dependencies

**Files:** Modify `cli/package.json`.

**Step 1:** Add to `dependencies` (exact versions, no ranges for the renderer stack):
```json
"@anthropic-ai/claude-agent-sdk": "0.3.217",
"@inkjs/ui": "2.0.0",
"ink": "7.1.1",
"react": "19.2.8",
"zod": "^3.23.0"
```
Add to `devDependencies`: `"@types/react": "^19.0.0"`. Add `"engines": { "node": ">=22" }`.
(No `@anthropic-ai/sdk` — `query()` spawns a subprocess that reads `ANTHROPIC_API_KEY`; we construct no client.)

**Step 2:** `pnpm install` (workspace root). Expected: lockfile updates, no peer errors. If `scripts/check-licenses.mjs` flags the Agent SDK's `SEE LICENSE IN README.md`, add a targeted allowlist entry citing the 2026-07-22 reversal (`docs/decisions/anthropic-agent-sdk-terms.md`).

**Step 3:** `pnpm --filter @opslane/cli build` — green.

**Step 4: Commit** — `git commit -am "feat(cli): onboard engine dependencies"`

---

## Task 1.2: `ask_user` + `finish_onboarding` MCP tools (TDD)

`ask_user` routes a question to a swappable resolver (Ink in prod, a stub in tests). `finish_onboarding` receives the agent's **structured, untrusted** report; validate everything at the tool boundary.

**Files:** Create `cli/src/onboard/tools.ts`; test `cli/src/onboard/__tests__/tools.test.ts`.

**Step 1: Write the failing test**
```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { askUserTool, setAskResolver, createFinishTool, type OnboardingReport } from '../tools.js';

const call = (t: any, input: unknown) => t.handler(input, {} as never);

describe('ask_user', () => {
  it('returns the resolver choice', async () => {
    setAskResolver(async ({ options }) => [options[1]!]);
    expect((await call(askUserTool, { question: 'Which?', options: ['a','b'], multi: false }))
      .content[0]).toEqual({ type: 'text', text: 'User chose: b' });
  });
  it('throws when no resolver installed (piped runs must not hang)', async () => {
    setAskResolver(null);
    await expect(call(askUserTool, { question: 'x', options: ['a'], multi: false })).rejects.toThrow();
  });
});

describe('finish_onboarding validation (report is untrusted)', () => {
  const root = '/repo/x';
  let captured: OnboardingReport | null; let finish: ReturnType<typeof createFinishTool>;
  beforeEach(() => { captured = null; finish = createFinishTool(root, (r) => { captured = r; }); });
  const good: OnboardingReport = { apps: [{ dir: 'client/web', apiKeyVar: 'VITE_OPSLANE_API_KEY',
    endpointVar: 'VITE_OPSLANE_ENDPOINT', packageManager: 'pnpm', devScript: 'dev' }],
    editedFiles: ['client/web/src/main.ts', 'client/web/package.json'] };

  it('accepts a valid report', async () => { await call(finish, good); expect(captured).toEqual(good); });
  it('rejects empty apps/edits', async () => {
    await expect(call(finish, { apps: [], editedFiles: [] })).rejects.toThrow(); expect(captured).toBeNull();
  });
  it('rejects paths escaping the root', async () => {
    await expect(call(finish, { ...good, apps: [{ ...good.apps[0]!, dir: '../../etc' }] })).rejects.toThrow(/contain/i);
    await expect(call(finish, { ...good, editedFiles: ['../out.ts'] })).rejects.toThrow(/contain/i);
  });
  it('rejects non-SCREAMING_SNAKE var names (env-file injection)', async () => {
    await expect(call(finish, { ...good, apps: [{ ...good.apps[0]!, apiKeyVar: 'BAD=X\nY' }] })).rejects.toThrow(/variable/i);
  });
  it('rejects unknown package manager / non-identifier devScript', async () => {
    await expect(call(finish, { ...good, apps: [{ ...good.apps[0]!, packageManager: 'curl|sh' }] })).rejects.toThrow();
    await expect(call(finish, { ...good, apps: [{ ...good.apps[0]!, devScript: 'dev; rm -rf /' }] })).rejects.toThrow();
  });
});
```

**Step 2:** `pnpm --filter @opslane/cli exec vitest run src/onboard` — FAIL (module missing).

**Step 3: Implement.** (Port `ask_user` wording from `prototype/onboard/src/ask.ts`.)
- Resolver slot defaults to `null`; `askUserTool` (via `tool('ask_user', desc, { question: z.string(), options: z.array(z.string()).min(1), multi: z.boolean().default(false) }, handler)`) throws `'ask_user resolver not installed'` when unset. Export the tool object so `.handler` is testable without the SDK runtime (if `tool()` doesn't expose `.handler` in 0.3.217, export the raw handler separately — the test's `call()` indirection stays).
- `createFinishTool(root, onReport)`: zod schema (`apps[]` with `dir`, `apiKeyVar`, `endpointVar`, `packageManager: z.enum(['npm','pnpm','yarn','bun'])`, `devScript`; `editedFiles[]`; `.strict()`), plus hand checks the schema can't do: non-empty arrays; every `dir`/`editedFiles` entry resolves inside `root` (`path.resolve(root, p)` startsWith `root` — realpath containment is enforced later in the controller when files exist, here reject `..`/absolute escapes); var names match `/^[A-Z][A-Z0-9_]*$/`; `devScript` matches `/^[A-Za-z0-9:_-]+$/`. Valid → `onReport(report)`, return a confirmation string.
- Export `OnboardingReport` type; export `createAskServer(...tools)` = `createSdkMcpServer({ name: 'onboard', version: '0.0.0', tools })` (used in Task 1.8).

**Step 4:** green. **Step 5: Commit** — `feat(cli): ask_user + validated finish_onboarding tools`

---

## Task 1.3: Secret-aware survey tools (TDD)

Built-in `Read`/`Grep` are disabled (Task 1.8) because a repo-wide `Grep` returns lines from a committed `.env.production`. The agent surveys through these instead: they refuse any `.env*` path and stay inside the repo root.

**Files:** Create `cli/src/onboard/survey-tools.ts`; test `cli/src/onboard/__tests__/survey-tools.test.ts`.

**Step 1: Failing test** — using `fs.mkdtemp` fixtures:
- `read_file({ path })`: returns contents for an in-root file; **rejects** any path matching `/(^|\/)\.env(\..+)?$/` and any path resolving outside root; output capped (e.g. 64KB).
- `search({ query, glob? })`: returns matching `path:line` results across in-root files, **excluding** `.env*`, `.git`, `node_modules`.
- `list_dir({ path })`: entries with a trailing `/` on dirs; excludes `.git`/`node_modules`; refuses out-of-root.

**Step 2:** FAIL. **Step 3: Implement** as `tool()`s built by `createSurveyTools(root)`. Shared `containedPath(root, p)` helper (resolve + startsWith, reject `.env*`). Use `node:fs`; for `search`, walk the tree (skip excluded dirs), simple substring/regex match, cap results. **Step 4:** green. **Step 5: Commit.**

---

## Task 1.4: Deterministic survey pre-pass (TDD)

Following PostHog's wizard, the CLI computes a repo map deterministically and injects it into the prompt so the model starts scoped instead of surveying blind.

**Files:** Create `cli/src/onboard/survey.ts`; test `cli/src/onboard/__tests__/survey.test.ts`.

**Step 1: Failing test** — `surveyRepo(cwd)` → `Survey` against three `mkdtemp` fixtures:
- a plain Vite+React repo → `{ framework:'react-vite', entryPoints:['src/main.tsx'], envPrefix:'VITE_', configLocation:'vite.config.ts', existingSdk:null, packageManager:'npm' }`
- a `VITE_APP_*` repo (config uses `loadEnv(mode,'.','VITE_APP_')`, `pnpm-lock.yaml` present) → `envPrefix:'VITE_APP_'`, `packageManager:'pnpm'`
- a repo with `@defender-dev/sdk` in deps → `existingSdk:'@defender-dev/sdk'`

**Step 2:** FAIL. **Step 3: Implement** `surveyRepo(cwd)`:
- Parse `package.json` (deps/devDeps → framework, existing error SDK `@opslane/sdk`/`@defender-dev/sdk`); lockfile presence → `packageManager` (`pnpm-lock.yaml`|`package-lock.json`|`yarn.lock`|`bun.lockb`).
- Read `vite.config.{ts,js}`/framework config: regex for `loadEnv(mode, …, 'PREFIX_')` or `envPrefix:` to get the prefix (default `VITE_`); record `configLocation`.
- Detect entry point by convention (`src/main.tsx`/`.ts`/`main.js`) via existence checks.
- Scan `.env*` filenames present (do NOT read values) to corroborate the prefix.
Pure fs + parse; return the struct. **Step 4:** green. **Step 5: Commit.**

---

## Task 1.5: Goal-based spec (TDD)

Spike-validated: a goal + constraints + injected survey makes the agent match the repo's convention (it chose `VITE_APP_OPSLANE_API_KEY` on the `VITE_APP_` fixture). No fixed filename, no baked-in prefix.

**Files:** Create `cli/src/onboard/spec.ts`; test `cli/src/onboard/__tests__/spec.test.ts`.

**Step 1: Failing test**
```ts
import { describe, expect, it } from 'vitest';
import { renderSpec } from '../spec.js';
it('is goal-framed, carries the rules, injects the survey, hardcodes no convention', () => {
  const spec = renderSpec({ cwd: '/repo/x', survey: {
    framework: 'vue-vite', entryPoints: ['src/main.ts'], envPrefix: 'VITE_APP_',
    configLocation: 'vite.config.ts', existingSdk: null, packageManager: 'pnpm' } });
  expect(spec).toContain('/repo/x');
  expect(spec).toContain('VITE_APP_');          // the injected finding
  expect(spec).not.toContain('VITE_OPSLANE_');  // never bake in our own prefix
  const lower = spec.toLowerCase();
  for (const n of ['goal','follow','endpoint','ask_user','migrate','finish_onboarding',
                   'never write','do not run installs']) expect(lower).toContain(n);
});
```

**Step 2:** FAIL. **Step 3: Implement** `renderSpec({ cwd, survey })` — start from `prototype/onboard/src/spec.ts`, reshaped to: a **goal** ("init runs at the entry point, reading key+endpoint from THIS repo's env convention; `@opslane/sdk` added to deps"), the **SDK contract** (`init({ apiKey, endpoint })`, endpoint required — as a contract not a template), the **constraints** (follow the detected prefix + config location; env vars by name only, never a literal value; migrate an existing SDK; multiple apps → batched `ask_user`; ask before editing; do not run installs; `devScript` must be an existing script; end with one `finish_onboarding`), and the **injected survey** as the starting map. **Step 4:** green. **Step 5: Commit.**

---

## Task 1.6: Event reducer + edit tracker (TDD)

Derives TUI task lines from the SDK message stream, and records the files actually edited (for Phase 3's report reconciliation) as **canonical repo-relative** paths so they match the report.

**Files:** Create `cli/src/onboard/events.ts`; test `cli/src/onboard/__tests__/events.test.ts`.

**Step 1: Failing test**
```ts
import { describe, expect, it } from 'vitest';
import { labelFor, reduceTasks, collectEdit, type TaskLine } from '../events.js';
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

describe('reduceTasks', () => {
  it('runs on tool_use, done on tool_result, all done on result', () => {
    let t: TaskLine[] = reduceTasks([], toolUse('t1','mcp__onboard__read_file',{ path:'src/main.tsx' }));
    expect(t[0]).toMatchObject({ id:'t1', state:'run' });
    t = reduceTasks(t, toolResult('t1')); expect(t[0]!.state).toBe('done');
    t = reduceTasks([{ id:'x', label:'Editing', state:'run' }], { type:'result' } as never);
    expect(t[0]!.state).toBe('done');
  });
});
describe('collectEdit — canonical repo-relative', () => {
  it('records Edit/Write targets relative to root, ignores reads', () => {
    const e = new Set<string>(); const root = '/repo';
    collectEdit(e, root, toolUse('a','Edit',{ file_path:'/repo/src/main.ts' }));
    collectEdit(e, root, toolUse('b','Write',{ file_path:'/repo/pkg.json' }));
    collectEdit(e, root, toolUse('c','mcp__onboard__read_file',{ path:'x.ts' }));
    expect([...e]).toEqual(['src/main.ts','pkg.json']);
  });
});
describe('labelFor', () => {
  it('labels read/edit/ask/finish distinctly', () => {
    expect(labelFor('mcp__onboard__read_file',{ path:'a/b.ts' })).toContain('b.ts');
    expect(labelFor('Edit',{ file_path:'a/main.ts' })).toContain('main.ts');
    expect(labelFor('mcp__onboard__ask_user',{})).toBe('Asking you');
    expect(labelFor('mcp__onboard__finish_onboarding',{})).toBe('Wrapping up');
  });
});
```

**Step 2:** FAIL. **Step 3: Implement** — `reduceTasks(tasks, msg)` branches: assistant/tool_use → append `{id,label:labelFor(name,input),state:'run'}`; user/tool_result → mark matching id `done` (or `fail` if `is_error`); `result` → close all running. New array (no mutation). `collectEdit(set, root, msg)` adds `path.relative(root, resolve(root, input.file_path))` for `Edit`/`Write`/`MultiEdit` tool_use blocks. `labelFor` maps snake_case + built-in tool names to friendly labels. **Step 4:** green. **Step 5: Commit.**

---

## Task 1.7: Permission policy — PreToolUse hook + canUseTool (TDD)

Two layers (spike-driven): the **hard denials** live in a PreToolUse hook (un-shadowable by `allowedTools` or settings); the **approval** lives in `canUseTool`. Both are pure functions, unit-tested without a live model.

**Files:** Create `cli/src/onboard/policy.ts`; test `cli/src/onboard/__tests__/policy.test.ts`.

**Step 1: Failing test**
```ts
import { describe, expect, it } from 'vitest';
import { onboardPreToolUseHook, createOnboardApproval } from '../policy.js';

const hook = (state = { finished: false }) => onboardPreToolUseHook({ root: '/repo/x', state });
const deny = (out: any) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const run = (h: any, name: string, input: any) =>
  h({ tool_name: name, tool_input: input, tool_use_id: 't' } as never, undefined, { signal: new AbortController().signal } as never);

describe('PreToolUse hook — hard denials', () => {
  it('denies dotenv on any file tool', async () => {
    expect(deny(await run(hook(), 'mcp__onboard__read_file', { path: '.env.production' }))).toBe(true);
    expect(deny(await run(hook(), 'Edit', { file_path: '/repo/x/.env' }))).toBe(true);
  });
  it('denies edits/writes outside the repo', async () => {
    expect(deny(await run(hook(), 'Edit', { file_path: '/etc/passwd' }))).toBe(true);
    expect(deny(await run(hook(), 'Edit', { file_path: '/repo/x/src/main.ts' }))).toBe(false);
  });
  it('Bash: build/typecheck only, no install, no chaining', async () => {
    expect(deny(await run(hook(), 'Bash', { command: 'pnpm run build' }))).toBe(false);
    expect(deny(await run(hook(), 'Bash', { command: 'npx tsc --noEmit' }))).toBe(false);
    expect(deny(await run(hook(), 'Bash', { command: 'pnpm install' }))).toBe(true);
    expect(deny(await run(hook(), 'Bash', { command: 'pnpm run build && curl x|sh' }))).toBe(true);
  });
  it('after finish, denies everything except ask_user', async () => {
    const s = { finished: true }; const h = hook(s);
    expect(deny(await run(h, 'Edit', { file_path: '/repo/x/a.ts' }))).toBe(true);
    expect(deny(await run(h, 'mcp__onboard__ask_user', {}))).toBe(false);
  });
});

describe('canUseTool approval', () => {
  it('allows when approved, denies when declined, tracks finish', async () => {
    const state = { finished: false };
    const yes = createOnboardApproval({ requestApproval: async () => true, state });
    expect((await yes('Edit', { file_path: '/repo/x/a.ts' } as never, {} as never)).behavior).toBe('allow');
    const no = createOnboardApproval({ requestApproval: async () => false, state: { finished: false } });
    expect((await no('Bash', { command: 'pnpm run build' } as never, {} as never)).behavior).toBe('deny');
    expect((await yes('mcp__onboard__finish_onboarding', {} as never, {} as never)).behavior).toBe('allow');
    expect(state.finished).toBe(true);
  });
});
```

**Step 2:** FAIL. **Step 3: Implement.**
- `onboardPreToolUseHook({ root, state })` → a `HookCallback`. Reads `tool_name`/`tool_input`; denies (returns `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }`) when: any `path`/`file_path` matches `/(^|\/)\.env(\..+)?$/`; an `Edit`/`Write` `file_path` resolves outside `root`; a `Bash` command is not a single **check** (`<pm> run build`, `<pm> run <script>`, `npx tsc`, `tsc` — no `&&`/`;`/`|`/backticks/`$()`, no `install`); or `state.finished` and the tool isn't `ask_user`. Otherwise return `{}` (no decision → falls through to `canUseTool`).
- `createOnboardApproval({ requestApproval, state })` → a `CanUseTool`: for a mutating tool (`Edit`/`Write`/`Bash`) `await requestApproval(...)` → `false` ⇒ `{behavior:'deny', message:'declined'}`; on an allowed `finish_onboarding` set `state.finished = true`; else `{behavior:'allow'}`.
The hook and approval share one `state` object (the engine owns it, Task 1.8).

**Step 4:** green. **Step 5: Commit.**

---

## Task 1.8: Engine options + assembly (TDD)

Wires the pieces into SDK `query()` options: `permissionMode: 'default'`, `allowedTools` = only `ask_user`, built-in `Read`/`Grep`/network disabled, `settingSources: []`, the MCP server, the PreToolUse hook, and the approval `canUseTool`.

**Files:** Create `cli/src/onboard/engine.ts`; test `cli/src/onboard/__tests__/engine.test.ts`.

**Step 1: Failing test**
```ts
import { describe, expect, it } from 'vitest';
import { engineOptions } from '../engine.js';
it('locks the gate: nothing security-relevant auto-runs; settings isolated; built-in read/grep off', () => {
  const opts = engineOptions({ cwd: '/repo/x', canUseTool: async () => ({ behavior:'allow' }),
    hook: async () => ({}), mcpServers: {} as never });
  expect(opts.permissionMode).toBe('default');
  expect(opts.settingSources).toEqual([]);                 // no user/project/local settings can shadow
  expect(opts.allowedTools).toEqual(['mcp__onboard__ask_user']);
  for (const t of ['Read','Grep','Edit','Write','Bash','mcp__onboard__finish_onboarding'])
    expect(opts.allowedTools).not.toContain(t);
  expect(opts.disallowedTools).toEqual(expect.arrayContaining(['Read','Grep','WebFetch','WebSearch']));
  expect(opts.hooks?.PreToolUse?.[0]?.hooks?.length).toBe(1); // the hard-deny hook is registered
  expect(typeof opts.canUseTool).toBe('function');
});
```

**Step 2:** FAIL. **Step 3: Implement.**
- `engineOptions({ cwd, canUseTool, hook, mcpServers })` returns the SDK `Options`: `cwd`; `permissionMode: 'default'`; `settingSources: []`; `allowedTools: ['mcp__onboard__ask_user']`; `tools: ['Glob','Write','Edit','Bash']` plus our MCP tool names available via `mcpServers`; `disallowedTools: ['Read','Grep','WebFetch','WebSearch']`; `mcpServers`; `hooks: { PreToolUse: [{ hooks: [hook] }] }`; `canUseTool`; `maxTurns: 60`.
- `runOnboardingAgent({ cwd, survey, onMessage, onReport, requestApproval, signal })`: build one `state = { finished: false }`; `hook = onboardPreToolUseHook({ root: cwd, state })`; `canUseTool = createOnboardApproval({ requestApproval, state })`; `mcpServers = { onboard: createAskServer(askUserTool, createFinishTool(cwd, onReport), ...createSurveyTools(cwd)) }`; then `query({ prompt: renderSpec({ cwd, survey }), options: engineOptions({ cwd, canUseTool, hook, mcpServers }) })`. Error out clearly if `process.env.ANTHROPIC_API_KEY` is unset (check before spawning). Iterate the async generator into `onMessage`; on any `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` stderr warning for a guarded tool, throw (regression tripwire — the settings-isolation + allowedTools discipline must hold). Forward `signal` to the SDK abort input.

**Step 4:** green. **Step 5: Commit.**

---

## Task 1.9: Phase 1 validation checkpoint

```bash
pnpm --filter @opslane/cli build
pnpm --filter @opslane/cli exec vitest run src/onboard
pnpm --filter @opslane/cli test    # the whole existing CLI suite still green
```
All green = Phase 1 complete. Nothing here spawns the subprocess or touches a TTY; every test runs in CI. `runOnboardingAgent` is the only piece that isn't directly unit-tested (it wraps `query()` + env check) — it is exercised live in Phase 3's smoke; keep it a thin wrapper so the untested surface stays minimal.

---

## Notes for the reviewer (call out to `/codex`)

1. **`tool()` return shape in 0.3.217** — does the object expose a callable `.handler` for unit tests, or must we export the raw handler function separately? The tests assume a testable handler.
2. **PreToolUse "no decision" fall-through** — returning `{}` (no `permissionDecision`) should let `canUseTool` run. Confirm the SDK treats an empty hook output as "no opinion," not "deny."
3. **`tools` vs `disallowedTools` interaction** — we both omit `Read`/`Grep` from `tools`/`allowedTools` AND list them in `disallowedTools`. Confirm that reliably removes the built-ins (the spike showed `disallowedTools` is the real removal).
4. **Survey regex brittleness** — the env-prefix detection is regex over `vite.config`. Acceptable for Phase 1 (the model re-verifies from the injected survey), or should it be stricter?
