# Phase 1b — Onboard Apply Stage

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the **Apply stage** — given an approved `OnboardingPlan` from Detect, make exactly those edits, then prove mechanically that the result is correct. Completes the engine (Detect ✅ → Apply).

**Why this is Phase 1b, not Phase 2.** Phase 1 was "engine core." The engine turned out to be two stages, and Apply is the second half of it — not new scope. Phase 2 (deterministic CLI plumbing: poll seam, env writer, `waitForAppReporting`) is independent of both and unchanged. See the pipeline diagram in `docs/design/2026-07-22-onboard-engineering-design.md` §4.

## The three decisions this plan encodes

**1. Apply is a narrow agent, not a codemod (user decision, 2026-07-23).** A deterministic codemod is genuinely viable here — Detect emits an exact import, init block, and anchor, and the repo already has transformer machinery in `cli/src/codemods/source.ts` (`lastImportStatement`, `findCreateAppStatement`, …). Codex and this review both recommended the codemod. **The user chose the agent as a standing principle: always use an agent for repo edits.** The honest tradeoff: the agent generalizes to file shapes a codemod's rules don't anticipate and stays consistent with Detect, at the cost of more machinery (approval loop, `EditTracker`, reconciliation, rollback). It is NOT because "code can't place an import" — once Detect has done the judging, placement is mechanical; the directus one-anchor-two-insertions issue is a contract bug (Task 1b.0), not evidence against a codemod. This plan builds the agent because that is the decision, and hardens it against the failure modes the extra machinery introduces.

**2. The model does judgment; code does verification.** This is the principle both stages now share:

| | Detect | Apply |
|---|---|---|
| Model's job | which app, which entry, which convention | how to weave this edit into *this* file idiomatically |
| Code's job | contain paths, block secrets, validate the plan | contain paths, gate edits, **verify the result** |

Apply therefore ends with a deterministic post-verify that the model cannot talk its way past.

**3. Apply is reversible across handled failures (eng-review Issue 1).** Apply edits exactly two known files. Before the first edit it snapshots both into memory; on every handled failure path after that point — verification, reconciliation, abort, SDK/query failure — it attempts to write both originals back so the two allowed files end byte-identical to how they started. In-memory rollback cannot recover from `SIGKILL`, process death, or machine failure; the implementation makes no crash-recovery claim. Restore has its own `restore_failed` outcome and reports affected paths, never file contents.

## Contract fix (blocking, do first)

`OnboardingPlan.edit` currently implies one anchor governs both insertions. It does not. Change the contract so it says what is true:

- `edit.anchor` / `position` / `occurrence` govern **`init_block` only**.
- `edit.import_line` has **no anchor**. Apply places it at module top level, idiomatically, alongside existing imports.

This also closes the manifest/version gaps discovered in review. `OnboardingPlan.edit` gains `manifest_file` and host-stamped `manifest_hash`; the model supplies the manifest path but neither hash. The model no longer supplies `dependency.version`: host code pins `@opslane/sdk` to the reviewed range. This is a real schema change across the interface, reported-plan type, Zod schema, Detect prompt, tests, Phase 1 plan, and engineering design.

### Codex outside-voice fixes folded into this plan (2026-07-23)

The agent path introduces failure modes a codemod wouldn't have. These are addressed in the tasks below:

