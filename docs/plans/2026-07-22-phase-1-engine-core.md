# Phase 1 — Onboard Detect Stage (read-only)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the **Detect stage** of `opslane onboard` — a *read-only* agent that inspects a repo and reports a structured wiring **plan** (`report_plan`), making no edits. Validated by an eval over real OSS monorepos, plus unit tests. No live model in unit tests, no TTY.

**Latency budget (eng-review Issue 3):** the whole onboarding flow — Detect, human approval, Apply — targets **under 10 minutes**. Detect's share should stay in the low minutes. `maxTurns:50` is a safety stop, not a time budget, so the eval **reports wall-clock elapsed per repo** to make regressions visible (observed on the smoke run: 41–89s, 11–31 tool calls). No hard timeout — a run that is slow but correct beats a run killed 20 seconds from the answer.

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

**Out of scope for Phase 1:** the Apply stage (edits, `finish_apply`, exact verification, rollback, and `EditTracker` reconciliation), the Ink TUI, provisioning, the CLI command. Apply is outlined at the end of this doc as the next phase.

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

**Not every repo can be onboarded (eng-review Issue 1).** Some repos have no web app at all (a pure Go service, a CLI, a docs site). `report_plan` therefore takes a **status discriminant**, so "nothing to onboard here" is a first-class, testable outcome rather than a fabricated plan or a `maxTurns` timeout:

```ts
type ReportPlanInput =
  | { status: 'ok'; plan: OnboardingPlan }
  | { status: 'unsupported'; reason: string };   // e.g. "no web app: only Go services and docs"
```
The full-plan validation below runs **only** when `status === 'ok'`. For `'unsupported'`, validate a non-empty `reason` and nothing else. `runDetect` maps `'unsupported'` to a distinct outcome (`ok:false, reason:'unsupported'`) that the CLI can report as "this repo has no app to onboard" — never conflated with an error or a timeout.

```ts
interface OnboardingPlan {
  app_dir: string;                 // repo-relative, canonical
  framework: string;
  package_manager: 'npm'|'pnpm'|'yarn'|'bun';
  env_prefix: string;              // e.g. 'VITE_', 'NEXT_PUBLIC_'
  dependency: { name: '@opslane/sdk'; version: string }; // HOST-PINNED, never model-supplied
  env_vars: { api_key: string; endpoint: string };  // each starts with env_prefix + carries OPSLANE
  edit: {
    file: string;                  // repo-relative, canonical, exists, under app_dir
    entry_hash: string;            // HOST-DERIVED, never model-supplied. The Detect agent has only
                                   // Read/Glob/search and cannot compute a sha256 - requiring it made
                                   // report_plan unsatisfiable and starved runs of a plan (found in QA).
                                   // The tool stamps it from the file it already reads. Apply re-hashes;
                                   // stale -> stop + re-detect.
    manifest_file: string;         // model-selected canonical package.json under app_dir
    manifest_hash: string;         // HOST-DERIVED; Apply re-hashes before any model call
    import_line: string;           // exact code; Apply places at module top-level import section
    init_block: string;            // exact code; the fields below locate this block only
    anchor: string;                // one complete line's non-whitespace content; init only
    position: 'before'|'after';
    occurrence: number;            // which match of `anchor` (0-based)
  };
  existing_sdk: { action: 'none'|'keep'|'migrate'|'no_op'; name: string|null };  // Apply refuses migrate; no_op requires mechanical confirmation
  rationale: string;               // free-text notes — NON-executable, separate from the edit
}
```

This resolves the keep-vs-migrate ambiguity explicitly (current code says "migrate", the Detect eval said "coexist" — now it is a declared field), and gives Apply an anchor + hash instead of prose.

