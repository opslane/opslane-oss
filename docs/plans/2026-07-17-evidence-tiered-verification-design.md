# Evidence-Tiered Fix Verification

**Date:** 2026-07-17
**Status:** Draft — v2 after Codex adversarial review (2026-07-17)
**Author:** Abhishek + Claude; adversarial review by Codex (24 findings, all addressed or explicitly scoped out below)

## Problem

The fix pipeline's PR gate defines `verified = existing test suite ran AND passed` (`agent-fix.ts`, precision gate). Live testing on 2026-07-17 exposed three defects:

1. **Wrong oracle.** A production error escaped the existing suite by definition, so suite-pass proves *non-regression*, not *resolution*.
2. **Coverage cliff.** Repos with no test runner can never clear the gate (`skipped ≠ passed`). The headline feature is unreachable for exactly the small-team browser apps Opslane targets. Observed three times in one onboarding session: correct root cause, judge-approved fix, `needs_human` anyway.
3. **Overfitting blindness.** The LLM diff judge scored 2/2/2 a fix that made a failing promise resolve — symptom silencing. This is the classic automated-program-repair *patch overfitting* problem: plausible patches pass an incomplete oracle.

A fourth defect surfaced during review: `pipeline.ts` discards the candidate diff on every `needs_human`, while the dashboard remediation text tells users to "review the candidate diff." The proof the user is told to examine is never stored.

## Prior art (research, 2026-07-17)

- **Meta SapFix**: reproduction-first — non-reproducible crashes are *discarded*; patches validated by re-running the crash scenario plus existing tests; human approves before land.
- **SWE-bench Verified**: the consensus definition of "fix proven": at least one test **fails before the patch and passes after** (fail→pass), with zero pass→fail regressions against a **pre-patch baseline**.
- **Agentless**: LLM-generated reproduction tests + regression filtering + majority voting; falls back to regression-only selection when the generated repro is unreliable.
- **Google Abstain-and-Validate**: separate validator with an explicit abstain option; precision over recall.
- **Sentry Seer**: optional unit-test generation as regression insurance; verification is otherwise human review. No executed proof — doing this properly is a differentiator, not table stakes.

## Design overview

Replace the binary `verified` with a persisted, structured **evidence record**, and move the PR bar from "existing suite passed" to "reproduction went red→green under anti-gaming invariants."

```
E0  build passes
E1  existing suite: per-test comparison against a pre-patch baseline (no new failures)
E2  repro test: red on HEAD, green with fix, red again on patch-reversal   ← PR bar
E3  session replay re-driven against the fixed build, error gone            (future)
```