- **P0 — the SDK version is host-supplied, never model-supplied.** `dependency.version` in `OnboardingPlan` is untrusted: a prompt-injected repo could emit `npm:attacker@…` or a git/file spec under the `@opslane/sdk` key. The host pins the version Apply writes (a constant or a lookup); Detect's `version` field is ignored for the manifest edit, or Detect stops emitting it. (Task 1b.0)
- **P0 — the manifest is a contained, hashed member of the plan.** Add `edit.manifest_file` (canonical, regular-file, under `app_dir`, not secret) with its own `manifest_hash`; snapshot/verify/restore all use it. A symlinked `package.json` must not let Apply read or write outside the repo. (Tasks 1b.0, 1b.3, 1b.5b)
- **P0 — verify checks the EXACT edit, not a fuzzy signature.** Presence of an `init(` or the var names can be satisfied by a comment or a string. Verify asserts the entry file equals `original` with **exactly** `import_line` inserted at top level and `init_block` inserted at the anchor — a structural diff, and that nothing else in either file changed. (Task 1b.3)
- **P0 — the hook restricts Edit/Write to exactly the two canonical paths.** Not "any in-repo non-secret path." A third-file edit is denied at the hook, not merely caught by verify afterward. And the plan drops any crash-recovery claim: an in-memory snapshot restores on a handled failure, not a `SIGKILL`. (Tasks 1b.5b)
- **P1 — `EditTracker` orders by commit (tool_result), not invocation.** Concurrent tool calls in one turn mean an edit invoked before `finish_apply` can settle after it. Track the settle sequence; `finish_apply` is rejected while any edit is unsettled. (Task 1b.1)
- **P1 — reconciliation compares sets, not lists.** `committedBeforeFinish()` yields duplicate paths for two edits to one file; `edited_files` is a set of files. Compare as sets. (Tasks 1b.1, 1b.5b)
- **P1 — `no_op`/`already_onboarded` is mechanically confirmed.** Before returning `already_onboarded`, Apply confirms the dependency and an `init` call structurally exist (not that the key is valid — that stays Phase 2). Otherwise the subtype claims "already set up" without proof and reintroduces the hang. (Task 1b.5b)
- **P1 — the lockfile is left inconsistent on purpose, stated as an output.** Apply edits `package.json` but does not run installs (hard constraint). So the lockfile is now stale. Apply's report includes an explicit `install_required: true` and the exact command (`pnpm install` / `npm install` / …) so the caller (Phase 2/3) syncs it. Never silently leave a manifest the package manager will reject under `--frozen-lockfile`. (Task 1b.2)
- **P2 — secret scanning is specified, not hand-waved.** Verify #6 reads `.env*` via the existing secret policy (contained, symlink-safe), splits on `=`, ignores empty and trivial values (`true`, `1`, `''`), caps file size, and its failure message names the variable, **never** the value. (Task 1b.3)
- **P2 — the syntax gate matches supported entries.** The parse check is JS/TS only. Detect already limits Phase 1 to Vite/Next/Nuxt (JS/TS), so assert the entry extension is `.{ts,tsx,js,jsx,mjs,cjs}` and treat anything else as unsupported rather than silently skipping the parse. (Task 1b.3)

**Out of scope for Phase 1b:** `existing_sdk.action: 'migrate'`. Migration was ruled out (the only predecessor-SDK repo is a personal app). Apply **refuses** `migrate` with a clear message rather than half-doing it — a partial migration is how you drop a Vue plugin, `release`, and `replay` and leave `setUser` pointing at an uninitialized SDK, which is exactly what we observed.

---

## Task 1b.0: Fix the anchor contract (docs + types)

**Files:** Modify `cli/src/onboard/tools.ts` (types, validation, host pin, interface comments), `cli/src/onboard/spec.ts` (Detect prompt wording), tests, `docs/plans/2026-07-22-phase-1-engine-core.md`, and `docs/design/2026-07-22-onboard-engineering-design.md`.

- In `OnboardingPlan.edit`, comment that `anchor`/`position`/`occurrence` locate `init_block` only, and that `import_line` is placed by Apply at module top level. The anchor must equal one complete line's non-whitespace content (including punctuation), which makes both before/after placement and exact verification unambiguous.
- In `renderDetectSpec`, change "Provide exact import_line and init_block code plus an exact anchor, position, and zero-based occurrence for the entry file" to make clear the anchor locates the init block, and the import line is a top-level import Apply will place.
- Require a canonical regular `package.json` under `app_dir`, store it as `edit.manifest_file`, and host-stamp `edit.manifest_hash`.
- Remove model control of the SDK version and host-pin `dependency.version`.
- **Test:** `spec.test.ts` asserts the prompt distinguishes the two (`/init block/i` near the anchor language; the import described as top-level).