**Implement.**
- `createAskUserTool(resolver)`: `tool('ask_user', desc, { question: z.string(), options: z.array(z.string()).min(1), multi: z.boolean().default(false) }, handler)`; handler calls this run's `resolver` (throws if `null`).
- `createReportPlanTool(root, onPlan)` — the Detect stage's single output. State-guarded: **a second call is rejected** (`already reported`, codex P1.2). The handler validates (reject → the model retries, codex P1.3):
  1. every string field non-empty;
  2. `app_dir`, `edit.file`, and `edit.manifest_file` pass `containedRepoRelative(root, …)` (store canonical results) and are not secret paths;
  3. both edit files exist and are non-symlink regular files under `app_dir`; the manifest is a valid `package.json`;
  4. `package_manager` ∈ the enum; `existing_sdk.action` ∈ the enum;
  5. `env_vars.api_key`/`.endpoint` match `/^[A-Z][A-Z0-9_]*$/`, **start with `env_prefix`**, and contain the bounded `OPSLANE` token (`/(?:^|_)OPSLANE(?:_|$)/`);
  6. `edit.anchor` occurs in `edit.file` at least `occurrence+1` times;
  7. host code stamps both file hashes and the reviewed SDK version, ignoring any model-supplied version;
  8. on success call `onPlan(plan)` with canonicalized paths, mark reported, return a confirmation.
- **No `dev_script` field** (codex P1.6): Apply does not run the app or any shell command, so a run command is not needed, and a free command string is an injection vector. If a later phase needs it, model it as `{ manifest_path, script_name }` validated against that manifest's `scripts` and executed via `spawn(pm, ['run', script], { shell:false })` — never a raw string.
- Export `OnboardingPlan` and `createOnboardServer(...tools) = createSdkMcpServer({ name:'onboard', version:'0.0.0', tools })`.

**Test** (real `mkdtemp` app fixture with a real entry file): `ask_user` routes to its resolver / throws with none; `report_plan` accepts a valid `status:'ok'` plan and calls `onPlan` once; a **second** call rejects (`/already/i`); rejects empty fields, a path escape, a secret `edit.file`, an `edit.file` outside `app_dir` or that doesn't exist, a var not starting with `env_prefix`, a borrowed name (`VITE_APP_DEFENDER_API_KEY` → `/opslane/i`), an unknown `package_manager`, a wrong `entry_hash`, and an `anchor` absent from the file. **Discriminant tests (eng-review Issue 1):** `status:'unsupported'` with a non-empty `reason` is accepted **without** any plan fields; `status:'unsupported'` with an empty/missing `reason` rejects; `status:'ok'` without a full plan rejects. Wiring test: `createOnboardServer(createReportPlanTool(...))` registers `report_plan` with an input schema.

**Commit.**

---

## Task 1.3: Secret-aware `search` tool (TDD)

Replaces built-in `Grep` (which returns `.env` content). Literal substring, bounded.

**Files:** Create `cli/src/onboard/search-tool.ts`; test `__tests__/search-tool.test.ts`.

**Implement** `createSearchTool(root)` — `tool()` with `{ query: z.string().min(1), glob: z.string().optional() }`. Walk `root` (skip `.git`/`node_modules`, any `isSecretFile`, symlinks leaving root via `containedRepoRelative`); literal substring match; skip binary (NUL in first 8KB) and over-cap files; stop at total-bytes and max-results caps; emit `repoRel:line`. **Test:** a string only in `.env.production` returns nothing; normal source hit returns `path:line`; binary/`node_modules` skipped; caps enforced; **a symlink pointing outside `root` is not traversed** (eng-review test gap — the implementation claims this, so assert it: plant `root/link -> /etc` with a match target behind it and expect zero results). **Commit.**

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

