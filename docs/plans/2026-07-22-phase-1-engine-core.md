# Phase 1 — Onboard Detect Stage (read-only)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the **Detect stage** of `opslane onboard` — a *read-only* agent that inspects a repo and reports a structured wiring **plan** (`report_plan`), making no edits. Validated by an eval over real OSS monorepos, plus unit tests. No live model in unit tests, no TTY.

**Why two stages (decided 2026-07-23, from a live eval).** The onboard agent was first built as one loop that investigates *and* edits. We split it into **Detect → Apply**:
- **Detect** (this phase): read-only. Tools are `Read`, `Glob`, our secret-aware `search`, `ask_user`, and `report_plan`. **Edit/Write/Bash are not in the toolset at all** — the stage is physically incapable of changing a file. It outputs a plan the user (or the Apply stage) consumes.
- **Apply** (next phase): given an approved plan, makes exactly those edits and records them.

The split makes each prompt narrow (more reliable), gives a natural human-approval point before any file changes, lets each stage be evaluated separately, and makes Apply so scoped it could later be a codemod. A read-only detect eval over 5 real OSS monorepos (calcom, supabase, directus, excalidraw, twenty) scored **5/5** on app selection, framework, package manager, env prefix, existing-SDK detection, and naming — see Task 1.8.

**Shared substrate (reused by BOTH stages, mostly already built):** `paths.ts` (symlink-safe containment + `.env*` policy), `search-tool.ts` (secret-aware search), `policy.ts` (PreToolUse containment/secret hook), `tools.ts` `ask_user`, and the engine core in `engine.ts` (cancellation, warning tripwire, terminal-result mapping, injectable `queryFn`). The engine runs under `permissionMode: 'default'`, `settingSources: []`, `strictMcpConfig: true`.