**Commit** — `fix(cli): anchor locates the init block only, not the import`

---

## Task 1b.1: `EditTracker` — ordered edit lifecycle (TDD)

Never built (deferred from Phase 1). Apply needs it to prove no edit landed after the run was declared finished.

**Files:** Modify `cli/src/onboard/events.ts`; test `__tests__/events.test.ts`.

**Implement** `EditTracker(root)`:
- Track invocation and settlement separately. Every recognized block advances a monotonic event sequence; a matching non-error edit `tool_result` records its **commit sequence** (an errored or denied edit is never committed).
- The successful `finish_apply` `tool_result` records the finish boundary. `committedBeforeFinish()` returns edits whose commit sequence is before it; `editsAfterFinish()` returns commits at or after it.
- `hasUnsettledEdits()` lets `finish_apply` reject while any invoked edit lacks a result.
- Paths normalized through `containedRepoRelative`.

**Test:** an edit then finish then a second edit → `committedBeforeFinish()` is `['src/main.ts']` and `editsAfterFinish()` is `['src/late.ts']`; an **errored** edit result is not committed; two edits to the same file both record.

**Commit.**

---

## Task 1b.2: Apply's terminal tool — `finish_apply` (TDD)

Detect ends with `report_plan`; Apply ends with `finish_apply`. Same discipline: per-run factory, state-guarded, host validates every value.

**Files:** Modify `cli/src/onboard/tools.ts`; test `__tests__/tools.test.ts`.

**Implement** `createFinishApplyTool(root, state, onReport, canFinish)`:
- Shape: `{ edited_files: z.array(z.string()).min(1), summary: z.string() }`.
- Handler: reject a second call (`already finished`) and reject while `canFinish()` is false; every path through `containedRepoRelative` and the secret policy; reject duplicates; on success capture canonical files, then set `state.finished = true` so the hook denies everything after.
- `install_required`, the package-manager command, and working directory are not model fields. `runApply` adds them from trusted plan state only after deterministic verification succeeds.

**Test:** valid report accepted once, second rejects `/already/i`; a path escape rejects; a `.env` path rejects; empty `edited_files` rejects; `state.finished` flips only on success.

**Commit.**

---

## Task 1b.3: Deterministic post-verify (TDD) — the load-bearing safety net

This is the half code is genuinely better at. It runs **after** the agent, in-process, and cannot be argued with. No shelling out to the repo's build (slow, and would blow the <10min budget).

**Files:** Create `cli/src/onboard/verify.ts`; test `__tests__/verify.test.ts`.

**Implement** `verifyApplied({ root, plan, editedFiles, originals:{entry,manifest} })` → `{ ok, failures: string[] }`. The before-images are required; hashes alone cannot prove an exact diff. Checks:
1. **Only expected files changed** — the edited set is exactly `{plan.edit.file, <manifest>}`. Anything else is a failure (catches the agent wandering).
2. **Before-images match the plan** — both supplied snapshots hash to `entry_hash`/`manifest_hash`.
3. **Exact entry delta** — no deletion, replacement, unrelated addition, or reformat is allowed. The only added blocks are the exact top-level `import_line` in the module import section and `init_block` at the selected anchor, with only surrounding indentation/newline normalization.
4. **Exact manifest delta** — JSON semantics differ only by `dependencies["@opslane/sdk"] = <host-pinned version>`, and byte changes are confined to that insertion/version region.
5. **Structural wiring** — TypeScript AST parsing proves the exact Opslane import is top-level, its bound initializer is called, and the planned environment-variable names are syntax nodes rather than comments/strings.
6. **File still parses** — parse only `edit.file`. Supported extensions are `.{ts,tsx,js,jsx,mjs,cjs}`; anything else is rejected. Because this parser runs in the published CLI, `typescript` moves from dev-only to runtime dependencies.
7. **No newly written secrets** — scan only bytes added by the exact diff against bounded, regular, non-symlink `.env*` files. Parse `export NAME=value`, quotes, and trivial values; errors name only the variable/path and never reveal a value. Pre-existing matching literals in unchanged bytes do not fail.