**Test:** `detectOptions` locks the gate (`permissionMode:'default'`, `settingSources:[]`, `strictMcpConfig:true`, no `Edit`/`Write`/`Bash` in `tools`, `Read` not disallowed; `canUseTool` denies a tool other than Read/Glob); `beforeAll` sets a dummy key (restored after) so lifecycle cases run hermetically; `runDetect` maps a clean result **with one plan** → `ok:true`, a clean result with **zero** plans → `ok:false` (`no_plan`), a clean result with **two** plans → `ok:false` (`multiple_plans`, eng-review test gap — the reason is named in the impl, so assert it), a `status:'unsupported'` report → `ok:false` with reason `unsupported` and **distinct from any error path** (eng-review Issue 1), an error/missing result → `ok:false`, a thrown `queryFn` → `ok:false` (no rethrow), an already-aborted signal → `aborted:true`, missing key → `no_api_key` without querying (assert `queryFn` not called). Stub `queryFn` yields a synthetic `report_plan` tool-use in the message stream to drive the plan paths.

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
- run the **production `runDetect`**, not the inlined spike. **Then DELETE the spike copies** (eng-review Issue 4): `cli/scripts/detect-eval.mjs:37` defines its own `DETECT_PROMPT` and `:60` its own `report_plan` tool. Once `renderDetectSpec` and `createReportPlanTool` exist, the script must import them and those two inlined definitions must be removed. Leaving them is a DRY violation in a *measuring instrument* — the eval would silently score a stale prompt while a different one ships, which is exactly how the current 5/5 came from the spike rather than production code;
- **not a CI gate** (eng-review perf): 5 runs × ~8 cases × 40–90s is roughly 40–60 minutes of wall-clock plus real token spend per full pass. Run it nightly or before a release, never per-commit. The unit gate above is the per-commit gate;
- **pinned repo SHAs** + a per-repo expected-fields fixture; **per-field** scoring (not one PASS/repo) and whole-plan scoring;
- **5 independent runs per case**; report the distribution, not "5/5 repos";
- assert exactly one report and a **uniquely resolvable edit** (anchor found exactly at `occurrence`);
- **case coverage:** an ambiguous repo where the right answer is `ask_user`; an unsupported repo (no web app); a repo that already has `@opslane/sdk` (`no_op`); conflicting lockfiles / conflicting prefixes; a repo with **malicious instructions** in a README/source comment (prompt-injection); a **symlink escape**; a planted `.env` secret;
- **zero safety failures** required: a **pre/post repository tree hash** (codex P2.1) must be identical — proving the read-only stage wrote nothing — and the `.env` canary must never appear in the transcript.

---

## Next phase — Apply Stage (outline, not this phase)

Consumes an approved `OnboardingPlan` and makes exactly those edits.
- **Tools:** `Read`, `Edit`, `Write`, and `finish_apply`; no `Glob`, search, `MultiEdit`, or Bash.
- **Apply consumes the typed `OnboardingPlan`, not prose.** It contains/stats/hashes both edit files before querying; checks the init anchor; snapshots both; places `import_line` in the module import section, places `init_block` at its own anchor, and adds the host-pinned dependency to `manifest_file`. `migrate` is refused; `no_op` is returned only after structural confirmation.
- **Prompt:** `renderApplySpec({ cwd, plan })` says to apply only the approved operations and end with `finish_apply`.
- **Policy and proof:** the hook allows writes to exactly the two canonical files, approvals fail closed, `EditTracker` reconciles settlement order, and `verifyApplied` proves the exact entry/manifest deltas before the external report is emitted. Every handled failure attempts byte-identical rollback. Success reports that an install is still required and gives a host-derived command.

---

## Migration from the combined loop (codex P1.5)

The committed code (`587bd93`) is the single combined loop. This plan renames/repurposes it — spell out the moves so nothing dangles:

| Current (combined) | Becomes | Note |
|---|---|---|
| `renderSpec({cwd})` | `renderDetectSpec({cwd})` | read-only wording; Apply gets its own `renderApplySpec` |
| `finish_onboarding` + `OnboardingReport` | `report_plan` + `OnboardingPlan` (Detect); `finish_apply` terminates Apply | Detect reports a plan, not a completion |
| `runOnboardingAgent(...)` | engine core + `runDetect(...)` wrapper; `runApply(...)` later | shared lifecycle (cancellation, tripwire, result mapping, injectable `queryFn`) stays |
| `engineOptions(...)` | `detectOptions(...)` (read-only) + `applyOptions(...)` later | tool lists differ per stage |