**Verified SDK facts (0.3.217, `sdk.d.ts` + spikes + codex review):**
- `permissionMode: 'default'` consults `canUseTool` for any tool NOT in `allowedTools`; `bypassPermissions` and bare `allowedTools` entries shadow it.
- Hooks: `hooks: { PreToolUse: [{ hooks: [cb] }] }`; `cb(input, id, {signal}) => Promise<HookJSONOutput>`; deny via `{ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'deny', permissionDecisionReason } }`; `{}` = "no opinion", falls through to `canUseTool` (hook runs before permission resolution).
- `canUseTool(name, input, {signal}) => Promise<{behavior:'allow'} | {behavior:'deny', message}>`.
- `settingSources: []` loads no user/project/local settings; `strictMcpConfig: true` loads no external MCP.
- `createSdkMcpServer({name, version, tools})`; `tool(name, desc, zodShape, handler)` — the SDK wraps the shape in a Zod object that **strips** unknown keys before the handler; `.handler` is callable for unit tests.
- Cancellation is via `options.abortController`. The `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning is a parent-process `process.emitWarning`.

**Tech Stack:** TypeScript (ESM, strict), Node 22, `@anthropic-ai/claude-agent-sdk@0.3.217`, `zod@^4.0.0`, Vitest colocated in `__tests__`. All new code in `cli/src/onboard/`.
**Deferred to the TUI phase:** `ink`, `react`, `@inkjs/ui`, `@types/react`.

**Out of scope for Phase 1:** the Apply stage (edits, `finish_onboarding`, `EditTracker` reconciliation), the Ink TUI, provisioning, the CLI command. Apply is outlined at the end of this doc as the next phase.

---

## Task 1.0: Shared path + secret-file policy (TDD)

One module so containment and the `.env*` rule can't drift across `report_plan`, `search`, and the hook.

**Files:** Create `cli/src/onboard/paths.ts`; test `__tests__/paths.test.ts`.

**Implement.**
- `isSecretFile(p)`: `path.basename(p).startsWith('.env')` — catches `.env`, `.env.*`, `.env-*`, `.envrc`.
- `containedRepoRelative(root, p)`: normalize; resolve `p` against `root`; `realpath` the target if it exists, else `realpath` the nearest existing ancestor and append the rest; throw `outside repo` unless the resolved path is `realRoot` or under `realRoot + sep`; return `path.relative(realRoot, resolved)`. Symlink-safe.

**Test** (real `mkdtemp` fixtures + a symlink to outside): `isSecretFile` true for every dotenv shape incl `.envrc`/`.env-example`; `containedRepoRelative` returns the repo-relative path for in-root paths (incl `..`-normalized and not-yet-created files), throws for `/etc/passwd` and a symlink alias.

**Commit** — `feat(cli): shared onboard path + secret-file policy`

---

## Task 1.1: Dependencies + discoverable colocated tests

**Files:** Modify `cli/package.json`, `cli/vitest.config.ts`.

- **Blocking:** `cli/vitest.config.ts` `include` must be `['src/**/*.test.ts']` (the original `src/__tests__/**` never discovers `src/onboard/__tests__/`).
- Add deps: `@anthropic-ai/claude-agent-sdk@0.3.217`, `zod@^4.0.0`; `"engines": { "node": ">=22" }`. Do NOT add ink/react/@inkjs/ui.
- `pnpm install`; if `scripts/check-licenses.mjs` flags the SDK's `SEE LICENSE IN README.md`, allowlist it citing `docs/decisions/anthropic-agent-sdk-terms.md`.
- `pnpm --filter @opslane/cli build` green. **Commit.**

---

## Task 1.2: `ask_user` (shared) + `report_plan` (Detect) MCP tools (TDD)

Per-run factory, no module globals. `report_plan` is the Detect stage's single output. The plan is untrusted; the handler validates every value. The SDK's Zod object strips unknown keys, so validation targets the known fields.

**Files:** Create `cli/src/onboard/tools.ts`; test `__tests__/tools.test.ts`.

**The plan is a typed, machine-applicable artifact — not prose (codex P1.1).** The Detect eval showed the model naturally emits a narrative `init_snippet` ("place before the existing init() call, around line 22", plus optional error-handler suggestions). That is not something Apply (or a codemod) can apply deterministically, and a single string cannot say whether an existing SDK is kept or replaced. So `report_plan` captures a structured `OnboardingPlan`:

```ts
interface OnboardingPlan {
  app_dir: string;                 // repo-relative, canonical
  framework: string;
  package_manager: 'npm'|'pnpm'|'yarn'|'bun';
  env_prefix: string;              // e.g. 'VITE_', 'NEXT_PUBLIC_'
  dependency: { name: '@opslane/sdk'; version: string };
  env_vars: { api_key: string; endpoint: string };  // each starts with env_prefix + carries OPSLANE
  edit: {
    file: string;                  // repo-relative, canonical, exists, under app_dir
    entry_hash: string;            // sha256 of `file` at detect time (Apply re-hashes; stale → stop + re-detect)
    import_line: string;           // exact code
    init_block: string;            // exact code
    anchor: string;                // an exact substring that occurs in `file`
    position: 'before'|'after';
    occurrence: number;            // which match of `anchor` (0-based)
  };
  existing_sdk: { action: 'keep'|'migrate'|'no_op'; name: string|null };  // keep=coexist, migrate=replace, no_op=Opslane already present
  rationale: string;               // free-text notes — NON-executable, separate from the edit
}
```

This resolves the keep-vs-migrate ambiguity explicitly (current code says "migrate", the Detect eval said "coexist" — now it is a declared field), and gives Apply an anchor + hash instead of prose.

**Implement.**
- `createAskUserTool(resolver)`: `tool('ask_user', desc, { question: z.string(), options: z.array(z.string()).min(1), multi: z.boolean().default(false) }, handler)`; handler calls this run's `resolver` (throws if `null`).
- `createReportPlanTool(root, onPlan)` — the Detect stage's single output. State-guarded: **a second call is rejected** (`already reported`, codex P1.2). The handler validates (reject → the model retries, codex P1.3):
  1. every string field non-empty;
  2. `app_dir` and `edit.file` pass `containedRepoRelative(root, …)` (store the canonical result) **and** are not `isSecretFile`;
  3. `edit.file` **exists, is a regular file, and is under `app_dir`**;
  4. `package_manager` ∈ the enum; `existing_sdk.action` ∈ the enum;
  5. `env_vars.api_key`/`.endpoint` match `/^[A-Z][A-Z0-9_]*$/`, **start with `env_prefix`**, and contain the bounded `OPSLANE` token (`/(?:^|_)OPSLANE(?:_|$)/`);
  6. `edit.anchor` occurs in `edit.file` at least `occurrence+1` times, and `edit.entry_hash` equals the sha256 of `edit.file` now (Detect read the file, so it can assert both);
  7. on success call `onPlan(plan)` **with canonicalized paths**, mark reported, return a confirmation.
- **No `dev_script` field** (codex P1.6): Apply does not run the app (it only runs allowlisted build/typecheck/lint), so a run command is not needed, and a free command string is an injection vector. If a later phase needs it, model it as `{ manifest_path, script_name }` validated against that manifest's `scripts` and executed via `spawn(pm, ['run', script], { shell:false })` — never a raw string.
- Export `OnboardingPlan` and `createOnboardServer(...tools) = createSdkMcpServer({ name:'onboard', version:'0.0.0', tools })`.

**Test** (real `mkdtemp` app fixture with a real entry file): `ask_user` routes to its resolver / throws with none; `report_plan` accepts a valid plan and calls `onPlan` once; a **second** call rejects (`/already/i`); rejects empty fields, a path escape, a secret `edit.file`, an `edit.file` outside `app_dir` or that doesn't exist, a var not starting with `env_prefix`, a borrowed name (`VITE_APP_DEFENDER_API_KEY` → `/opslane/i`), an unknown `package_manager`, a wrong `entry_hash`, and an `anchor` absent from the file. Wiring test: `createOnboardServer(createReportPlanTool(...))` registers `report_plan` with an input schema.

**Commit.**

---

## Task 1.3: Secret-aware `search` tool (TDD)

Replaces built-in `Grep` (which returns `.env` content). Literal substring, bounded.

**Files:** Create `cli/src/onboard/search-tool.ts`; test `__tests__/search-tool.test.ts`.

**Implement** `createSearchTool(root)` — `tool()` with `{ query: z.string().min(1), glob: z.string().optional() }`. Walk `root` (skip `.git`/`node_modules`, any `isSecretFile`, symlinks leaving root via `containedRepoRelative`); literal substring match; skip binary (NUL in first 8KB) and over-cap files; stop at total-bytes and max-results caps; emit `repoRel:line`. **Test:** a string only in `.env.production` returns nothing; normal source hit returns `path:line`; binary/`node_modules` skipped; caps enforced. **Commit.**

---

## Task 1.4: Detect spec — `renderDetectSpec` (TDD)

The read-only prompt. Goal + investigate-first + report-only, no editing. Bakes in no filename, framework, or prefix — the agent reads those from the repo (live-validated: it matched `VITE_`, `VITE_APP_`, `REACT_APP_`, and `NEXT_PUBLIC_` across five real repos without being told).

**Files:** Create `cli/src/onboard/spec.ts`; test `__tests__/spec.test.ts`.

**Implement** `renderDetectSpec({ cwd })` — a string with:
- **Goal:** inspect the repo at `cwd` and REPORT how `@opslane/sdk` should be wired in. "You have no edit tools; only read and report."
- **Investigate:** find the one web app to onboard (if a monorepo has several, pick the primary user-facing web app; if genuinely ambiguous, `ask_user` with `multi:false`); its framework; the real entry point; the env-var naming convention (the prefix this app uses); the package manager (from the lock file); and any error/monitoring SDK already installed (Sentry, PostHog, `@defender-dev/sdk`, `@opslane/sdk`, …).
- **Report:** call `report_plan` exactly once. Name the Opslane vars after Opslane using THIS app's own prefix (e.g. `VITE_OPSLANE_API_KEY`, `NEXT_PUBLIC_OPSLANE_API_KEY`); never after another product in the repo. Provide the exact `init` snippet, placed to coexist with any existing SDK. Base every field on what the files show.

**Test:** `renderDetectSpec({cwd:'/repo/x'})` contains `/repo/x`; mentions `read`, `report_plan`, `ask_user`, single-app selection, the OPSLANE naming guard, and "use the repo's own prefix"; and states it has no edit tools. (Do **not** assert `not.toContain('VITE_OPSLANE_')` — the prompt now uses `VITE_OPSLANE_API_KEY` as an *example*, so that assertion contradicts the prompt, codex P1.4. The "no baked convention" property is behavioral — proven by the eval matching each repo's own prefix — not by a substring check.)

**Commit.**

---

## Task 1.5: Event reducer (shared progress) (TDD)

Drives task lines for the eventual TUI, both stages. (The ordered `EditTracker` belongs to the Apply stage — it tracks edit commit order to reject edits after finish — and is deferred to that phase.)

**Files:** Create `cli/src/onboard/events.ts`; test `__tests__/events.test.ts`.

**Implement** `reduceTasks(tasks, msg)` — iterate every content block; `tool_use` → append `run`; `tool_result` → mark id `done`, or `fail` on `is_error`; a `result` msg with an error subtype → all running `fail`, clean `result` → `done`. New array. `labelFor(name)` → friendly labels. **Test:** multi-block message, fail on error result, all-fail on error result msg. **Commit.**

---

## Task 1.6: Read-only permission policy — hook (TDD)

The hook applies containment to every path-bearing tool. For Detect there are no edit tools, so the hook's job is: keep `Read`/`Glob` inside the repo and off `.env*`. (The edit-gating `canUseTool` approval and post-finish denial belong to the Apply stage.)

**Files:** Create `cli/src/onboard/policy.ts`; test `__tests__/policy.test.ts`.

**Implement** `onboardPreToolUseHook({ root })` → a `HookCallback` that denies when a path-bearing tool (`Read`/`Glob`/`Edit`/`Write`/`MultiEdit`) has a `path`/`file_path`/`pattern` that fails `containedRepoRelative(root, …)` (throws → deny) or is `isSecretFile`; otherwise `{}`. (Edit/Write/MultiEdit are handled here too so the same hook serves the Apply stage unchanged; Detect simply never offers them.) `createOnboardApproval({ requestApproval })` is Apply-only — carry it in this module but it is exercised in the Apply phase.

**Test** (real `mkdtemp` root + symlink to outside): denies `/etc/passwd`, `${root}/../out`, and a symlink alias on `Read` and `Glob`; allows an in-root source file; denies `.env.production` and `.envrc` on `Read`.

**Known limit (codex P2.2):** the hook validates the *requested* `Glob` pattern, not each returned match. A broad in-root glob (e.g. `**/*`) can therefore enumerate `.env*` *filenames* (never contents — a follow-up `Read` is denied). Filenames are low-sensitivity, but if we want to close it, filter `isSecretFile` paths out of `Glob` results in a `PostToolUse` hook. Note this as an accepted limitation for Phase 1.

**Commit.**

---

## Task 1.7: Engine core + `runDetect` (TDD)

The engine core holds the failure-prone seams — so it takes an injectable `queryFn` and is unit-tested with an async-generator stub (no model, no subprocess). `runDetect` is the read-only wrapper.

**Files:** Create `cli/src/onboard/engine.ts`; test `__tests__/engine.test.ts`.

**Implement.**
- `detectOptions({ cwd, hook, mcpServers, abortController })`: `cwd`; `permissionMode:'default'`; `settingSources:[]`; `strictMcpConfig:true`; `allowedTools:['mcp__onboard__report_plan','mcp__onboard__ask_user']`; `tools:['Read','Glob']`; `disallowedTools:['Grep','Write','Edit','MultiEdit','Bash','WebFetch','WebSearch']`; `mcpServers`; `hooks:{PreToolUse:[{hooks:[hook]}]}`; **`canUseTool` is default-deny** (codex P2.1): allow only `Read` and `Glob`, deny anything else with a message — so a tool we forgot to `disallow` cannot slip through; `abortController`; `maxTurns:50`.
- `runDetect({ cwd, onMessage, onPlan, signal, askUser = null, queryFn = query })`:
  - if no `ANTHROPIC_API_KEY` → `{ ok:false, reason:'no_api_key' }` (never queries).
  - **Wrap `onPlan` to count captures** (codex P1.2): `let plans = 0; const capture = (p) => { plans++; onPlan(p); }`. `report_plan`'s own state-guard rejects a second call, but `runDetect` additionally requires `plans === 1` for success.
  - `hook = onboardPreToolUseHook({ root:cwd })`; `mcpServers = { onboard: createOnboardServer(createReportPlanTool(cwd, capture), createAskUserTool(askUser), createSearchTool(cwd)) }`.
  - Cancellation: own `AbortController ac`; if `signal.aborted` already, `ac.abort()`, else one-shot listener → `ac.abort()`.
  - Warning tripwire (safe): `process.on('warning', onWarn)`; on an *unexpected* shadow (not the intentional `report_plan`/`ask_user` allowlist shadows) store the error and `ac.abort()` — never throw in the listener.
  - `try`: iterate `queryFn({ prompt: renderDetectSpec({cwd}), options: detectOptions({cwd, hook, mcpServers, abortController: ac}) })` into `onMessage`, capture terminal `result` subtype. `catch`: map a thrown error to `{ok:false, reason: err.message}`. `finally`: remove `onWarn` + the signal listener.
  - Return `{ ok, aborted, subtype, reason }`: `ok:true` only on a clean `result` **AND `plans === 1`** (a validated plan was captured — codex P1.2: a clean terminal subtype with zero or two reports is NOT success, reason `no_plan`/`multiple_plans`); `ok:false` on shadow error, caught error, abort, missing result, or an error subtype.

**Test:** `detectOptions` locks the gate (`permissionMode:'default'`, `settingSources:[]`, `strictMcpConfig:true`, no `Edit`/`Write`/`Bash` in `tools`, `Read` not disallowed; `canUseTool` denies a tool other than Read/Glob); `beforeAll` sets a dummy key (restored after) so lifecycle cases run hermetically; `runDetect` maps a clean result **with one plan** → `ok:true`, a clean result with **zero** plans → `ok:false` (`no_plan`), an error/missing result → `ok:false`, a thrown `queryFn` → `ok:false` (no rethrow), an already-aborted signal → `aborted:true`, missing key → `no_api_key` without querying (assert `queryFn` not called). Stub `queryFn` yields a synthetic `report_plan` tool-use in the message stream to drive the one-plan path.

**Commit.**

---

## Task 1.8: Detect validation — unit checkpoint + real-repo eval

**Unit gate:**
```bash
pnpm --filter @opslane/cli build
pnpm --filter @opslane/cli exec vitest run src/onboard
pnpm --filter @opslane/cli test    # whole CLI suite still green
```

**Live eval (required — standing preference: exercise the real system).** `cli/scripts/detect-eval.mjs` runs `runDetect` against real cloned repos and prints the plan per repo. It is read-only (no edit tools exist), so it is safe to run against clones in place.
```bash
export ANTHROPIC_API_KEY=...           # e.g. from ~/Projects/opslane/opslane-oss/.env
pnpm --filter @opslane/cli build
node cli/scripts/detect-eval.mjs /path/to/repoA /path/to/repoB ...
```
**Honest status of the current eval (codex P1.7).** The 2026-07-23 run was a **smoke test, not decision-grade**. The script's *automatic* checks are only: terminal success, the reported `entry_file` exists, and the vars carry `OPSLANE`. The per-field correctness (right app / framework / package manager / prefix / existing SDK) was scored **by hand** against a ground-truth table — the script does not assert it, so a wrong app/prefix would still print `ALL PLANS OK`. And it ran the **inlined spike prompt**, not the production `runDetect`, and auto-picked the first `ask_user` option. Treat the result below as promising signal, not proof.

Result of that smoke run (hand-scored), read-only detect over five popular OSS monorepos:

| repo | app | framework | pkg mgr | prefix | existing SDK |
|---|---|---|---|---|---|
| calcom | apps/web | nextjs | yarn | NEXT_PUBLIC_ | Sentry+PostHog |
| supabase | apps/studio | nextjs | pnpm | NEXT_PUBLIC_ | Sentry |
| directus | app | vue-vite | pnpm | VITE_ | none |
| excalidraw | excalidraw-app | react-vite | yarn | VITE_APP_ | Sentry |
| twenty | packages/twenty-front | react-vite | yarn | REACT_APP_ | Sentry |

5/5 on every hand-scored dimension, entry files verified, no `ask_user` needed; it chose Next's `instrumentation-client.ts` and read twenty's `REACT_APP_` from its Vite config.

**Decision-grade eval (what to build before trusting a pass rate — codex P1.7):**
- run the **production `runDetect`**, not the inlined spike;
- **pinned repo SHAs** + a per-repo expected-fields fixture; **per-field** scoring (not one PASS/repo) and whole-plan scoring;
- **5 independent runs per case**; report the distribution, not "5/5 repos";
- assert exactly one report and a **uniquely resolvable edit** (anchor found exactly at `occurrence`);
- **case coverage:** an ambiguous repo where the right answer is `ask_user`; an unsupported repo (no web app); a repo that already has `@opslane/sdk` (`no_op`); conflicting lockfiles / conflicting prefixes; a repo with **malicious instructions** in a README/source comment (prompt-injection); a **symlink escape**; a planted `.env` secret;
- **zero safety failures** required: a **pre/post repository tree hash** (codex P2.1) must be identical — proving the read-only stage wrote nothing — and the `.env` canary must never appear in the transcript.

---

## Next phase — Apply Stage (outline, not this phase)

Consumes an approved `OnboardingPlan` and makes exactly those edits.
- **Tools:** `Read`, `Edit`, `Write` (no `Glob`/`search` needed — the plan already located everything); `Bash` only for the allowlisted `run build|typecheck|lint`; `finish_onboarding`.
- **Apply consumes the typed `OnboardingPlan`, not prose.** It re-hashes `edit.file`; if `edit.entry_hash` no longer matches, it **stops and re-detects** (the repo changed under it). It finds `edit.anchor` at `edit.occurrence`; if the anchor is missing or ambiguous, it stops. It inserts `edit.import_line` + `edit.init_block` `edit.position` the anchor, applies `dependency` to the manifest, and honors `existing_sdk.action` (`keep`/`migrate`/`no_op`). `rationale` is never executed.
- **Prompt (if a model is used):** `renderApplySpec({ cwd, plan })` — "apply ONLY the operations in this plan, change nothing else," then `finish_onboarding` with the edited files. Because the plan is fully typed, Apply is a strong candidate for a **deterministic codemod** (no model) — evaluated separately.
- **Policy:** the same `onboardPreToolUseHook` (now gating real `Edit`/`Write`) + `createOnboardApproval` (per-tool approval) + post-`finish` denial; `finish_onboarding` validation (single app, OPSLANE token, containment) and the ordered `EditTracker` reconciliation (reject edits at/after finish).

---

## Migration from the combined loop (codex P1.5)

The committed code (`587bd93`) is the single combined loop. This plan renames/repurposes it — spell out the moves so nothing dangles:

| Current (combined) | Becomes | Note |
|---|---|---|
| `renderSpec({cwd})` | `renderDetectSpec({cwd})` | read-only wording; Apply gets its own `renderApplySpec` |
| `finish_onboarding` + `OnboardingReport` | `report_plan` + `OnboardingPlan` (Detect); `finish_onboarding` returns in the Apply phase | Detect reports a plan, not a completion |
| `runOnboardingAgent(...)` | engine core + `runDetect(...)` wrapper; `runApply(...)` later | shared lifecycle (cancellation, tripwire, result mapping, injectable `queryFn`) stays |
| `engineOptions(...)` | `detectOptions(...)` (read-only) + `applyOptions(...)` later | tool lists differ per stage |

- **Hook signature:** keep `onboardPreToolUseHook({ root, state? })` — `root` required, `state` **optional**. Detect passes no `state` (no edits, no post-finish rule); Apply passes `state` to get post-finish denial. One hook serves both; do not fork it.
- **Combined-loop tests + `cli/scripts/live-onboard-check.mjs`** target `runOnboardingAgent`/`finish_onboarding`. When Detect lands, either (a) keep them and repoint at `runApply` once Apply exists, or (b) delete the combined-loop path outright. Pick (b) unless we still want an end-to-end combined smoke; the plan assumes the combined loop is **replaced**, not kept in parallel.
- **Live run:** drive Detect → (approve) → Apply against a throwaway copy of a real app; confirm the SDK is wired at the planned entry with the planned vars, dep added, `.env` untouched.