**Test** (real `mkdtemp` fixtures): a correctly applied pair passes every check. Cover a third reported file, stale before-images, comments/strings that resemble wiring, a block-local or late top-level import, wrong indentation/anchor, syntax failure, unrelated entry or manifest changes, full-manifest reformatting, unsupported extensions, planted secret values, pre-existing matching literals, symlinked dotenv files, and both valid and false `no_op`.

**Commit.**

---

## Task 1b.4: Apply spec — `renderApplySpec` (TDD)

Narrow prompt. The judgment is already made; Apply executes it and places the import well.

**Files:** Modify `cli/src/onboard/spec.ts`; test `__tests__/spec.test.ts`.

**Implement** `renderApplySpec({ cwd, plan })`:
- **Goal:** apply exactly this approved plan to `cwd`. Change nothing else.
- **The plan**, rendered as explicit fields (not prose): the entry file, the exact `import_line`, the exact `init_block`, the anchor + position + occurrence for the init block, and the dependency.
- **Instructions:** insert `init_block` `position` the `occurrence`-th match of `anchor` in `edit.file`, matching the file's existing indentation. Place `import_line` at module **top level** alongside the existing imports — never inside a function or block. Add the host-pinned dependency to `edit.manifest_file`. Do not run installs. Do not reformat unrelated lines.
- **existing_sdk:** `none`/`keep` → proceed (coexist; do not touch the other SDK). `no_op` → make no edits and finish immediately. `migrate` → **stop and report that migration is unsupported**; do not attempt it.
- **Finish:** call `finish_apply` exactly once with the files edited. No edits after.

**Test:** the rendered spec contains the entry file, the exact import line and init block, "top level", "change nothing else", "do not run installs", `finish_apply`, and the migrate refusal. A plan with `action:'migrate'` renders the refusal instruction.

**Commit.**

---

## Task 1b.5a: Extract `runAgentCore` (refactor, tests stay green) — eng-review Issue 3

`runDetect` (engine.ts:156-252) and `runApply` share ~60 lines of the most bug-prone code in the module: API-key preflight, abort bridging, the shadow-warning tripwire (must never throw inside its own listener), `try`/`catch`/`finally`, and result mapping. Duplicating it means a future tripwire or abort fix could land in one copy and not the other — a safety regression in the stage that writes to disk. **Make the change easy, then make the easy change (Beck):** extract first, add Apply second.

**Files:** Modify `cli/src/onboard/engine.ts`; existing `__tests__/engine.test.ts` must stay green.

**Implement** `runAgentCore({ prompt, options, onMessage, signal, queryFn })` where `options` is a factory receiving the internally owned `AbortController`. It returns `{ ok, aborted, subtype, reason }` and owns the shared lifecycle. `runDetect` becomes a thin wrapper that supplies `renderDetectSpec`, `detectOptions`, its MCP tools, and its own report accounting. This is a pure extraction: no behavior change.

---

## Task 1b.5b: Engine — `applyOptions` + `runApply` (TDD)

`runApply` is a thin wrapper over `runAgentCore` plus Apply's own pre-flight gates, `EditTracker`, snapshot/restore, and post-verify. Injectable `queryFn`, unit-tested with an async-generator stub (no model, no subprocess).

**Files:** Modify `cli/src/onboard/engine.ts`; test `__tests__/engine.test.ts`.