- **Hook signature:** `onboardPreToolUseHook({ root, state?, writablePaths? })`. Detect passes neither optional field; Apply passes state plus the exact two writable files.
- **Combined-loop tests + the old live check** targeted `runOnboardingAgent`/`finish_onboarding`; they are replaced by the split controller tests and `cli/scripts/apply-check.mjs`, not kept as a parallel path.
- **Live run:** drive Detect → (approve) → Apply against a throwaway copy of a real app; confirm the SDK is wired at the planned entry with the planned vars, dep added, `.env` untouched.

---

## What already exists (reused, not rebuilt)

| Existing | Reused by Detect | Note |
|---|---|---|
| `paths.ts` — symlink-safe containment + `.env*` policy | yes, unchanged | already committed (`587bd93`) |
| `search-tool.ts` — secret-aware search | yes, unchanged | the detect eval imported it as-is |
| `policy.ts` — PreToolUse containment/secret hook | yes, `state` becomes optional | one hook serves Detect and Apply |
| `tools.ts` — `createAskUserTool` | yes, unchanged | per-run factory, no globals |
| `engine.ts` — cancellation, warning tripwire, result mapping, injectable `queryFn` | yes, wrapped as `runDetect` | the lifecycle is stage-agnostic |
| `events.ts` — `reduceTasks` | yes | `EditTracker` waits for Apply |
| milestone 0.5 provisioning endpoint | untouched | committed, live-tested |

`spec.ts` splits one combined prompt into `renderDetectSpec` and `renderApplySpec`; the combined terminal report becomes `report_plan` for Detect and `finish_apply` for Apply.

## NOT in scope (considered and deferred)

- **The Apply stage** — outlined above; it needs the typed plan to exist first.
- **Hashing the manifest for staleness** — deliberately declined (eng-review Issue 2): the Detect→Apply gap is minutes inside a <10min flow, so drift risk is low and the extra rejection path costs more than it saves.
- **A hard wall-clock timeout on Detect** — measure first, enforce only if the data shows it (eng-review Issue 3).
- **Filtering `.env*` filenames out of `Glob` results** — accepted limitation; names leak, contents never do.
- **`ask_user` with `multi:true`** — Detect selects exactly one app, so the multi path is unused.
- **The Ink TUI, the `opslane onboard` command, provisioning wiring** — later phases.
- **Prompt-injection hardening beyond the eval case** — the eval includes a malicious-README case; a real defense (e.g. instruction quarantining) is its own piece of work.

## Failure modes (per new codepath)

| Codepath | Realistic production failure | Test? | Error handling? | User sees |
|---|---|---|---|---|
| `report_plan` on an unsupported repo | model fabricates a plan for a repo with no app | yes (new discriminant tests) | yes — `status:'unsupported'` | clear "no app to onboard" |
| `report_plan` validation | model names a file outside `app_dir` or a `.env` | yes | yes — handler throws, model retries | retry, then failure |
| two `report_plan` calls | model reports twice, second overwrites | yes (new `multiple_plans` test) | yes — state guard + `plans===1` | failure, not a wrong plan |
| `runDetect` cancellation | user ctrl-C mid-run | yes | yes — `AbortController` | clean abort |
| `runDetect` subprocess throw | SDK/subprocess dies mid-stream | yes | yes — `catch` → `ok:false` | error with reason |
| `search` on a symlinked dir | traverses outside the repo | yes (new symlink test) | yes — containment | no results, no leak |
| `Glob` broad pattern | enumerates `.env*` filenames | no (accepted) | partial — contents still blocked | names visible in transcript |
| Detect exceeds `maxTurns` on a huge repo | 50-turn exhaustion, no plan | via eval elapsed reporting | yes — `ok:false` | failure; budget regression visible in eval |