Tiers are meaningful because they are **persisted and surfaced** (evidence record → PR body → dashboard), not just branched on. E0-only and E1-skipped produce the same *decision* but different displayed evidence and different remediation text (Codex #23).

## Phase 0 — Prerequisites (ship independently, before any repro work)

Codex #7, #8, #9, #18, #24: the v1 design assumed infrastructure that does not exist. Build it first.

1. **Consolidate sandbox setup.** `agent-fix.ts` duplicates sandbox creation instead of using `createRepoSandbox` — it misses `ensureModernNode` and would force every new gate to be implemented twice. One sandbox factory, used by both setup and fix pipelines.
2. **Add the build gate to the fix pipeline.** `runAgentFix` never calls `runBuildGate` today; E0 must exist before it can appear in a decision table.
3. **Evidence persistence.** New structured record (new table or JSONB on `error_groups`): tier reached, commands run, exit codes, red/green outputs (bounded), skip/failure category, repro content hash. Threaded through `AgentFixResult` → `PipelineResult` → `PRInput` → tracing → dashboard. A local variable is not evidence.
4. **Persist the candidate diff on `needs_human`.** Fixes the dangling "review the candidate diff" remediation. Scrub via the existing redaction path before storage.

## Phase 1 — Make E1 honest

5. **Baseline before patch** (Codex #11). Run the suite on HEAD first, record per-test results; after the patch, compare per-test. Pre-existing failures are excluded; only pass→fail counts as regression. This is the SWE-bench invariant, which v1 misstated.
6. **Runner adapters** (Codex #12, #13). Detect package manager (npm/pnpm/yarn via lockfile — logic exists in `runBuildGate`), workspaces, vitest/jest config variants, and always invoke an **explicit command with an explicit scope**; reject zero-test collection as `infra_error`, not as evidence.
7. **Failure taxonomy** (Codex #16, #17). Outcomes are `{passed, failed, skipped_no_runner, infra_error}`. Dependency-install failure, timeout, runner crash, and syntax errors are `infra_error`: retriable, never counted as evidence about the patch, never conflated with "could not reproduce."
8. **Evidence-driven PR body** (Codex #19). Replace the hard-coded "High · Tests passing" with a Verification section rendered from the evidence record.
9. **Reason-code plumbing** (Codex #20). New codes (`repro_not_achievable`, `verification_infra_error`, split from `low_confidence_fix`) go through the shared contract, ingestion permanence/requeue policy, e2e catalogs, and eval types in one change.

## Phase 2 — The repro gate (E2)

### Immutability (Codex #1, #2 — the load-bearing invariant)

The repro test is written by the **harness**, not the fix agent, to a directory **outside the repo working tree** (`/home/user/opslane-verify/`). The fix agent has no tool access to that path. The harness records the repro's content hash at creation and re-verifies it before every run. Being outside the tree, the repro survives `git clean -fd` between model tiers and never appears in `extractDiff` output; the harness adds it to the PR as a separate, final commit after diff extraction.

### Red validation (anti-tautology; Codex #3, #14, #15)

- **3× red on HEAD** — the repro must fail deterministically, all three runs.
- **Failure origin check**: the failure's stack must include an application source frame (a file in the repo, not only the test file). Kills `throw new TypeError(expectedMessage)` tautologies.
- **Error equivalence** is defined, not vibes: exception type + normalized message (volatile tokens — numbers, UUIDs, URLs — stripped) + originating frame path; async rejections unwrapped by walking the cause chain.

### Green validation (anti-flake, anti-gaming)

- **3× green with the patch**, suite compared per-test against the Phase-1 baseline, build passes.
- **Patch-reversal check** (Codex #3): revert *only the production-file changes* (keep the repro), rerun — the repro must go **red again**. Green→red-on-revert proves the production change, and nothing else, is what resolves the error. This subsumes most flake and tautology cases in one deterministic check.

### Anti-swallowing (Codex #4)

"Does not throw" is satisfiable by swallowing the error, so:

- The repro prompt must derive a **positive behavioral assertion** from the evidence (rendered output, returned value, DOM state from the replay/breadcrumbs), recorded as `asserts_behavior: true|false` on the evidence record.
- The **PR bar requires `asserts_behavior: true`**. Red→green with a no-throw-only repro caps at `medium` → `needs_human` with the diff and evidence attached.
- The judge prompt gains an explicit question — "does this diff suppress the error rather than resolve its cause?" — plus static swallow-pattern checks (empty catch, catch-and-return-default wrapping the error site) that force a judge fail.

### Runner and framework strategy (Codex #5, #6, #13)

Primary path: **component-level repro using the host repo's own configuration** — the repro imports the repo's components and runs under the repo's vite/vitest config, which is what makes Vue/React transforms, aliases, and DOM setup work. The sandbox image **pins** vitest + @testing-library (exact versions, preinstalled) as a fallback harness for repos with no runner; `npx` at runtime is banned. v1 explicitly targets the Vue + Vite and React + Vite SPA wedge; Next.js/SSR and exotic setups route to `repro_not_achievable` (an honest E1-capped outcome) rather than a flaky adapter. The repro is always executed by explicit file path; zero-test collection is `infra_error`.

### Repro test in the PR (Codex #21)

Always included, under `opslane/regression/`, as the reviewable and re-runnable proof. No config to omit it in v1 — removing the proof removes the point.

### Degradation (Codex #16)

- `repro_invalid` (tautological, flaky, wrong error, 2 authoring attempts exhausted) → E1 path, honest message.
- `infra_error` → job retry, never an evidence claim.
- `skipped_no_runner` + repro also not achievable → today's outcome, with the new explicit reason.

## Decision table (v2)

| Evidence | Judge | Outcome |
| --- | --- | --- |
| E2 full (3×red, 3×green, reversal-red, `asserts_behavior`, E1 no regressions, E0) | pass | `pr_created`, high; PR cites red→green→reversal output |
| E2 without `asserts_behavior` (no-throw repro only) | pass | `needs_human`, medium — "error elimination verified; behavior not asserted"; diff + evidence attached |
| E2 any | fail | `needs_human`, `low_confidence_fix` (judge-rejected variant); diff + evidence attached |
| E1 only (`repro_not_achievable`) | pass | `needs_human`, medium; diff attached |
| `infra_error` anywhere | — | retry; on exhaustion `needs_human` with `verification_infra_error`, never an evidence claim |

## Interaction with the pre-clone guard (Codex #10)

Today, stackless errors are rejected before replay evidence is loaded — which forecloses repro-from-replay. Phase 2 keeps the guard but moves it **after** a replay-availability check: stackless + no replay → reject as today; stackless + replay present → route to the repro stage with replay-derived interaction evidence. Full replay-driven verification (E3, browser-in-sandbox) remains out of scope until E2 ships.

## Cost and latency (Codex #22, honest version)

Added per fix attempt: repro authoring (haiku-class agent, ≤2 attempts) + 3 red + 3 green + 1 reversal + baseline suite + post-patch suite + build. For the target SPA wedge (small suites), estimate **2–6 minutes** added wall-clock and one extra agent stage, bounded by per-stage timeouts and the existing budget caps. This is acceptable for a product whose promise is a verified PR, not a fast guess.

## Non-goals (v1)

- Candidate-patch sampling / majority voting (Agentless-style) — cost envelope.
- E3 replay-driven verification — needs a browser in the sandbox; design after E2 ships.
- Jest/Playwright/Next.js adapters — added by demand after the Vite wedge is solid.

## Sequencing (Codex #24)

Phase 0 (sandbox consolidation, build gate in fix pipeline, evidence persistence, diff persistence) → Phase 1 (baseline, adapters, taxonomy, PR body, reason codes) → Phase 2 (repro gate). Each phase ships and improves the product independently; Phase 2 is not started until Phase 0's single sandbox factory and evidence store exist.