**Implement.**
- `applyOptions({ cwd, hook, mcpServers, canUseTool, abortController })`: `permissionMode:'default'`; `settingSources:[]`; `strictMcpConfig:true`; `allowedTools:[]` (nothing auto-approved — every edit goes through approval); `tools:['Read','Edit','Write']`; `disallowedTools:['Grep','Glob','Bash','WebFetch','WebSearch']` (the plan located everything; no search needed, and no shell); `hooks:{PreToolUse:[{hooks:[hook]}]}`; `canUseTool`; `abortController`; `maxTurns:30`.
- `runApply({ cwd, plan, onMessage, onReport, requestApproval, signal, queryFn = query })`:
  - **Containment + staleness gate, before any model call:** re-contain and re-stat both canonical regular files; reject symlinks; re-hash entry and manifest; return `stale_plan`/`stale_manifest` without querying on drift. Also verify the anchor occurrence and supported entry extension.
  - **`migrate` gate:** `plan.existing_sdk.action === 'migrate'` → `{ok:false, reason:'migrate_unsupported'}` without querying.
  - **`no_op` short-circuit:** mechanically parse the manifest and entry first. An identity-capable SDK range (minimum 1.2.0) must exist, and a real top-level named/namespace `@opslane/sdk` import must be structurally bound to an initializer call. Only then return `{ok:true, subtype:'already_onboarded', editedFiles:[]}`; otherwise return `invalid_no_op` without querying. Old identity-broken SDK versions are never called already-onboarded. Key validity stays Phase 2's job.
  - **Snapshot before editing (eng-review Issue 1):** read `plan.edit.file` and `plan.edit.manifest_file` into memory. Register a restore that independently attempts both originals on every non-success exit below.
  - `state={finished:false}`; `hook = onboardPreToolUseHook({root:cwd, state, writablePaths:[entry,manifest]})`; `canUseTool = createOnboardApproval(...)` with an explicit stage allowlist so unknown tools fail closed; `finish_apply` receives the tracker's unsettled-edit guard; feed the tracker from `onMessage`.
  - **Drive `runAgentCore`** with `renderApplySpec({cwd, plan})` and `applyOptions(...)` (Task 1b.5a) — the shared lifecycle (cancellation, tripwire, `try`/`catch`/`finally`) is not re-implemented here.
  - **After a clean result:** reconcile canonical sets (duplicates in the edit log are allowed; duplicates in the report are not), require no unsettled or late edit, then run `verifyApplied(...)`. Invoke the external `onReport` only after all checks pass, adding trusted install metadata.
  - `ok:true` only when: clean terminal result **and** exactly one report **and** verify passed **and** reconciliation clean. **On any `ok:false`, restore the snapshot first** so the repo is left unchanged.

**Test:** lock the option/tool gates; exercise entry and manifest staleness, moved anchor, migration refusal, supported extensions, proven and false `no_op`, clean success, trusted install metadata, missing/mismatched reports, duplicate same-file edits, unsettled/late edits, query failure, abort, verification failure, and byte-identical rollback. Test `restore_failed` separately by replacing an allowed path with a symlink after snapshot and prove no outside file is written.

**Commit.**

---

## Task 1b.6: Validation checkpoint

**Unit gate:**
```bash
pnpm --filter @opslane/cli build
pnpm --filter @opslane/cli exec vitest run src/onboard
pnpm --filter @opslane/cli test
```

**Hermetic controller gate (required in CI).** An injected-query integration test runs the full `runDetect` → host-validated plan → `runApply` handoff against a real temporary filesystem. It proves controller wiring, exact verification, reconciliation, rollback, and trusted install metadata without a model key.