**Critical gaps (no test AND no error handling AND silent): 0.** The one that qualified — silent fabrication on an unsupported repo — is closed by the status discriminant.

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| 1.0 paths | `cli/src/onboard/` | — |
| 1.1 deps | `cli/` root manifest | — |
| 1.2 tools (`ask_user`, `report_plan`) | `cli/src/onboard/` | 1.0 |
| 1.3 search | `cli/src/onboard/` | 1.0 |
| 1.4 spec | `cli/src/onboard/` | — |
| 1.5 events | `cli/src/onboard/` | — |
| 1.6 policy | `cli/src/onboard/` | 1.0 |
| 1.7 engine + `runDetect` | `cli/src/onboard/` | 1.2, 1.4, 1.6 |
| 1.8 eval | `cli/scripts/` | 1.7 |

**Sequential implementation, no meaningful parallelization opportunity** — every step but 1.1 and 1.8 lands in the single `cli/src/onboard/` module, so parallel worktrees would collide on the same directory for near-zero wall-clock gain.

## Implementation Tasks
Synthesized from this review's findings. Each derives from a specific finding above.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — tools.ts — Add the `status: 'ok' | 'unsupported'` discriminant to `report_plan`
  - Surfaced by: Architecture Issue 1 — the eval demands an unsupported-repo case the contract can't express
  - Files: `cli/src/onboard/tools.ts`, `cli/src/onboard/__tests__/tools.test.ts`, `cli/src/onboard/engine.ts`
  - Verify: `pnpm --filter @opslane/cli exec vitest run src/onboard/__tests__/tools.test.ts`
- [ ] **T2 (P2, human: ~30min / CC: ~5min)** — plan/eval — Record the <10min budget; report elapsed wall-clock per repo in the eval
  - Surfaced by: Architecture Issue 3 — an unmeasured target is not a target
  - Files: `cli/scripts/detect-eval.mjs`
  - Verify: run the eval, confirm elapsed prints per repo
- [ ] **T3 (P1, human: ~1h / CC: ~10min)** — eval — Import `renderDetectSpec` + `createReportPlanTool`; delete the inlined spike copies
  - Surfaced by: Code Quality Issue 4 — `detect-eval.mjs:37,60` duplicate the prompt and schema
  - Files: `cli/scripts/detect-eval.mjs`
  - Verify: `grep -c 'DETECT_PROMPT' cli/scripts/detect-eval.mjs` returns 0
- [ ] **T4 (P2, human: ~45min / CC: ~10min)** — tests — Add the three coverage gaps: `unsupported` discriminant, `search` symlink non-traversal, `runDetect` two-plan → `multiple_plans`
  - Surfaced by: Test Review — 4 gaps in the coverage diagram
  - Files: `cli/src/onboard/__tests__/{tools,search-tool,engine}.test.ts`
  - Verify: `pnpm --filter @opslane/cli test`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 7 P1 + 2 P2, all folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 10 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** ran against this plan at commit `2e59023` — typed handoff artifact, exactly-one-plan enforcement, stronger `report_plan` validation, `dev_script` removal, default-deny `canUseTool`, migration section, honest eval status. All absorbed before this review. The changes made *during* this eng review (status discriminant, latency budget, eval de-duplication, 3 test gaps) postdate that pass and have not been codex-reviewed.

**CROSS-MODEL:** no tension. Codex and this review agree the two-stage Detect→Apply boundary is correct and that a third planning stage would be ceremony. They found disjoint problems — codex the handoff typing and validation strength, this review the missing negative-outcome path, the eval's self-invalidating duplication, and the unmeasured latency budget.

**VERDICT:** ENG CLEARED — ready to implement. Detect stage architecture locked; 9 of 10 findings folded into the plan, 1 accepted as-is with rationale.

NO UNRESOLVED DECISIONS