**Live gate (release/pre-merge when credentials and pinned fixtures are available).** `cli/scripts/apply-check.mjs` runs the production **full Detect → Apply loop** against throwaway copies:
```bash
export ANTHROPIC_API_KEY=...
pnpm --filter @opslane/cli build
node cli/scripts/apply-check.mjs <app-dir> [app-dir...]
```
It must: copy the app to a temp dir (never the original), neutralize `.env*` with a canary, run Detect, auto-approve, run Apply, then assert:
- `verifyApplied` passes every deterministic check;
- the entry file still parses and the `@opslane/sdk` import is at column 0;
- `git diff`-equivalent shows exactly two files changed;
- `.env*` untouched and the canary never in the transcript;
- total elapsed Detect+Apply is within the <10min budget (report it).

The script never mutates the source app. It accepts fixture paths explicitly so it does not depend on an undocumented local directory layout, and reports the resolved source path and elapsed time. Release evidence should pin and record the fixture revisions. The target matrix includes `verify-cloud/dashboard` (plain `VITE_`, no existing SDK) and `directus` (Vue, tab-indented, anchor inside `async function init()` — the case that motivated the contract fix). If the API key or fixtures are absent, record the live gate as unavailable; do not substitute that absence for the hermetic gate or claim a live run occurred.

---

## What already exists (reused, not rebuilt)

| Existing | Reused by Apply | Note |
|---|---|---|
| `onboardPreToolUseHook({root, state?})` | yes, with `state` | already optional (policy.ts:42) — no fork |
| `createOnboardApproval` | yes | survived the Detect refactor (policy.ts:85) |
| `paths.ts` containment + secret policy | yes | unchanged |
| engine lifecycle (cancel, tripwire, result map, `queryFn`) | yes | `runApply` mirrors `runDetect` |
| `OnboardingPlan` type | yes | contract clarified, no field changes |

## NOT in scope

- **`migrate`** — refused explicitly, not half-done. Only one repo (a personal app) has the predecessor SDK.
- **`Glob`/`search`/`Bash` in Apply** — the plan located everything; adding them widens blast radius for no gain.
- **Running the repo's build/typecheck** — too slow for the budget; the in-process parse check covers syntax.
- **Formatting/lint normalization** — we do not run prettier/eslint; the agent matches surrounding style and verify checks structure, not style.
- **The CLI command, approval UI, provisioning** — Phase 2 and Phase 3.

## Failure modes

| Codepath | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|
| stale plan | repo changed after approval | yes | pre-flight hash gate | "repo changed, re-detecting" |
| anchor moved | file edited between stages | yes | pre-flight anchor gate | same |
| import placed in a block or below module setup | the directus shape | yes | AST/import-section verification fails the run | "apply failed verification" |
| agent edits a third file | wandering | yes (verify #1) | verify + tracker reconcile | failure, not a silent extra edit |
| edit after finish | late tool result | yes | `editsAfterFinish()` | failure |
| `migrate` plan | predecessor SDK repo | yes | refused pre-flight | "migration unsupported" |
| secret written into new source/manifest bytes | model pastes a value | yes | bounded redacted secret verification fails | failure |
| symlinked manifest | `package.json` → outside repo | yes | containment on `manifest_file` | denied pre-flight |
| injected `dependency.version` | `npm:attacker@…` in plan | yes | host pins version, ignores model's | attacker string never written |
| stale lockfile after edit | `pnpm install --frozen-lockfile` fails | n/a | `install_required` in report | told to run install |
The original draft's “0 critical gaps” claim was removed during implementation review. Completion is established by the requirement-by-requirement verification gates below, not by an unaudited table count.

---

## Worktree parallelization

| Task | Modules | Depends on |
|---|---|---|
| 1b.0 contract fix | `onboard/tools.ts`, `spec.ts`, phase-1 plan | — |
| 1b.1 EditTracker | `onboard/events.ts` | — |
| 1b.2 finish_apply | `onboard/tools.ts` | 1b.0 |
| 1b.3 verify | `onboard/verify.ts` (new) | 1b.0 |
| 1b.4 renderApplySpec | `onboard/spec.ts` | 1b.0 |
| 1b.5a runAgentCore extract | `onboard/engine.ts` | — (pure refactor) |
| 1b.5b runApply | `onboard/engine.ts` | 1b.1, 1b.2, 1b.3, 1b.4, 1b.5a |
| 1b.6 live check | `cli/scripts/` | 1b.5b |

**Mostly sequential — one small parallel lane.** 1b.5a (extract `runAgentCore`, pure refactor of `engine.ts`) and 1b.1 (`EditTracker`, `events.ts`) touch different files with no dependency, so they can run in parallel worktrees. Everything else converges on `engine.ts`/`tools.ts` and is sequential. Not worth more than one split.

## Implementation Tasks
Synthesized from this review. Each derives from a finding.

- [x] **T1 (P0, human: ~1h / CC: ~10min)** — tools.ts — Host-pin the SDK version; add contained+hashed `manifest_file` to the plan
  - Surfaced by: codex P0 (supply-chain, manifest containment)
  - Verify: a plan with `version:"npm:x@1"` never writes that string; a symlinked manifest is denied
- [x] **T2 (P0, human: ~2h / CC: ~15min)** — verify.ts — Exact-diff verification (only the two known insertions changed)
  - Surfaced by: codex P0 (verification too weak)
  - Verify: a file with a stray extra `init()` in a comment fails; a partial-correct file fails its own check
- [x] **T3 (P1, human: ~2h / CC: ~15min)** — engine.ts — Rollback snapshot/restore on every failure path; restrict Edit/Write to the two canonical paths at the hook
  - Surfaced by: eng-review Issue 1 + codex P0 (rollback not transactional)
  - Verify: forced verify failure leaves both files byte-identical; a third-file Edit is denied
- [x] **T4 (P1, human: ~1.5h / CC: ~15min)** — events.ts — EditTracker orders by commit; reconcile as sets
  - Surfaced by: codex P1 (ordering, reconciliation)
  - Verify: two edits to one file reconcile; an unsettled edit blocks finish
- [x] **T5 (P1, human: ~2h / CC: ~20min)** — engine.ts — Extract `runAgentCore` via an options factory (not prebuilt options)
  - Surfaced by: eng-review Issue 3 + codex P1 (signature)
  - Verify: runDetect tests stay green post-extraction
- [x] **T6 (P2, human: ~1h / CC: ~10min)** — verify.ts — Specify secret scan + JS/TS-only parse gate
  - Surfaced by: codex P2
  - Verify: failure message names the var not the value; a non-JS entry is rejected, not skipped

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 4 P0 + 6 P1 + 2 P2 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | resolved | 4 own findings + codex folded and implemented |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** hit hard and correctly. Surfaced 4 P0s the eng review missed — supply-chain injection via `dependency.version`, missing manifest containment, fuzzy verification that any `init(` satisfies, and non-transactional rollback that misses a third-file edit — plus the observation that `cli/src/codemods/source.ts` already exists (which this review's Step 0 missed). All agent-path fixes folded; the codemod recommendation was put to the user.

**CROSS-MODEL:** one real tension — Apply as a deterministic codemod (codex + this reviewer) vs an agent. **The user chose the agent as a standing principle** ("always use an agent for repo edits"), overriding both models. Logged as a durable decision. The plan's justification was corrected: the earlier "code can't place an import" argument was a false analogy codex debunked (reading is judgment → model; applying a known edit is transformation). The agent is kept for generalization and consistency with Detect, and hardened against the machinery's failure modes.

**VERDICT:** ENG reviewed and implemented. The agent-hardening fixes (T1–T6) are complete, covered by focused CLI tests, and included in the repository-wide verification gate.

**UNRESOLVED DECISIONS:**
- Lockfile sync: Apply reports `install_required` rather than running the install (folded as the chosen path, consistent with the "no installs" constraint) — flagged here only because it means Apply's output is "manifest edited, install still needed," which Phase 2/3 must honor or the app won't build.
