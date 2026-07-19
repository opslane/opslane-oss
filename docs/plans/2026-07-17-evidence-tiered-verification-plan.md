# Evidence-Tiered Fix Verification — Implementation Plan (Phase 0 + Phase 1)

**Status:** v2 after plan review (2026-07-17). Blocking fixes: Phase 0 caps at E0 (E1 requires a recorded, comparable baseline; E2 requires repro red+green+reversal); suite comparison hardened (collection drops regress, coarse baseline-failed+post-failed is not comparable, nonzero-exit-without-assertion-failure and all-skipped suites are infra_error); install/build/suite failures use the CheckOutcome taxonomy with in-gate retry + `VerificationInfraError` job-retry, terminal only on exhaustion; baseline runs restore the tree and the candidate diff is captured before post-patch gates; candidate diff + evidence are detail-endpoint-only; reason-code task covers the permanence catalog, drift-checked docs, and `docs/architecture/precision.md`; sandbox factory cleans up on any setup failure. Corrections: real exit codes wired through, suite identifiers bounded+scrubbed, Phase 1 explicitly root-package-Vitest-only, named-path commits (never `-am`/`-A` for new files), a real dashboard component test, migration clean/existing/reapply checks, Task 8 ordered before Task 7, friction PRs render evidence instead of a hard-coded claim.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the binary `verified` flag with a persisted, structured evidence record; consolidate sandbox setup; add the build gate (E0) to the fix pipeline; make the existing-suite gate (E1) honest with a pre-patch baseline; persist the candidate diff on `needs_human`; render evidence in the PR body and dashboard.

**Architecture:** The worker (`packages/worker`) builds an `EvidenceRecord` during `runAgentFix`, threads it through `PipelineResult` into a new `verification_evidence` JSONB column and `candidate_diff` TEXT column on `error_groups` (migration `014`). The Go read API and Vue dashboard surface both. Two new reason codes (`repro_not_achievable`, `verification_infra_error`) go through the shared contract, the Go requeue policy, and the e2e catalog in one task.

**Tech Stack:** TypeScript (Node 22, ESM, strict), Vitest, Go 1.24 + pgx, Vue 3, Postgres.

**Design doc:** `docs/plans/2026-07-17-evidence-tiered-verification-design.md` — read it first. Phase 2 (the repro gate / E2) is **deliberately not in this plan**; the design mandates "Phase 2 is not started until Phase 0's single sandbox factory and evidence store exist." Write the Phase 2 plan after this one lands.

---

## Before you start

1. `git status` on `main` shows uncommitted live-testing fixes (`ensureModernNode`, stack-trace regex, tracing export, build-gate stderr). **Commit those first as their own commit** (they are prerequisites this plan builds on), or confirm they already landed.
2. Create a worktree/branch: `git checkout -b evidence-tiered-verification`.
3. Repo conventions (from `AGENTS.md`): ESM + strict TS, no `any` (use `unknown` + narrowing), tests colocated in `__tests__`, every terminal `needs_human` must carry non-empty `reason_code`/`reason_message`/`remediation`, never weaken lease/terminal contracts.
4. Commands you will use constantly:
   - Worker: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`
   - Single test file: `pnpm --filter @opslane/worker exec vitest run src/harness/__tests__/evidence.test.ts`
   - Shared: `pnpm --filter @opslane/shared build` (worker imports shared's `dist/` — rebuild shared before typechecking the worker after editing shared types)
   - Ingestion: `(cd packages/ingestion && go build ./... && go test ./...)`
   - Dashboard: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`

---

# Phase 0 — Prerequisites

## Task 1: Shared secret-scrubbing helper (`redact.ts`)

`agent-fix.ts` has a private `sanitizeOutput` (line 69) that scrubs tokens. Evidence records and candidate diffs need the same scrubbing before persistence ("scrub via the existing redaction path"). Extract it.

**Files:**
- Create: `packages/worker/src/harness/redact.ts`
- Test: `packages/worker/src/harness/__tests__/redact.test.ts`

**Step 1: Write the failing test**

```ts
// packages/worker/src/harness/__tests__/redact.test.ts
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../redact.js';

describe('scrubSecrets', () => {
  it('scrubs credentials embedded in URLs', () => {
    expect(scrubSecrets('cloning https://x-access-token:ghs_abc@github.com/o/r.git'))
      .toBe('cloning https://***@github.com/o/r.git');
  });

  it('scrubs GitHub and Anthropic tokens', () => {
    expect(scrubSecrets('ghp_abc123 and github_pat_11AAA_bb and sk-ant-api03-xyz'))
      .toBe('[REDACTED] and [REDACTED] and [REDACTED]');
  });

  it('leaves clean text alone and does not truncate', () => {
    const long = 'a'.repeat(10_000);
    expect(scrubSecrets(long)).toBe(long);
  });
});
```

**Step 2: Run it — expect FAIL** (`Cannot find module '../redact.js'`):
`pnpm --filter @opslane/worker exec vitest run src/harness/__tests__/redact.test.ts`

**Step 3: Implement**

```ts
// packages/worker/src/harness/redact.ts
/**
 * Scrub credentials and API tokens from text before storage, logging, or
 * prompt injection. Never truncates — callers bound length themselves.
 */
export function scrubSecrets(raw: string): string {
  return raw
    .replace(/https:\/\/[^@\s]+@/g, 'https://***@')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
```

**Step 4: Run test — expect PASS.**

**Step 5: Refactor `agent-fix.ts` to use it.** In `packages/worker/src/agent-fix.ts` replace the body of `sanitizeOutput` (line 69-75):

```ts
import { scrubSecrets } from './harness/redact.js';

/** Scrub secrets/tokens from sandbox output before logging or prompt injection. */
function sanitizeOutput(raw: string): string {
  return scrubSecrets(raw).slice(-MAX_TEST_OUTPUT);
}
```

**Step 6: Verify:** `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`

**Step 7: Commit** (named paths — never `git add -A` in this worktree; plan review):
`git add packages/worker/src/harness/redact.ts packages/worker/src/harness/__tests__/redact.test.ts packages/worker/src/agent-fix.ts && git commit -m "refactor(worker): extract scrubSecrets redaction helper"`

---

## Task 2: `EvidenceRecord` types in the shared contract

**Files:**
- Modify: `shared/src/types.ts` (after the `ReasonCode` union, ~line 126)

**Step 1: Add types** (type-only change; the compile IS the test):

```ts
// === Verification evidence (evidence-tiered fix verification) ===

/** Highest verification tier fully achieved. E0=build, E1=suite vs pre-patch baseline, E2=repro red→green. */
export type EvidenceTier = 'E0' | 'E1' | 'E2';

/**
 * Outcome taxonomy for any verification check (design Codex #16/#17).
 * infra_error is retriable and is never evidence about the patch.
 */
export type CheckOutcome = 'passed' | 'failed' | 'skipped_no_runner' | 'infra_error';

export interface EvidenceCheck {
  /** 'build' | 'suite_baseline' | 'suite_post_patch' | 'repro_red' | 'repro_green' | 'repro_reversal' */
  name: string;
  outcome: CheckOutcome;
  command: string;
  exit_code?: number;
  /** Bounded tail of combined stdout/stderr, secrets scrubbed. */
  output_tail: string;
}

export interface EvidenceRecord {
  version: 1;
  tier: EvidenceTier | null;
  /** Chronological; a retried check appears multiple times — the last entry per name is current. */
  checks: EvidenceCheck[];
  /** Per-test baseline comparison (Phase 1). Pre-existing failures are excluded from the gate. */
  suite?: {
    baseline_failed_tests: string[];
    new_failures: string[];
  };
  /** Repro-gate details (Phase 2). */
  repro?: {
    content_hash: string;
    asserts_behavior: boolean;
    path: string;
  };
}
```

**Step 2: Extend `Incident`** (same file, inside the `Incident` interface after `root_cause?: string;` ~line 168):

```ts
  /** Structured verification evidence for the latest fix attempt. */
  verification_evidence?: EvidenceRecord;
  /** The candidate diff preserved on needs_human so "review the candidate diff" is actionable. */
  candidate_diff?: string;
```

**Step 3: Verify:** `pnpm --filter @opslane/shared build && pnpm --filter @opslane/worker build`

**Step 4: Commit:** `git add shared/src/types.ts && git commit -m "feat(shared): EvidenceRecord contract for evidence-tiered verification"`

---

## Task 3: Evidence recorder (`evidence.ts`)

Pure logic: append checks, compute the tier, bound + scrub outputs.

**Files:**
- Create: `packages/worker/src/harness/evidence.ts`
- Test: `packages/worker/src/harness/__tests__/evidence.test.ts`

**Step 1: Write the failing test**

```ts
// packages/worker/src/harness/__tests__/evidence.test.ts
import { describe, it, expect } from 'vitest';
import { createEvidenceRecorder, computeTier } from '../evidence.js';
import type { EvidenceCheck } from '@opslane/shared';

const check = (name: string, outcome: EvidenceCheck['outcome']): EvidenceCheck =>
  ({ name, outcome, command: 'cmd', output_tail: '' });

describe('computeTier', () => {
  it('is null when nothing passed', () => {
    expect(computeTier([check('build', 'failed')])).toBeNull();
  });

  it('E0 when only the build passed', () => {
    expect(computeTier([check('build', 'passed'), check('suite_post_patch', 'failed')])).toBe('E0');
  });

  it('E1 requires a recorded, comparable baseline — post-patch pass alone is only E0', () => {
    expect(computeTier([check('build', 'passed'), check('suite_post_patch', 'passed')])).toBe('E0');
  });

  it('E1 when build, recorded baseline, and post-patch suite all line up', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_baseline', 'failed'), // pre-existing failures still make a comparable baseline
      check('suite_post_patch', 'passed'),
    ])).toBe('E1');
  });

  it('E1 reachable when the build was skipped (no build script) but baseline + suite passed', () => {
    expect(computeTier([
      check('build', 'skipped_no_runner'),
      check('suite_baseline', 'passed'),
      check('suite_post_patch', 'passed'),
    ])).toBe('E1');
  });

  it('an infra_error baseline is NOT comparable — caps at E0', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_baseline', 'infra_error'),
      check('suite_post_patch', 'passed'),
    ])).toBe('E0');
  });

  it('uses the LAST entry per check name (retries append)', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_baseline', 'passed'),
      check('suite_post_patch', 'failed'),
      check('suite_post_patch', 'passed'),
    ])).toBe('E1');
  });

  it('E2 requires red AND green AND reversal — green+reversal without red stays E1', () => {
    const e1Checks = [check('build', 'passed'), check('suite_baseline', 'passed'), check('suite_post_patch', 'passed')];
    expect(computeTier([...e1Checks, check('repro_green', 'passed'), check('repro_reversal', 'passed')])).toBe('E1');
    expect(computeTier([
      ...e1Checks,
      check('repro_red', 'passed'),
      check('repro_green', 'passed'),
      check('repro_reversal', 'passed'),
    ])).toBe('E2');
  });

  it('infra_error is never evidence — suite infra_error caps at E0', () => {
    expect(computeTier([check('build', 'passed'), check('suite_post_patch', 'infra_error')])).toBe('E0');
  });
});

describe('createEvidenceRecorder', () => {
  it('records checks with scrubbed, bounded output tails', () => {
    const rec = createEvidenceRecorder();
    rec.addCheck('build', 'failed', { command: 'npm run build', exitCode: 1, output: 'x'.repeat(5000) + ' ghp_secret123' });
    const record = rec.record();
    expect(record.version).toBe(1);
    expect(record.checks).toHaveLength(1);
    expect(record.checks[0].output_tail.length).toBeLessThanOrEqual(2000);
    expect(record.checks[0].output_tail).toContain('[REDACTED]');
    expect(record.checks[0].exit_code).toBe(1);
  });

  it('carries the suite comparison and computes the tier', () => {
    const rec = createEvidenceRecorder();
    rec.addCheck('build', 'passed', { command: 'npm run build' });
    rec.addCheck('suite_baseline', 'failed', { command: 'vitest run' });
    rec.addCheck('suite_post_patch', 'passed', { command: 'vitest run' });
    rec.setSuiteComparison({ baseline_failed_tests: ['a::t1'], new_failures: [] });
    const record = rec.record();
    expect(record.tier).toBe('E1');
    expect(record.suite?.baseline_failed_tests).toEqual(['a::t1']);
  });

  it('bounds and scrubs suite test identifiers (max 50 per list, secrets redacted)', () => {
    const rec = createEvidenceRecorder();
    rec.setSuiteComparison({
      baseline_failed_tests: Array.from({ length: 80 }, (_, i) => `f.test.ts::t${i} ghp_leaked123`),
      new_failures: [],
    });
    const suite = rec.record().suite!;
    expect(suite.baseline_failed_tests).toHaveLength(51); // 50 + truncation marker
    expect(suite.baseline_failed_tests[50]).toBe('... 30 more');
    expect(suite.baseline_failed_tests[0]).toContain('[REDACTED]');
  });
});
```

**Step 2: Run — expect FAIL** (module not found).

**Step 3: Implement**

```ts
// packages/worker/src/harness/evidence.ts
import type { CheckOutcome, EvidenceCheck, EvidenceRecord, EvidenceTier } from '@opslane/shared';
import { scrubSecrets } from './redact.js';

const MAX_OUTPUT_TAIL = 2000;

export interface EvidenceRecorder {
  addCheck(
    name: string,
    outcome: CheckOutcome,
    opts?: { command?: string; exitCode?: number; output?: string },
  ): void;
  setSuiteComparison(cmp: { baseline_failed_tests: string[]; new_failures: string[] }): void;
  record(): EvidenceRecord;
}

/**
 * Tier semantics: the tier reflects the strongest evidence actually achieved.
 * A skipped build (repo has no build script) does not block E1 — but a FAILED
 * or infra-errored check can never be upgraded past.
 *
 * E1 requires a RECORDED, comparable baseline (suite_baseline passed|failed) in
 * addition to the post-patch suite pass — a post-patch pass with no baseline is
 * not "no new failures", it is only E0-grade evidence (plan review, blocking #1).
 * Until Task 14 wires the baseline, the fix pipeline therefore caps at E0.
 * E2 requires the full repro invariant: red AND green AND reversal.
 */
export function computeTier(checks: EvidenceCheck[]): EvidenceTier | null {
  const last = (name: string): CheckOutcome | undefined =>
    [...checks].reverse().find((c) => c.name === name)?.outcome;

  const build = last('build');
  const baseline = last('suite_baseline');
  const suite = last('suite_post_patch');
  const e0 = build === 'passed';
  const buildOk = e0 || build === 'skipped_no_runner';
  const baselineComparable = baseline === 'passed' || baseline === 'failed';
  const e1 = buildOk && baselineComparable && suite === 'passed';
  const e2 =
    e1 &&
    last('repro_red') === 'passed' &&
    last('repro_green') === 'passed' &&
    last('repro_reversal') === 'passed';

  if (e2) return 'E2';
  if (e1) return 'E1';
  if (e0) return 'E0';
  return null;
}

export function createEvidenceRecorder(): EvidenceRecorder {
  const checks: EvidenceCheck[] = [];
  let suite: EvidenceRecord['suite'];

  return {
    addCheck(name, outcome, opts) {
      checks.push({
        name,
        outcome,
        command: opts?.command ?? '',
        ...(opts?.exitCode !== undefined ? { exit_code: opts.exitCode } : {}),
        output_tail: scrubSecrets(opts?.output ?? '').slice(-MAX_OUTPUT_TAIL),
      });
    },
    setSuiteComparison(cmp) {
      // Bound + scrub identifiers, not just output tails (plan review, corrections).
      const boundList = (ids: string[]): string[] => {
        const scrubbed = ids.slice(0, 50).map((id) => scrubSecrets(id).slice(0, 300));
        return ids.length > 50 ? [...scrubbed, `... ${ids.length - 50} more`] : scrubbed;
      };
      suite = {
        baseline_failed_tests: boundList(cmp.baseline_failed_tests),
        new_failures: boundList(cmp.new_failures),
      };
    },
    record: () => ({
      version: 1,
      tier: computeTier(checks),
      checks: [...checks],
      ...(suite ? { suite } : {}),
    }),
  };
}
```

**Step 4: Run test — expect PASS. Step 5: `pnpm --filter @opslane/worker build`.**

**Step 6: Commit** (new files — `-am` would miss them; plan review):
`git add packages/worker/src/harness/evidence.ts packages/worker/src/harness/__tests__/evidence.test.ts && git commit -m "feat(worker): evidence recorder with tier computation"`

---

## Task 4: `createRepoSandbox` supports `setupCommands`

`agent-fix.ts` duplicates sandbox setup because `createRepoSandbox` can't run eval bug-patch commands. Add that, so Task 5 can consolidate.

**Files:**
- Modify: `packages/worker/src/harness/sandbox-repo.ts` (`createRepoSandbox`, ~line 75)
- Test: create `packages/worker/src/harness/__tests__/sandbox-repo-setup.test.ts`

**Step 1: Write the failing test**

```ts
// packages/worker/src/harness/__tests__/sandbox-repo-setup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SandboxRuntime } from '../sandbox-runtime.js';

const commands: string[] = [];
vi.mock('../sandbox-runtime.js', () => ({
  createSandboxRuntime: vi.fn(async (): Promise<SandboxRuntime> => ({
    commands: {
      run: async (cmd: string) => {
        commands.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    files: {
      read: async () => { throw new Error('not found'); },
      write: async () => undefined,
    },
    kill: async () => undefined,
  })),
}));

const { createRepoSandbox } = await import('../sandbox-repo.js');

beforeEach(() => { commands.length = 0; });

describe('createRepoSandbox setupCommands', () => {
  it('runs setup commands after the baseline commit and commits them separately', async () => {
    await createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
      defaultBranch: 'main',
      setupCommands: ['git apply bug.patch'],
    });
    const baselineIdx = commands.findIndex((c) => c.includes('baseline: setup'));
    const setupIdx = commands.findIndex((c) => c.includes('git apply bug.patch'));
    const evalCommitIdx = commands.findIndex((c) => c.includes('eval: setup'));
    expect(baselineIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeGreaterThan(baselineIdx);
    expect(evalCommitIdx).toBeGreaterThan(setupIdx);
  });

  it('runs no eval commit when setupCommands is absent', async () => {
    await createRepoSandbox({ repoUrl: 'https://github.com/o/r.git', defaultBranch: 'main' });
    expect(commands.some((c) => c.includes('eval: setup'))).toBe(false);
  });
});
```

**Step 2: Run — expect FAIL** (first test: `setupIdx` is `-1`).

**Step 3: Implement.** In `sandbox-repo.ts`, extend the opts type and append after the baseline commit (the `git commit -m "baseline: setup"` block, ~line 120):

```ts
export async function createRepoSandbox(opts: {
  repoUrl: string;
  defaultBranch: string;
  githubToken?: string;
  /** Shell commands run after install + baseline commit, then committed, so a
   * later diff only captures the agent's work (eval bug patches). */
  setupCommands?: string[];
}): Promise<RepoSandbox> {
```

```ts
  // after the baseline commit:
  if (opts.setupCommands && opts.setupCommands.length > 0) {
    for (const cmd of opts.setupCommands) {
      await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${cmd}`, { timeoutMs: 60_000 });
    }
    await sandbox.commands.run(
      `cd ${SANDBOX_REPO} && git add -A && git commit -m "eval: setup" --allow-empty`,
      { timeoutMs: 30_000 },
    );
  }
```

**Step 3b: Cleanup-on-error for the WHOLE factory lifecycle** (plan review, high #7). Today only the clone step kills the sandbox on failure; a throwing install, baseline commit, or setup command leaks a live E2B sandbox. Wrap everything after `createSandboxRuntime()` resolves:

```ts
  const sandbox = await createSandboxRuntime();
  try {
    // git config, .netrc, clone (keep its specific `clone failed:` error), install,
    // baseline commit, setupCommands, eval commit — the entire remaining setup
  } catch (err) {
    await sandbox.kill().catch(() => {});
    throw err;
  }
```

(The existing clone-failure branch keeps rethrowing its `clone failed: <scrubbed>` error from inside the try so `agent-fix.ts`'s `repo_access_denied` mapping still matches.)

Add two tests to `sandbox-repo-setup.test.ts`: a setup command that throws, and a baseline-commit `git commit` that throws — both assert `kill` was called exactly once and the error propagates.

**Step 4: Run test — expect PASS. Step 5: Full worker build + tests.**

**Step 6: Commit:** `git add packages/worker/src/harness/sandbox-repo.ts packages/worker/src/harness/__tests__/sandbox-repo-setup.test.ts && git commit -m "feat(worker): createRepoSandbox runs eval setupCommands with lifecycle cleanup"`

---

## Task 5: Consolidate agent-fix onto `createRepoSandbox` (one sandbox factory)

Delete the duplicated setup in `agent-fix.ts` (git config, .netrc, clone, .gitignore, install, baseline commit, setupCommands — lines ~536-615) and the duplicate `extractDiff` (lines ~1019-1032). This also gives the fix pipeline `ensureModernNode` for free.

**Files:**
- Modify: `packages/worker/src/agent-fix.ts`
- Modify (expectations only, if needed): `packages/worker/src/__tests__/agent-fix.test.ts`

**Step 1: Replace setup block.** In `runAgentFix`, replace everything from `sandbox = await traceSpan('sandbox-create', ...)` (line 536) through the end of the `sandbox-install` traceSpan block (line 615) with:

```ts
    let repoSandbox: RepoSandbox;
    try {
      repoSandbox = await traceSpan(
        'sandbox-setup',
        { 'repo.url': input.repoUrl.replace(/https:\/\/[^@]+@/g, 'https://***@') },
        () => createRepoSandbox({
          repoUrl: input.repoUrl,
          defaultBranch: input.defaultBranch,
          githubToken: input.githubToken,
          setupCommands: input.setupCommands,
        }),
      );
    } catch (setupErr: unknown) {
      const msg = scrubSecrets(setupErr instanceof Error ? setupErr.message : String(setupErr));
      if (msg.includes('clone failed')) {
        return {
          status: 'needs_human',
          reason: {
            reason_code: 'repo_access_denied',
            reason_message: `Failed to clone repository: ${msg}`,
            remediation: 'Ensure GITHUB_TOKEN has read access to the repository',
          },
        };
      }
      throw setupErr; // outer catch maps to worker_runtime_error
    }
    sandbox = repoSandbox.sandbox;
    const installSucceeded = repoSandbox.installSucceeded;
```

**Step 2: Fix imports.** Add at the top of `agent-fix.ts`:

```ts
import { createRepoSandbox, extractDiff, type RepoSandbox } from './harness/sandbox-repo.js';
```

Delete the local `extractDiff` function (lines ~1019-1032). Delete now-unused imports if any (`buildGitNetrc` stays only if still referenced — it won't be; remove it).

**Step 3: Build + run the worker suite.**
`pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`

Expected: `agent-fix.test.ts` still passes — it mocks `e2b`'s `Sandbox.create`, which `createRepoSandbox` also reaches via `createSandboxRuntime`. Two behaviors to sanity-check if anything drifts:
- Clone-failure tests: `createRepoSandbox` now throws `clone failed: ...`, which the new catch maps to the same `repo_access_denied` result.
- `Sandbox.create` rejection tests: the throw propagates to the outer catch → `worker_runtime_error`, same as before.
Fix only test *setup* (mock command routing), never the terminal-contract assertions.

**Step 4: Commit:** `git commit -am "refactor(worker): agent-fix uses the single createRepoSandbox factory"`

---

## Task 6: Build gate (E0) in the fix pipeline + evidence record in `AgentFixResult`

`runAgentFix` never calls `runBuildGate` today. Add it after the test gate in the attempt loop, and start recording evidence.

**Files:**
- Modify: `packages/worker/src/agent-fix.ts`
- Test: `packages/worker/src/__tests__/agent-fix.test.ts`

**Step 1: Write the failing tests.** In `agent-fix.test.ts`, add a module mock next to the existing `vi.mock` calls (top of file):

```ts
vi.mock('../harness/sandbox-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/sandbox-repo.js')>();
  return {
    ...actual,
    runBuildGate: vi.fn(async () => ({ outcome: 'passed', exitCode: 0, output: 'build ok' })),
  };
});
const { runBuildGate } = await import('../harness/sandbox-repo.js');
```

Reset it in the existing `beforeEach`:
`vi.mocked(runBuildGate).mockResolvedValue({ outcome: 'passed', exitCode: 0, output: 'build ok' });`

Then add tests (reuse this file's existing input factory and `makeAgentResult` helper; set up the "happy path to fix_ready" the same way the existing verified-PR test does):

```ts
describe('build gate (E0) and evidence record', () => {
  it('a failing build blocks fix_ready and is recorded as evidence', async () => {
    vi.mocked(runBuildGate).mockResolvedValue({ outcome: 'failed', exitCode: 2, output: 'tsc: error TS2345' });
    // arrange runAgentLoop + judge exactly like the existing fix_ready test
    const result = await runAgentFix(/* same input as the fix_ready test */);
    expect(result.status).toBe('needs_human');
    expect(result.evidence?.checks.some((c) => c.name === 'build' && c.outcome === 'failed')).toBe(true);
    expect(result.evidence?.tier).toBeNull();
  });

  it('fix_ready carries an evidence record with build + suite checks — tier caps at E0 until the baseline lands', async () => {
    // arrange the existing fix_ready happy path
    const result = await runAgentFix(/* same input */);
    expect(result.status).toBe('fix_ready');
    expect(result.evidence?.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['build', 'suite_post_patch']),
    );
    // Phase 0 has no suite_baseline check, so E1 is unreachable BY DESIGN
    // (plan review, blocking #1): a post-patch pass with no baseline proves
    // nothing about "new" failures. Task 14 upgrades this expectation to E1.
    expect(result.evidence?.tier).toBe('E0');
  });
});
```

**Step 2: Run — expect FAIL** (`evidence` undefined; build gate never called).

**Step 3: Implement.**

3a. `AgentFixResult` gains the field (top of `agent-fix.ts`):

```ts
import type { EvidenceRecord } from '@opslane/shared';
import { createEvidenceRecorder } from './harness/evidence.js';
import { runBuildGate } from './harness/sandbox-repo.js'; // extend the existing import

export interface AgentFixResult {
  status: 'fix_ready' | 'needs_human';
  diff?: string;
  confidence?: ConfidenceLevel;
  rootCause?: string;
  humanSummary?: string;
  affectedFiles?: string[];
  reason?: NeedsHumanReason;
  evidence?: EvidenceRecord;
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
```

3b. Create the recorder right after the Task 5 setup block:

```ts
    const evidence = createEvidenceRecorder();
```

3c. In the attempt loop, record the test gate and add the build gate. Replace the current post-test-gate block (`if (testResult.passed) { ... } lastTestOutput = ...; attempt++;`, lines ~799-807) with:

```ts
        evidence.addCheck(
          'suite_post_patch',
          testResult.skipped ? 'skipped_no_runner' : testResult.passed ? 'passed' : 'failed',
          { command: 'test gate', output: testResult.output },
        );

        if (!testResult.passed) {
          lastTestOutput = testResult.output;
          logger.warn('Test gate failed', { attempt, model: tier.model, output: testResult.output.slice(0, 500) });
          attempt++;
          continue;
        }

        // E0: the fix must not break the build (evidence-tiered verification, Phase 0).
        // Taxonomy (plan review, blocking #3): install failure and build
        // timeouts/crashes are infra_error — never "skipped" and never a
        // patch verdict. runBuildGate is extended (3c-bis below) to return
        // `outcome: CheckOutcome` + `exitCode` instead of only passed/skipped.
        const buildResult = installSucceeded
          ? await traceSpan(
              'build-gate',
              { 'build_gate.attempt': attempt, 'build_gate.tier': tierIdx },
              () => runBuildGate(sandbox!),
            )
          : { outcome: 'infra_error' as const, exitCode: undefined, output: 'dependency install failed — build cannot run' };
        evidence.addCheck('build', buildResult.outcome, {
          command: 'build gate (build script or tsc --noEmit)',
          exitCode: buildResult.exitCode,
          output: buildResult.output,
        });

        if (buildResult.outcome === 'failed') {
          lastTestOutput = `The build/typecheck failed after your change:\n${buildResult.output}`;
          logger.warn('Build gate failed', { attempt, model: tier.model });
          attempt++;
          continue;
        }
        if (buildResult.outcome === 'infra_error') {
          // Phase 0: record it and let the run proceed (it cannot count as
          // verification either way). Task 14 upgrades this to set
          // suiteInfraError so the floor throws VerificationInfraError and the
          // job machinery retries (3d-bis there).
        }

        testGatePassed = true;
        testGateSkipped = testResult.skipped;
        break;
```

3c-bis. **Extend `runBuildGate`** (`sandbox-repo.ts`) to return `{ outcome: CheckOutcome; exitCode?: number; output: string }`: timeout → `infra_error`; nonzero exit from a real build script → `failed` with the real exit code (the command result carries it); no build script/tsconfig → `skipped_no_runner`; success → `passed` with exit code 0. Update its one existing caller (`setup-agent.ts`) in the same commit — a thin `passed = outcome === 'passed' || outcome === 'skipped_no_runner'` adapter there keeps its behavior identical. Extend the existing `runBuildGate` unit tests for the timeout→infra_error and exit-code cases.

3d. Attach `evidence: evidence.record()` to **every** return statement after the recorder exists: the give-up return (~line 769), `budget_exhausted` (~line 841), both `malformed_diff` returns (~lines 855, 889), the `tests_failed` return (~line 866), the `fix_ready` return (~line 962), the below-floor `low_confidence_fix` return (~line 981), and the cascade-exhausted fallback (~line 993).

**Step 4: Run tests — expect PASS.** Also run the full worker suite; earlier tests may now see extra sandbox commands (build detection is mocked away, so they shouldn't).

**Step 5: Commit:** `git commit -am "feat(worker): E0 build gate in fix pipeline + evidence record"`

---

## Task 7: Thread evidence + candidate diff through pipeline → db → index

> **Ordering (plan review):** execute **Task 8 FIRST** (migration 014 + its clean/existing/reapply checks). This task's SQL references `candidate_diff` and `verification_evidence`, which do not exist until the migration runs — deploying worker writes before the migration breaks every status update. Task order on the branch: 6 → **8** → 7 → 9.

Fixes the design's fourth defect: `pipeline.ts` discards the candidate diff on every `needs_human`.

**Files:**
- Modify: `packages/worker/src/pipeline.ts`
- Modify: `packages/worker/src/db.ts` (`updateGroupStatus`, line 424)
- Modify: `packages/worker/src/index.ts` (lines 856-878)
- Tests: `packages/worker/src/__tests__/precision-gate.test.ts`, `packages/worker/src/__tests__/db-queries.test.ts`

**Step 1: Failing pipeline test.** Add to `precision-gate.test.ts`:

```ts
it('needs_human preserves the candidate diff and evidence for persistence', async () => {
  const diff = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n';
  mockRunAgentFix.mockResolvedValue({
    status: 'needs_human',
    diff,
    confidence: 'medium',
    rootCause: 'rc',
    reason: { reason_code: 'low_confidence_fix', reason_message: 'm', remediation: 'r' },
    evidence: { version: 1, tier: 'E0', checks: [] },
  });
  const r = await runPipeline(input());
  expect(r.status).toBe('needs_human');
  expect(r.candidateDiff).toBe(diff);
  expect(r.evidence?.tier).toBe('E0');
});

it('the hard precision guard also preserves diff + evidence', async () => {
  mockRunAgentFix.mockResolvedValue({
    status: 'fix_ready',
    diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
    confidence: 'medium',
    rootCause: 'rc',
    evidence: { version: 1, tier: 'E1', checks: [] },
  });
  const r = await runPipeline(input());
  expect(r.status).toBe('needs_human');
  expect(r.candidateDiff).toBeTruthy();
  expect(r.evidence?.tier).toBe('E1');
});
```

**Step 2: Run — expect FAIL** (`candidateDiff` undefined).

**Step 3: Implement `pipeline.ts`.**

```ts
import type { NeedsHumanReason, ConfidenceLevel, EvidenceRecord } from '@opslane/shared';
import { scrubSecrets } from './harness/redact.js';

export interface PipelineResult {
  status: 'pr_created' | 'needs_human';
  pr_url?: string;
  pr_number?: number;
  confidence?: ConfidenceLevel;
  reason?: NeedsHumanReason;
  /** Scrubbed + bounded candidate diff, preserved on needs_human for human review. */
  candidateDiff?: string;
  evidence?: EvidenceRecord;
}

const MAX_STORED_DIFF = 262_144;

function boundDiff(diff: string | undefined): string | undefined {
  if (!diff || diff.trim().length === 0) return undefined;
  const scrubbed = scrubSecrets(diff);
  return scrubbed.length > MAX_STORED_DIFF
    ? scrubbed.slice(0, MAX_STORED_DIFF) + '\n... [truncated]'
    : scrubbed;
}
```

Update the two early needs_human branches:

```ts
  if (fixResult.status === 'needs_human') {
    return {
      status: 'needs_human',
      reason: fixResult.reason,
      confidence: fixResult.confidence,
      candidateDiff: boundDiff(fixResult.diff),
      evidence: fixResult.evidence,
    };
  }

  if (fixResult.confidence !== 'high') {
    return {
      status: 'needs_human',
      confidence: fixResult.confidence,
      reason: buildReason(
        'low_confidence_fix',
        'A candidate fix was generated but did not clear the confidence bar for an automatic PR.',
      ),
      candidateDiff: boundDiff(fixResult.diff),
      evidence: fixResult.evidence,
    };
  }
```

Also update the comment above the guard (it says "the candidate diff itself is not stored" — no longer true). Add `evidence: fixResult.evidence` to the remaining needs_human returns (`malformed_diff`, push failure, PR failure — the diff exists there too: include `candidateDiff: boundDiff(diff)`), and to the `pr_created` return (`evidence: fixResult.evidence` only, no candidateDiff).

**Step 4: Failing db test.** Add to `db-queries.test.ts`:

```ts
it('persists candidate_diff and verification_evidence on needs_human', async () => {
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 'g1' }] });
  await updateGroupStatus('g1', 'p1', 'needs_human', {
    reason: { reason_code: 'low_confidence_fix', reason_message: 'm', remediation: 'r' },
    candidate_diff: 'DIFF',
    evidence: { version: 1, tier: 'E0', checks: [] },
  });
  const [sql, params] = mockQuery.mock.calls.at(-1) as [string, unknown[]];
  expect(sql).toContain('candidate_diff');
  expect(sql).toContain('verification_evidence');
  expect(params).toContain('DIFF');
  expect(params).toContain(JSON.stringify({ version: 1, tier: 'E0', checks: [] }));
});
```

**Step 5: Implement `db.ts`.** In `updateGroupStatus` (line 424): add to the `fields` type:

```ts
    candidate_diff?: string;
    evidence?: EvidenceRecord;
```

(import `EvidenceRecord` from `@opslane/shared`). In the SQL, after `remediation = $10,` add:

```sql
         candidate_diff = $11,
         verification_evidence = $12::jsonb,
```

Renumber the lease CTE params from `$11/$12/$13` to `$13/$14/$15`, and update the params array:

```ts
      reason?.remediation ?? null,
      fields?.candidate_diff ?? null,
      fields?.evidence ? JSON.stringify(fields.evidence) : null,
      ...(lease ? [lease.id, lease.workerId, lease.leaseGeneration] : []),
```

**Step 6: Implement `index.ts`** (lines 856-878). Pass through on both branches:

```ts
      await updateGroupStatus(job.errorGroupId, job.projectId, 'pr_created', {
        confidence: result.confidence,
        pr_url: result.pr_url,
        pr_number: result.pr_number,
        pr_fix_job_id: job.id,
        evidence: result.evidence,
      }, job);
```

```ts
      await updateGroupStatus(job.errorGroupId, job.projectId, 'needs_human', {
        reason: result.reason ?? buildReason('worker_runtime_error', 'Fix pipeline failed without a reason'),
        confidence: result.confidence,
        candidate_diff: result.candidateDiff,
        evidence: result.evidence,
      }, job);
```

**Step 7: Run the full worker suite — expect PASS** (existing `db.test.ts` integration tests hit a real schema; they will pass once Task 8's migration exists — if `db.test.ts` runs against a live DB locally and fails on the missing column, do Task 8's migration first, then re-run).

**Step 8: Commit:** `git commit -am "feat(worker): persist candidate diff + evidence record on terminal states"`

---

## Task 8: Migration 014 + Go read/write surfaces

**Files:**
- Create: `packages/ingestion/db/migrations/014_verification_evidence.sql`
- Modify: `packages/ingestion/db/queries.go` (ErrorGroup SELECT lists ~L595 and ~L790; requeue clearing ~L549)
- Modify: the `db.ErrorGroup` struct (find with `grep -rn "type ErrorGroup struct" packages/ingestion/db/`)
- Modify: `packages/ingestion/handler/read_api.go` (`incidentJSON` ~L27, `toIncidentJSON` ~L66)
- Test: the existing read-API handler test (find with `grep -rln "toIncidentJSON\|incidents/" packages/ingestion/handler/*_test.go`)

**Step 1: Migration** (idempotent, matching the `001` pattern):

```sql
-- 014_verification_evidence.sql
-- Evidence-tiered verification (Phase 0): persist the structured evidence
-- record and the candidate diff so needs_human writeups show their proof.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS verification_evidence JSONB;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS candidate_diff TEXT;
```

**Step 2: Failing Go test.** In the read-API handler test, extend an existing incident-serialization case: seed/construct an `ErrorGroup` with `VerificationEvidence` set to `{"version":1,"tier":"E0","checks":[]}` and `CandidateDiff` set, assert the JSON response contains `verification_evidence.tier == "E0"` and `candidate_diff`. Run `(cd packages/ingestion && go test ./handler/...)` — expect compile FAIL (fields don't exist).

**Step 3: Implement Go.**

3a. `ErrorGroup` struct — add (match neighboring nullable-field style):

```go
	VerificationEvidence []byte  // raw JSONB; nil when absent
	CandidateDiff        *string
```

3b. **Detail query ONLY** (plan review, high #5): add `verification_evidence, candidate_diff` to the single-incident/detail SELECT and its `Scan`. The incident **list** query must NOT select them — a 256 KiB diff per row would inflate every list response. Leave the list scan writing zero values for both fields. Add a Go handler test asserting the list endpoint's JSON items contain neither `candidate_diff` nor `verification_evidence` even when the columns are populated, while the detail endpoint returns both.

3c. Requeue-on-recurrence (~L549, where `reason_code/reason_message/remediation` are NULLed): also clear the stale proof:

```sql
    candidate_diff = NULL,
    verification_evidence = NULL,
```

3d. `read_api.go`:

```go
	VerificationEvidence json.RawMessage `json:"verification_evidence,omitempty"`
	CandidateDiff        *string         `json:"candidate_diff,omitempty"`
```

and in `toIncidentJSON`:

```go
	if len(g.VerificationEvidence) > 0 {
		inc.VerificationEvidence = json.RawMessage(g.VerificationEvidence)
	}
	inc.CandidateDiff = g.CandidateDiff
```

**Step 4: Verify:** `(cd packages/ingestion && go build ./... && go test ./...)` — expect PASS.

**Step 4b: Migration checks** (required by `packages/ingestion/AGENTS.md`; plan review): run the migration three ways and confirm each succeeds —
1. **Clean database:** disposable Postgres (never the retained dev DB), apply all migrations from scratch.
2. **Existing database:** apply `014` on a database already at `013`.
3. **Re-apply:** run `014` a second time — the `IF NOT EXISTS` guards must make it a no-op, not an error.

**Step 5: Commit:** `git add packages/ingestion/db/migrations/014_verification_evidence.sql packages/ingestion/db/queries.go packages/ingestion/handler/read_api.go && git add -u packages/ingestion && git commit -m "feat(ingestion): store + expose verification_evidence and candidate_diff"`

---

## Task 9: Dashboard surfaces the evidence + candidate diff

**Files:**
- Modify: `packages/dashboard/src/types/api.ts` (~line 47, near `NeedsHumanReason`)
- Create: `packages/dashboard/src/components/EvidenceCard.vue` (extracted so it is unit-testable; plan review — "its test command currently passes with no tests")
- Test: `packages/dashboard/src/components/__tests__/evidence-card.test.ts`
- Modify: `packages/dashboard/src/views/IncidentDetail.vue` (insert after the needs-human reason block, line 497)

**Step 1: Types** (dashboard keeps its own inline contract copies):

```ts
export type CheckOutcome = 'passed' | 'failed' | 'skipped_no_runner' | 'infra_error';

export interface EvidenceCheck {
  name: string;
  outcome: CheckOutcome;
  command: string;
  exit_code?: number;
  output_tail: string;
}

export interface EvidenceRecord {
  version: 1;
  tier: 'E0' | 'E1' | 'E2' | null;
  checks: EvidenceCheck[];
  suite?: { baseline_failed_tests: string[]; new_failures: string[] };
}
```

Add to the `Incident` interface:

```ts
  verification_evidence?: EvidenceRecord;
  candidate_diff?: string;
```

**Step 2: Template.** Insert after the reason block (line 497). All values render via `v-text`/interpolation (model output and repo content are untrusted — never `v-html`). Reuse the color utility classes already used in this file (`text-amber`, `text-indigo`, `text-text-muted`, etc.):

```html
        <!-- Verification evidence -->
        <div
          v-if="incident.verification_evidence"
          class="p-4 bg-surface border border-border rounded-lg space-y-3"
        >
          <p class="text-xs font-medium text-text-muted uppercase tracking-wide">
            Verification evidence
            <span
              v-if="incident.verification_evidence.tier"
              class="ml-2 px-1.5 py-0.5 rounded bg-indigo/10 text-indigo normal-case"
              v-text="incident.verification_evidence.tier"
            ></span>
          </p>
          <ul class="space-y-1">
            <li
              v-for="(check, i) in incident.verification_evidence.checks"
              :key="i"
              class="text-sm text-text"
            >
              <span v-text="check.name"></span>:
              <span
                :class="check.outcome === 'passed' ? 'text-indigo' : check.outcome === 'failed' ? 'text-amber' : 'text-text-muted'"
                v-text="check.outcome"
              ></span>
            </li>
          </ul>
          <p
            v-if="incident.verification_evidence.suite && incident.verification_evidence.suite.baseline_failed_tests.length > 0"
            class="text-xs text-text-faint"
          >
            {{ incident.verification_evidence.suite.baseline_failed_tests.length }} test(s) already failed before the patch (excluded from the gate).
          </p>
        </div>

        <!-- Candidate diff -->
        <div
          v-if="incident.status === 'needs_human' && incident.candidate_diff"
          class="p-4 bg-surface border border-border rounded-lg space-y-2"
        >
          <p class="text-xs font-medium text-text-muted uppercase tracking-wide">Candidate diff</p>
          <pre
            class="text-xs bg-surface border border-border p-3 rounded overflow-x-auto whitespace-pre text-text max-h-96"
            v-text="incident.candidate_diff"
          ></pre>
        </div>
```

**Step 2b: Component extraction + a real rendering test.** Put the evidence markup in `EvidenceCard.vue` (prop: `evidence: EvidenceRecord`) and mount it from `IncidentDetail.vue`; the candidate-diff block stays in the view. Then write an actual test (Vitest + `@vue/test-utils`, jsdom environment — both already in the workspace; add `@vue/test-utils` as a dashboard devDependency if absent):

```ts
// packages/dashboard/src/components/__tests__/evidence-card.test.ts
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import EvidenceCard from '../EvidenceCard.vue';

describe('EvidenceCard', () => {
  it('renders the tier badge and one line per check with its outcome', () => {
    const wrapper = mount(EvidenceCard, { props: { evidence: {
      version: 1, tier: 'E1',
      checks: [
        { name: 'build', outcome: 'passed', command: '', output_tail: '' },
        { name: 'suite_post_patch', outcome: 'failed', command: '', output_tail: '' },
      ],
      suite: { baseline_failed_tests: ['a::t1'], new_failures: [] },
    } } });
    expect(wrapper.text()).toContain('E1');
    expect(wrapper.text()).toContain('build');
    expect(wrapper.text()).toContain('failed');
    expect(wrapper.text()).toContain('1 test(s) already failed before the patch');
  });

  it('never renders model/repo output as HTML', () => {
    const wrapper = mount(EvidenceCard, { props: { evidence: {
      version: 1, tier: null,
      checks: [{ name: '<img src=x onerror=alert(1)>', outcome: 'passed', command: '', output_tail: '' }],
    } } });
    expect(wrapper.html()).not.toContain('<img src=x');
  });
});
```

Confirm the dashboard `test` script actually executes Vitest (if it is currently a no-op, point it at `vitest run`) — this task must FAIL before the component exists and PASS after, like every other task here.

**Step 3: Verify:** `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`

**Step 4: Commit:** `git add packages/dashboard/src/types/api.ts packages/dashboard/src/components/EvidenceCard.vue packages/dashboard/src/components/__tests__/evidence-card.test.ts packages/dashboard/src/views/IncidentDetail.vue && git add -u packages/dashboard && git commit -m "feat(dashboard): render verification evidence and candidate diff"`

---

## Task 10: Phase 0 gate — full verification + live smoke

**Step 1: Full repository gate:**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Step 2: Live smoke** (pipeline behavior changed — required by root `AGENTS.md`): apply migrations, run `scripts/seed-e2e.sql`, rebuild ingestion + worker images, send an event to `http://localhost:8082/api/v1/events` using `test-fixtures/vue-app`, and confirm:
- the job reaches a terminal state,
- on `needs_human`, `SELECT candidate_diff IS NOT NULL, verification_evidence FROM error_groups WHERE id = ...` shows both persisted,
- the incident detail page renders the evidence card.

**Step 3: Commit any smoke fixes, then:** `git commit -am "chore: phase 0 verification" --allow-empty` (marker commit; skip if nothing changed).

---

# Phase 1 — Make E1 honest

## Task 11: Reason-code plumbing (`repro_not_achievable`, `verification_infra_error`)

One task, all consumers (design Codex #20). The Go side mirrors strings, so nothing forces sync at compile time — this task IS the sync.

**Files:**
- Modify: `shared/src/types.ts` (ReasonCode union, line 103)
- Modify: `packages/worker/src/reason-codes.ts` (`DEFAULT_REMEDIATION`)
- Modify: `packages/ingestion/db/queries.go` (`nonRetriableReasonCodes`, ~L205)
- Modify: `packages/ingestion/db/requeue_internal_test.go` (~L15)
- Modify: `packages/ingestion/db/regression_test.go` (~L152 — the permanence catalog; `repro_not_achievable` must be listed as permanent or this test fails; plan review, high #6)
- Modify: `test-e2e/needs-human-contract.test.ts` (`REASON_CODES`, ~L31)
- Modify: `docs/reference/reason-codes.md` (enforced by `scripts/check-docs-drift.mjs` — `pnpm test` FAILS if the two new codes are missing here; plan review, high #6)
- Modify: `docs/architecture/precision.md` (~L17 — currently states candidate diffs are not stored and that suite-pass is the verification gate; both statements become false in this branch and must be rewritten to describe the evidence record)

**Step 1: Shared union** — after `'low_confidence_fix'`:

```ts
  | 'repro_not_achievable'
  | 'verification_infra_error'
```

**Step 2: Build worker — expect compile FAIL** (`DEFAULT_REMEDIATION` is `Record<ReasonCode, string>`, now missing two keys — this is the designed-in failing test).
`pnpm --filter @opslane/shared build && pnpm --filter @opslane/worker build`

**Step 3: Remediation entries** in `reason-codes.ts`:

```ts
  repro_not_achievable:
    'Review the candidate diff and evidence manually — Opslane could not construct a reliable reproduction test for this error, so the fix is verified only against the existing suite.',
  verification_infra_error:
    'No immediate action needed — verification infrastructure failed (dependency install, test runner crash, or timeout), so the fix could not be proven either way. It will be retried on recurrence; if it persists, check worker logs.',
```

Rebuild worker — expect PASS.

**Step 4: Go policy.** In `nonRetriableReasonCodes`:

```go
	// The agent produced a writeup but a reproduction could not be constructed.
	// Keep the writeup terminal on recurrence, like low_confidence_fix.
	"repro_not_achievable": {},
	// verification_infra_error is intentionally absent: infra failures are
	// transient, so recurrence should re-queue and retry verification.
```

**Step 5: Go test.** In `requeue_internal_test.go`, add two rows to the existing table (match its exact shape):
- `needs_human` + `repro_not_achievable` → NOT eligible
- `needs_human` + `verification_infra_error` → eligible

Run `(cd packages/ingestion && go test ./db/...)` — expect PASS.

**Step 6: e2e catalog.** Add both codes to `REASON_CODES` in `test-e2e/needs-human-contract.test.ts`.

**Step 6b: Permanence catalog.** Add `repro_not_achievable` to the permanent set in `packages/ingestion/db/regression_test.go` (~L152). `verification_infra_error` is deliberately NOT permanent (transient). Run `(cd packages/ingestion && go test ./db/...)`.

**Step 6c: Docs (drift-enforced).** Add both codes with their remediation text to `docs/reference/reason-codes.md`, then run `node scripts/check-docs-drift.mjs` — it must pass or `pnpm test` fails at the gate. Update `docs/architecture/precision.md`: replace "the candidate diff itself is not stored" and the suite-pass-as-gate description with the evidence-record model (tiers, baseline comparison, infra taxonomy).

**Step 7: Commit:** `git add shared/src/types.ts packages/worker/src/reason-codes.ts packages/ingestion/db/queries.go packages/ingestion/db/requeue_internal_test.go packages/ingestion/db/regression_test.go test-e2e/needs-human-contract.test.ts docs/reference/reason-codes.md docs/architecture/precision.md && git commit -m "feat: repro_not_achievable + verification_infra_error reason codes across the contract"`

---

## Task 12: Test-runner module — pure logic (command selection, JSON parsing, baseline comparison)

> **Scope (explicit, plan review):** Phase 1 supports **root-package Vitest and a root `test` script only**. Workspaces, nested apps, alternative Vitest config extensions, Jest, and Playwright are out of scope and resolve to `kind: 'none'` (→ `skipped_no_runner`, honest no-runner messaging) — not to a wrong command. Do not claim workspace support anywhere in messages or docs.

**Files:**
- Create: `packages/worker/src/harness/test-runner.ts`
- Test: `packages/worker/src/harness/__tests__/test-runner.test.ts`

**Step 1: Write the failing tests**

```ts
// packages/worker/src/harness/__tests__/test-runner.test.ts
import { describe, it, expect } from 'vitest';
import {
  selectTestCommand,
  parseSuiteJson,
  compareSuiteRuns,
  SUITE_RESULTS_PATH,
  type SuiteRun,
} from '../test-runner.js';

describe('selectTestCommand', () => {
  it('prefers repo-local vitest with an explicit JSON reporter (never npx)', () => {
    const plan = selectTestCommand({}, true, 'pnpm');
    expect(plan.kind).toBe('vitest');
    expect(plan.command).toBe(`./node_modules/.bin/vitest run --reporter=json --outputFile=${SUITE_RESULTS_PATH}`);
    expect(plan.command).not.toContain('npx');
  });

  it('falls back to the package test script with the right package manager', () => {
    expect(selectTestCommand({ scripts: { test: 'jest' } }, false, 'yarn'))
      .toEqual({ kind: 'npm-script', command: 'yarn test' });
    expect(selectTestCommand({ scripts: { test: 'jest' } }, false, 'npm'))
      .toEqual({ kind: 'npm-script', command: 'npm test' });
  });

  it('reports none when there is nothing to run', () => {
    expect(selectTestCommand({}, false)).toEqual({ kind: 'none', command: null });
  });
});

describe('parseSuiteJson', () => {
  const report = JSON.stringify({
    numTotalTests: 3,
    testResults: [{
      name: '/home/user/repo/src/__tests__/a.test.ts',
      assertionResults: [
        { fullName: 'a > passes', status: 'passed' },
        { fullName: 'a > fails', status: 'failed' },
        { fullName: 'a > skipped', status: 'skipped' },
      ],
    }],
  });

  it('extracts per-test statuses keyed by repo-relative file + full name', () => {
    const parsed = parseSuiteJson(report);
    expect(parsed.total).toBe(3);
    expect(parsed.tests.get('src/__tests__/a.test.ts::a > passes')).toBe('passed');
    expect(parsed.tests.get('src/__tests__/a.test.ts::a > fails')).toBe('failed');
    expect(parsed.tests.has('src/__tests__/a.test.ts::a > skipped')).toBe(false);
  });
});

const run = (outcome: SuiteRun['outcome'], tests: Array<[string, 'passed' | 'failed']> | null): SuiteRun => ({
  outcome,
  command: 'vitest run',
  tests: tests ? new Map(tests) : null,
  total: tests?.length ?? null,
  output: '',
});

describe('compareSuiteRuns — the SWE-bench invariant', () => {
  it('only pass→fail counts as a regression; pre-existing failures are excluded', () => {
    const baseline = run('failed', [['t1', 'passed'], ['t2', 'failed']]);
    const post = run('failed', [['t1', 'failed'], ['t2', 'failed']]);
    expect(compareSuiteRuns(baseline, post)).toEqual({
      baselineFailed: ['t2'],
      newFailures: ['t1'],
      missingFromPost: [],
      comparable: true,
    });
  });

  it('a test unknown to the baseline that fails post-patch is a new failure', () => {
    const baseline = run('passed', [['t1', 'passed']]);
    const post = run('failed', [['t1', 'passed'], ['t2', 'failed']]);
    expect(compareSuiteRuns(baseline, post).newFailures).toEqual(['t2']);
  });

  it('a baseline-passing test that disappears post-patch is a collection drop, not a pass', () => {
    const baseline = run('passed', [['t1', 'passed'], ['t2', 'passed']]);
    const post = run('passed', [['t1', 'passed']]);
    expect(compareSuiteRuns(baseline, post).missingFromPost).toEqual(['t2']);
  });

  it('a baseline-FAILING test that disappears post-patch is not a drop (it may have been deleted with cause)', () => {
    const baseline = run('failed', [['t1', 'passed'], ['t2', 'failed']]);
    const post = run('passed', [['t1', 'passed']]);
    expect(compareSuiteRuns(baseline, post).missingFromPost).toEqual([]);
  });

  it('coarse fallback: post failure only counts when the baseline passed', () => {
    expect(compareSuiteRuns(run('passed', null), run('failed', null)).newFailures).toEqual(['<suite>']);
    expect(compareSuiteRuns(null, run('failed', null)).newFailures).toEqual(['<suite>']);
  });

  it('coarse baseline-failed + post-failed is NOT comparable — it proves nothing either way', () => {
    const cmp = compareSuiteRuns(run('failed', null), run('failed', null));
    expect(cmp.newFailures).toEqual([]);
    expect(cmp.comparable).toBe(false);
  });

  it('coarse post pass IS comparable', () => {
    expect(compareSuiteRuns(run('failed', null), run('passed', null)).comparable).toBe(true);
  });
});
```

**Step 2: Run — expect FAIL** (module not found).

**Step 3: Implement** (pure parts only; `runSuite`/`planTests` come in Task 13):

```ts
// packages/worker/src/harness/test-runner.ts
import type { CheckOutcome } from '@opslane/shared';
import type { SandboxRuntime } from './sandbox-runtime.js';
import { scrubSecrets } from './redact.js';

const SANDBOX_REPO = '/home/user/repo';
export const SUITE_RESULTS_PATH = '/tmp/opslane-suite-results.json';
const SUITE_TIMEOUT_MS = 240_000;
const MAX_SUITE_OUTPUT = 4000;

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface TestPlan {
  kind: 'vitest' | 'npm-script' | 'none';
  command: string | null;
}

interface PackageJsonLike { scripts?: Record<string, string> }

/**
 * Choose an explicit, scoped test command (design Codex #12/#13).
 * Repo-local binaries only — never npx, which can hit the network.
 */
export function selectTestCommand(
  pkg: PackageJsonLike,
  vitestBinExists: boolean,
  pm: PackageManager = 'npm',
): TestPlan {
  if (vitestBinExists) {
    return {
      kind: 'vitest',
      command: `./node_modules/.bin/vitest run --reporter=json --outputFile=${SUITE_RESULTS_PATH}`,
    };
  }
  if (pkg.scripts?.['test']) {
    return { kind: 'npm-script', command: pm === 'npm' ? 'npm test' : `${pm} test` };
  }
  return { kind: 'none', command: null };
}

export type TestStatus = 'passed' | 'failed';

export interface ParsedSuite {
  tests: Map<string, TestStatus>;
  total: number;
}

interface JsonAssertion { fullName?: string; title?: string; status?: string }
interface JsonTestFile { name?: string; assertionResults?: JsonAssertion[] }
interface JsonReport { numTotalTests?: number; testResults?: JsonTestFile[] }

/** Parse the jest-format JSON emitted by `vitest run --reporter=json`. */
export function parseSuiteJson(raw: string): ParsedSuite {
  const report = JSON.parse(raw) as JsonReport;
  const tests = new Map<string, TestStatus>();
  for (const file of report.testResults ?? []) {
    const fileName = (file.name ?? '').replace(`${SANDBOX_REPO}/`, '');
    for (const assertion of file.assertionResults ?? []) {
      const id = `${fileName}::${assertion.fullName ?? assertion.title ?? ''}`;
      if (assertion.status === 'passed') tests.set(id, 'passed');
      else if (assertion.status === 'failed') tests.set(id, 'failed');
      // skipped/todo/pending prove nothing — ignore.
    }
  }
  return { tests, total: report.numTotalTests ?? tests.size };
}

export interface SuiteRun {
  outcome: CheckOutcome;
  command: string;
  /** Per-test results when the runner produced parseable JSON; null for coarse runs. */
  tests: Map<string, TestStatus> | null;
  total: number | null;
  /** Real process exit code when known (plan review: the schema declares exit
   * codes — the wiring must actually supply them). */
  exitCode?: number;
  output: string;
}

export interface SuiteComparison {
  baselineFailed: string[];
  newFailures: string[];
  /** Baseline-PASSING tests that were not collected post-patch — an unexplained
   * collection drop is treated as a regression, not silently forgiven. */
  missingFromPost: string[];
  /** True only when the comparison can support an E1 claim: per-test data on
   * both sides, or a coarse post run that cleanly passed. */
  comparable: boolean;
}

/**
 * SWE-bench invariant (design Codex #11): only pass→fail counts as a
 * regression. Pre-existing failures are excluded from the gate but recorded.
 * Plan-review hardening (blocking #2):
 * - baseline-passing tests that disappear post-patch are regressions;
 * - coarse (no per-test data) comparisons are only `comparable` when the post
 *   run outright passed — baseline-failed + post-failed proves nothing.
 */
export function compareSuiteRuns(baseline: SuiteRun | null, post: SuiteRun): SuiteComparison {
  if (post.tests && baseline?.tests) {
    const baselineTests = baseline.tests;
    const baselineFailed = [...baselineTests.entries()]
      .filter(([, s]) => s === 'failed')
      .map(([id]) => id);
    const newFailures = [...post.tests.entries()]
      .filter(([id, s]) => s === 'failed' && baselineTests.get(id) !== 'failed')
      .map(([id]) => id);
    const missingFromPost = [...baselineTests.entries()]
      .filter(([id, s]) => s === 'passed' && !post.tests!.has(id))
      .map(([id]) => id);
    return { baselineFailed, newFailures, missingFromPost, comparable: true };
  }
  const baselineFailedCoarse = baseline?.outcome === 'failed';
  const postPassed = post.outcome === 'passed';
  return {
    baselineFailed: baselineFailedCoarse ? ['<suite>'] : [],
    newFailures: !postPassed && !baselineFailedCoarse ? ['<suite>'] : [],
    missingFromPost: [],
    // Coarse data can only support a claim when the post run cleanly passed.
    comparable: postPassed,
  };
}

function bound(raw: string): string {
  return scrubSecrets(raw).slice(-MAX_SUITE_OUTPUT);
}
```

(Leave `SandboxRuntime`, `SUITE_TIMEOUT_MS`, and `bound` in place — Task 13 uses them; if the linter complains about unused symbols, add them in Task 13 instead.)

**Step 4: Run tests — expect PASS. Step 5: Commit** (new files — `-am` would miss them):
`git add packages/worker/src/harness/test-runner.ts packages/worker/src/harness/__tests__/test-runner.test.ts && git commit -m "feat(worker): test-runner command selection, JSON parsing, baseline comparison"`

---

## Task 13: `planTests` + `runSuite` — sandbox execution with the failure taxonomy

**Files:**
- Modify: `packages/worker/src/harness/test-runner.ts`
- Test: `packages/worker/src/harness/__tests__/test-runner.test.ts` (append)

**Step 1: Write the failing tests** (fake sandbox — no mocks of our own module):

```ts
// append to test-runner.test.ts
import type { SandboxRuntime } from '../sandbox-runtime.js';
import { planTests, runSuite } from '../test-runner.js';

function fakeSandbox(opts: {
  files?: Record<string, string>;
  onRun?: (cmd: string) => { stdout?: string; throwMsg?: string };
}): SandboxRuntime {
  return {
    commands: {
      run: async (cmd: string) => {
        const behavior = opts.onRun?.(cmd);
        if (behavior?.throwMsg) throw new Error(behavior.throwMsg);
        return { exitCode: 0, stdout: behavior?.stdout ?? '', stderr: '' };
      },
    },
    files: {
      read: async (path: string) => {
        const content = opts.files?.[path];
        if (content === undefined) throw new Error('not found');
        return content;
      },
      write: async () => undefined,
    },
    kill: async () => undefined,
  };
}

const vitestReport = (statuses: Array<'passed' | 'failed'>): string => JSON.stringify({
  numTotalTests: statuses.length,
  testResults: [{
    name: '/home/user/repo/src/a.test.ts',
    assertionResults: statuses.map((status, i) => ({ fullName: `t${i}`, status })),
  }],
});

describe('planTests', () => {
  it('picks vitest when the repo-local binary exists', async () => {
    const sb = fakeSandbox({ files: {
      '/home/user/repo/package.json': '{"scripts":{"test":"vitest"}}',
      '/home/user/repo/node_modules/.bin/vitest': '#!/bin/sh',
      '/home/user/repo/pnpm-lock.yaml': '',
    } });
    expect((await planTests(sb)).kind).toBe('vitest');
  });

  it('reports none for a repo with no runner', async () => {
    const sb = fakeSandbox({ files: { '/home/user/repo/package.json': '{}' } });
    expect((await planTests(sb)).kind).toBe('none');
  });
});

describe('runSuite taxonomy', () => {
  const plan = { kind: 'vitest' as const, command: `./node_modules/.bin/vitest run --reporter=json --outputFile=${SUITE_RESULTS_PATH}` };

  it('passed: clean run with parseable results', async () => {
    const sb = fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: vitestReport(['passed', 'passed']) },
      onRun: () => ({}),
    });
    const r = await runSuite(sb, plan);
    expect(r.outcome).toBe('passed');
    expect(r.total).toBe(2);
  });

  it('failed: nonzero exit with parseable results containing failures', async () => {
    const sb = fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: vitestReport(['passed', 'failed']) },
      onRun: (cmd) => cmd.includes('vitest') ? { throwMsg: 'Command exited with code 1' } : {},
    });
    expect((await runSuite(sb, plan)).outcome).toBe('failed');
  });

  it('infra_error: timeout', async () => {
    const sb = fakeSandbox({ onRun: (cmd) => cmd.includes('vitest') ? { throwMsg: 'Command timed out after 240000ms' } : {} });
    expect((await runSuite(sb, plan)).outcome).toBe('infra_error');
  });

  it('infra_error: runner crashed without producing results', async () => {
    const sb = fakeSandbox({ onRun: (cmd) => cmd.includes('vitest') ? { throwMsg: 'Command exited with code 137' } : {} });
    expect((await runSuite(sb, plan)).outcome).toBe('infra_error');
  });

  it('infra_error: zero-test collection is never evidence', async () => {
    const sb = fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: JSON.stringify({ numTotalTests: 0, testResults: [] }) },
      onRun: () => ({}),
    });
    expect((await runSuite(sb, plan)).outcome).toBe('infra_error');
  });

  it('infra_error: an all-skipped suite (numTotalTests > 0, nothing executed) is never evidence', async () => {
    const sb = fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: JSON.stringify({
        numTotalTests: 2,
        testResults: [{ name: '/home/user/repo/src/a.test.ts', assertionResults: [
          { fullName: 't1', status: 'skipped' }, { fullName: 't2', status: 'skipped' },
        ] }],
      }) },
      onRun: () => ({}),
    });
    expect((await runSuite(sb, plan)).outcome).toBe('infra_error');
  });

  it('infra_error: nonzero exit with parseable results but NO failed assertion is not a patch verdict', async () => {
    const sb = fakeSandbox({
      files: { [SUITE_RESULTS_PATH]: vitestReport(['passed', 'passed']) },
      onRun: (cmd) => cmd.includes('vitest') ? { throwMsg: 'Command exited with code 1' } : {},
    });
    expect((await runSuite(sb, plan)).outcome).toBe('infra_error');
  });

  it('skipped_no_runner for a none plan', async () => {
    expect((await runSuite(fakeSandbox({}), { kind: 'none', command: null })).outcome).toBe('skipped_no_runner');
  });
});
```

**Step 2: Run — expect FAIL** (`planTests`/`runSuite` not exported).

**Step 3: Implement** (append to `test-runner.ts`):

```ts
async function fileExists(sandbox: SandboxRuntime, path: string): Promise<boolean> {
  try { await sandbox.files.read(path); return true; } catch { return false; }
}

/** Detect the runner and the explicit command for this repo. */
export async function planTests(sandbox: SandboxRuntime): Promise<TestPlan> {
  let pkg: PackageJsonLike = {};
  try {
    pkg = JSON.parse(await sandbox.files.read(`${SANDBOX_REPO}/package.json`)) as PackageJsonLike;
  } catch { /* no package.json */ }
  const pm: PackageManager = (await fileExists(sandbox, `${SANDBOX_REPO}/pnpm-lock.yaml`)) ? 'pnpm'
    : (await fileExists(sandbox, `${SANDBOX_REPO}/yarn.lock`)) ? 'yarn'
      : 'npm';
  const vitestBinExists = await fileExists(sandbox, `${SANDBOX_REPO}/node_modules/.bin/vitest`);
  return selectTestCommand(pkg, vitestBinExists, pm);
}

/** Run the suite once, classifying the outcome per the failure taxonomy (Codex #16/#17). */
export async function runSuite(sandbox: SandboxRuntime, plan: TestPlan): Promise<SuiteRun> {
  if (plan.kind === 'none' || !plan.command) {
    return { outcome: 'skipped_no_runner', command: '', tests: null, total: null, output: 'No test runner detected' };
  }
  await sandbox.commands.run(`rm -f ${SUITE_RESULTS_PATH}`, { timeoutMs: 10_000 });

  let rawOutput = '';
  let exitedNonZero = false;
  try {
    const res = await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${plan.command}`, { timeoutMs: SUITE_TIMEOUT_MS });
    rawOutput = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('timed out') || msg.includes('Timeout')) {
      return { outcome: 'infra_error', command: plan.command, tests: null, total: null, output: bound(msg) };
    }
    exitedNonZero = true;
    rawOutput = msg;
  }
  const output = bound(rawOutput);

  if (plan.kind === 'vitest') {
    let parsed: ParsedSuite | null = null;
    try {
      parsed = parseSuiteJson(await sandbox.files.read(SUITE_RESULTS_PATH));
    } catch { /* missing or unparseable results file */ }
    if (!parsed) {
      // The runner crashed before producing results — infrastructure, not patch evidence.
      return { outcome: 'infra_error', command: plan.command, tests: null, total: null, output };
    }
    if (parsed.total === 0 || parsed.tests.size === 0) {
      // Zero-test collection — including an all-skipped suite where numTotalTests > 0
      // but nothing actually EXECUTED — is never evidence (Codex #13; plan review #2).
      return { outcome: 'infra_error', command: plan.command, tests: parsed.tests, total: parsed.total, output: `Zero executed tests. ${output}` };
    }
    const anyFailed = [...parsed.tests.values()].some((s) => s === 'failed');
    if (exitedNonZero && !anyFailed) {
      // Nonzero exit with no comparable assertion failure (config error, worker
      // crash after reporting, OOM in teardown) is infrastructure, never "passed"
      // and never a patch verdict (plan review, blocking #2).
      return { outcome: 'infra_error', command: plan.command, tests: parsed.tests, total: parsed.total, output: `Runner exited nonzero without a failed assertion. ${output}` };
    }
    return {
      outcome: anyFailed ? 'failed' : 'passed',
      command: plan.command,
      tests: parsed.tests,
      total: parsed.total,
      exitCode: exitedNonZero ? 1 : 0,
      output,
    };
  }

  // npm-script: coarse exit-code evidence only.
  return { outcome: exitedNonZero ? 'failed' : 'passed', command: plan.command, tests: null, total: null, exitCode: exitedNonZero ? 1 : 0, output };
}
```

**Step 4: Run tests — expect PASS. Step 5: Worker build. Step 6: Commit:**
`git commit -am "feat(worker): sandbox suite runner with failure taxonomy"`

---## Task 14: Wire baseline + post-patch comparison into agent-fix (replace `runTestGate`)

The most delicate task. `runTestGate` (agent-fix.ts line 87) dies; the loop uses `planTests`/`runSuite`/`compareSuiteRuns`; infra errors get their own reason code; skip vs infra produce different remediation text (Codex #23).

**Files:**
- Modify: `packages/worker/src/agent-fix.ts`
- Test: `packages/worker/src/__tests__/agent-fix.test.ts`

**Step 1: Write the failing tests.** Add a test-runner module mock next to the others:

```ts
vi.mock('../harness/test-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/test-runner.js')>();
  return {
    ...actual,
    planTests: vi.fn(async () => ({ kind: 'vitest', command: 'vitest run' })),
    runSuite: vi.fn(async () => ({ outcome: 'passed', command: 'vitest run', tests: null, total: 3, output: 'ok' })),
  };
});
const { planTests, runSuite } = await import('../harness/test-runner.js');
```

Reset both in `beforeEach` to those defaults. New tests:

```ts
describe('E1 baseline gate', () => {
  it('runs a baseline suite before the agent and compares post-patch per-test', async () => {
    vi.mocked(runSuite)
      .mockResolvedValueOnce({ outcome: 'failed', command: 'vitest run', tests: new Map([['t1', 'passed'], ['t2', 'failed']]), total: 2, output: 'baseline' })
      .mockResolvedValueOnce({ outcome: 'failed', command: 'vitest run', tests: new Map([['t1', 'passed'], ['t2', 'failed']]), total: 2, output: 'post' });
    // arrange the fix_ready happy path (agent + judge mocks)
    const result = await runAgentFix(/* happy-path input */);
    // Pre-existing failure t2 is excluded → gate passes → fix_ready
    expect(result.status).toBe('fix_ready');
    expect(result.evidence?.suite?.baseline_failed_tests).toEqual(['t2']);
    expect(result.evidence?.suite?.new_failures).toEqual([]);
  });

  it('a pass→fail regression blocks fix_ready', async () => {
    vi.mocked(runSuite)
      .mockResolvedValueOnce({ outcome: 'passed', command: 'vitest run', tests: new Map([['t1', 'passed']]), total: 1, output: 'baseline' })
      .mockResolvedValue({ outcome: 'failed', command: 'vitest run', tests: new Map([['t1', 'failed']]), total: 1, output: 'post' });
    const result = await runAgentFix(/* happy-path input */);
    expect(result.status).toBe('needs_human');
  });

  it('persistent suite infra_error → throws VerificationInfraError carrying the evidence (job machinery retries; terminal only on exhaustion)', async () => {
    vi.mocked(runSuite)
      .mockResolvedValueOnce({ outcome: 'passed', command: 'vitest run', tests: new Map([['t1', 'passed']]), total: 1, output: 'baseline' })
      .mockResolvedValue({ outcome: 'infra_error', command: 'vitest run', tests: null, total: null, output: 'runner crashed' });
    await expect(runAgentFix(/* happy-path input */)).rejects.toMatchObject({
      name: 'VerificationInfraError',
      evidence: expect.objectContaining({ version: 1 }),
    });
    // withInfraRetry means runSuite was attempted twice per gate before giving up.
  });

  it('no runner → low_confidence_fix with the no-runner message', async () => {
    vi.mocked(planTests).mockResolvedValue({ kind: 'none', command: null });
    const result = await runAgentFix(/* happy-path input */);
    expect(result.status).toBe('needs_human');
    expect(result.reason?.reason_code).toBe('low_confidence_fix');
    expect(result.reason?.reason_message).toContain('no test runner');
  });
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement in `agent-fix.ts`.**

3a. Imports:

```ts
import { planTests, runSuite, compareSuiteRuns, type SuiteRun, type TestPlan } from './harness/test-runner.js';
```

3b. **Delete** `runTestGate` and `TestGateResult` (lines 77-109).

3c. After the evidence recorder is created (Task 6) and before the model-cascade loop, add the baseline. Three plan-review requirements are folded in: **install failure is `infra_error`, not "no runner"** (blocking #3); **an infra-erroring gate is retried once in place** (blocking #3); and **the tree is restored after the baseline run** so snapshots/coverage/fixture mutations from the pre-run can never contaminate the candidate diff (high #4):

```ts
    /** Run a gate with one bounded in-place retry on infra_error (plan review #3). */
    const withInfraRetry = async (run: () => Promise<SuiteRun>): Promise<SuiteRun> => {
      const first = await run();
      if (first.outcome !== 'infra_error') return first;
      return run();
    };

    // E1 baseline (Codex #11): run the suite on HEAD before any patch so the
    // post-patch comparison can exclude pre-existing failures.
    let testPlan: TestPlan = { kind: 'none', command: null };
    let baselineRun: SuiteRun | null = null;
    if (!installSucceeded) {
      // Dependency install failed: verification infrastructure is broken.
      // This is infra_error, never skipped_no_runner (plan review, blocking #3).
      evidence.addCheck('suite_baseline', 'infra_error', {
        command: 'dependency install',
        output: 'npm install failed — the suite cannot run, so no verification claim is possible',
      });
      suiteInfraError = true;
    } else {
      testPlan = await planTests(sandbox);
      if (testPlan.kind !== 'none') {
        baselineRun = await traceSpan('suite-baseline', { 'suite.kind': testPlan.kind }, () =>
          withInfraRetry(() => runSuite(sandbox!, testPlan)),
        );
        evidence.addCheck('suite_baseline', baselineRun.outcome, {
          command: baselineRun.command,
          exitCode: baselineRun.exitCode,
          output: baselineRun.output,
        });
        if (baselineRun.outcome === 'infra_error') suiteInfraError = true;
        // Restore the tree to the baseline commit: test runs can write snapshots,
        // coverage, or mutate fixtures, and none of that may reach the agent's
        // diff (plan review, high #4).
        await sandbox.commands.run(
          `cd ${SANDBOX_REPO} && git checkout -- . && git clean -fd`,
          { timeoutMs: 30_000 },
        );
      }
    }
```

Also declare next to `totalTokenUsage`:

```ts
    let suiteInfraError = false;
```

3d. **Capture the candidate diff BEFORE the post-patch gates.** Immediately after the agent loop reports success — and before any suite/build gate runs — call `extractDiff` and hold the result. Gates may write snapshots, coverage output, or modified fixtures; the pre-gate capture is the only diff ever used for the judge, the PR, and persistence (plan review, high #4). After a failed attempt, the existing reset (`git checkout`/`git clean` between tiers) restores the tree, so gate side effects also never leak into later attempts.

Then, in the attempt loop, replace the old test-gate call (`const testResult = installSucceeded ? ... runTestGate ...`) and Task 6's `suite_post_patch` recording with:

```ts
        // E1 gate: post-patch suite vs the pre-patch baseline; only pass→fail
        // (or an unexplained collection drop) regresses.
        let testResult: { passed: boolean; skipped: boolean; output: string };
        if (!installSucceeded) {
          testResult = { passed: true, skipped: true, output: 'dependency install failed' };
          evidence.addCheck('suite_post_patch', 'infra_error', {
            command: 'dependency install',
            output: 'npm install failed — post-patch suite cannot run',
          });
        } else if (testPlan.kind === 'none') {
          testResult = { passed: true, skipped: true, output: 'No test runner detected' };
          evidence.addCheck('suite_post_patch', 'skipped_no_runner', { command: '', output: testResult.output });
        } else if (baselineRun && baselineRun.outcome === 'infra_error') {
          testResult = { passed: true, skipped: true, output: baselineRun.output };
          evidence.addCheck('suite_post_patch', 'infra_error', {
            command: baselineRun.command,
            output: 'Baseline suite run hit an infrastructure error; comparison not possible',
          });
        } else {
          const post = await traceSpan(
            'suite-post-patch',
            { 'suite.attempt': attempt, 'suite.tier': tierIdx },
            () => withInfraRetry(() => runSuite(sandbox!, testPlan)),
          );
          const cmp = compareSuiteRuns(baselineRun, post);
          evidence.setSuiteComparison({
            baseline_failed_tests: cmp.baselineFailed,
            new_failures: [...cmp.newFailures, ...cmp.missingFromPost.map((id) => `${id} [not collected post-patch]`)],
          });
          if (post.outcome === 'infra_error') {
            suiteInfraError = true;
            testResult = { passed: true, skipped: true, output: post.output };
            evidence.addCheck('suite_post_patch', 'infra_error', { command: post.command, exitCode: post.exitCode, output: post.output });
          } else {
            // Per-test data: pass iff no new failures AND no collection drops
            // (pre-existing failures may keep post.outcome === 'failed').
            // Coarse data: pass ONLY on an outright post pass — cmp.comparable
            // is false for baseline-failed + post-failed (plan review #2).
            const passed = post.tests
              ? cmp.newFailures.length === 0 && cmp.missingFromPost.length === 0
              : cmp.comparable;
            evidence.addCheck('suite_post_patch', passed ? 'passed' : 'failed', { command: post.command, exitCode: post.exitCode, output: post.output });
            testResult = { passed, skipped: false, output: post.output };
          }
        }
```

The rest of the loop (retry on `!passed`, then the Task 6 build gate, then break) is unchanged. **Note:** `verified = testGatePassed && !testGateSkipped` still holds — infra and no-runner both set `skipped: true`, so neither can ever count as verification.

3d-bis. **Bounded job-level retry for infra failures** (plan review, blocking #3 — "retry, then terminal on exhaustion" must actually be implemented, not just described). The in-gate `withInfraRetry` handles transient blips. For persistent infra failure, the below-floor return in 3e is reached with `suiteInfraError` set — but before returning terminal `needs_human`, throw a typed error so the existing job machinery retries the whole verification with backoff:

```ts
// harness/errors.ts (new, trivial)
export class VerificationInfraError extends Error {
  constructor(message: string, readonly evidence: EvidenceRecord) { super(message); this.name = 'VerificationInfraError'; }
}
```

In `agent-fix.ts` 3e: when `!verified && suiteInfraError`, `throw new VerificationInfraError(reasonMessage, evidence.record())` instead of returning. In `index.ts`'s job handler: catch `VerificationInfraError`; if the job has remaining attempts (the existing `attempt`/max-attempts machinery used by `failJob`), rethrow so the job requeues with backoff; on the final attempt, call `updateGroupStatus(..., 'needs_human', { reason: buildReason('verification_infra_error', err.message), evidence: err.evidence }, job)`. Add a test in `agent-fix.test.ts` asserting the throw carries the evidence record, and one in `index.test.ts` (or the job-handler test file) asserting final-attempt conversion to `verification_infra_error`.

3e. Below-floor reason split (replace the `reasonMessage` construction and `buildReason('low_confidence_fix', ...)` in the below-floor return, ~line 976):

```ts
      const belowFloorConfidence: ConfidenceLevel = qualityConfirmed ? 'medium' : 'low';
      if (!verified && suiteInfraError) {
        // Infra failure is not evidence about the patch: hand the decision to
        // the job-retry machinery (3d-bis). Terminal verification_infra_error
        // happens only in index.ts on final-attempt exhaustion.
        throw new VerificationInfraError(
          'Verification infrastructure failed (dependency install, test runner, or timeout), so the fix could not be proven either way.',
          evidence.record(),
        );
      }
      let reasonMessage: string;
      if (!verified) {
        reasonMessage = 'A candidate fix was generated but no test runner was available to verify it, so it did not clear the bar for an automatic PR.';
      } else {
        reasonMessage = `A candidate fix was generated but the quality review did not pass${judgeExplanation ? ` (${judgeExplanation})` : ''}, so it did not clear the bar for an automatic PR.`;
      }

      return {
        status: 'needs_human',
        diff,
        affectedFiles,
        confidence: belowFloorConfidence,
        rootCause: result!.summary,
        reason: buildReason('low_confidence_fix', reasonMessage),
        evidence: evidence.record(),
        tokenUsage: totalTokenUsage,
      };
```

**Step 4: Run the new tests — expect PASS. Then the full worker suite.** Existing tests that exercised the old shell-based runner detection now go through the mocked `planTests`/`runSuite`; update their *setup* (e.g. skip-path tests set `planTests → { kind: 'none', command: null }`), never the terminal-contract assertions. `agentState.testsRan`-based assertions are unrelated (that flag tracks the agent's own test tool calls) — leave them.

**Step 5: Commit:** `git commit -am "feat(worker): E1 baseline comparison gate with failure taxonomy"`

---

## Task 15: Evidence-driven PR body

Replace the hard-coded `**Confidence:** High · ✅ Tests passing` (pr.ts line 266-268) with a Verification section rendered from the record.

**Files:**
- Modify: `packages/worker/src/pr.ts`
- Modify: `packages/worker/src/pipeline.ts` (pass `evidence` into `createPR`)
- Test: `packages/worker/src/__tests__/pr.test.ts`

**Step 1: Write the failing test** (in `pr.test.ts`, alongside the existing `buildPRBody` tests):

```ts
it('renders the Verification section from the evidence record', () => {
  const body = buildPRBody({
    ...baseInput, // reuse this file's existing PRInput fixture
    evidence: {
      version: 1,
      tier: 'E1',
      checks: [
        { name: 'build', outcome: 'passed', command: 'npm run build', output_tail: '' },
        { name: 'suite_baseline', outcome: 'failed', command: 'vitest run', output_tail: '' },
        { name: 'suite_post_patch', outcome: 'passed', command: 'vitest run', output_tail: '' },
      ],
      suite: { baseline_failed_tests: ['a::t2'], new_failures: [] },
    },
  });
  expect(body).toContain('**Verification:** E1');
  expect(body).toContain('✅');
  expect(body).toContain('1 test(s) already failed before the patch');
  expect(body).not.toContain('Tests passing');
});

it('degrades honestly when no evidence exists', () => {
  const body = buildPRBody({ ...baseInput, evidence: null });
  expect(body).toContain('No verification evidence recorded');
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement.** In `pr.ts`:

```ts
import type { ConfidenceLevel, NeedsHumanReason, EvidenceRecord, EvidenceTier, EvidenceCheck, CheckOutcome } from '@opslane/shared';
```

Add to `PRInput`:

```ts
  evidence?: EvidenceRecord | null;
```

Add the section builder (near the other section builders):

```ts
const TIER_LABELS: Record<EvidenceTier, string> = {
  E0: 'build verified',
  E1: 'no new test failures vs the pre-patch baseline',
  E2: 'reproduction verified red→green',
};

const CHECK_LABELS: Record<string, string> = {
  build: 'Build',
  suite_baseline: 'Existing suite (pre-patch baseline)',
  suite_post_patch: 'Existing suite (with fix, vs baseline)',
};

function checkIcon(outcome: CheckOutcome): string {
  if (outcome === 'passed') return '✅';
  if (outcome === 'failed') return '❌';
  if (outcome === 'infra_error') return '⚠️';
  return '⏭️';
}

function buildEvidenceLines(ev: EvidenceRecord): string[] {
  const lines: string[] = [];
  const latest = new Map<string, EvidenceCheck>();
  for (const c of ev.checks) latest.set(c.name, c);
  for (const [name, c] of latest) {
    lines.push(`- ${checkIcon(c.outcome)} ${CHECK_LABELS[name] ?? sanitizeInline(name, 60)}: ${c.outcome}`);
  }
  if (ev.suite && ev.suite.baseline_failed_tests.length > 0) {
    lines.push(`- ℹ️ ${ev.suite.baseline_failed_tests.length} test(s) already failed before the patch (excluded from the gate)`);
  }
  return lines;
}

function buildVerificationSection(input: PRInput): string {
  const ev = input.evidence;
  if (input.kind === 'friction') {
    // Plan review: no hard-coded "Repo tests passing" — render what actually ran.
    const lines = ['**Confidence:** Suggestion · ⚠️ The friction itself was not re-verified — review before merging'];
    if (ev) lines.push(...buildEvidenceLines(ev));
    return lines.join('\n');
  }
  if (!ev) return '**Verification:** ⚠️ No verification evidence recorded';

  return [
    `**Verification:** ${ev.tier ? `${ev.tier} — ${TIER_LABELS[ev.tier]}` : '⚠️ no tier achieved'}`,
    ...buildEvidenceLines(ev),
  ].join('\n');
}
```

In `buildPRBody`, delete the `confidenceLine` construction and replace its usage with `buildVerificationSection(input)`.

**Step 4: In `pipeline.ts`,** add to the `createPR` input object: `evidence: fixResult.evidence ?? null,`.

**Step 5: Run pr tests + full worker suite.** Existing tests asserting `Tests passing` need their expectations updated to the new section (that is a deliberate contract change from the design — Codex #19).

**Step 6: Commit:** `git commit -am "feat(worker): PR body renders the verification evidence section"`

---

## Task 16: Phase 1 gate — e2e evidence contract + full verification + live smoke

**Files:**
- Modify: `test-e2e/helpers.ts` (seed options, ~L115 and ~L147)
- Modify: `test-e2e/needs-human-contract.test.ts`

**Step 1: Extend the seed helper.** Add optional `candidateDiff?: string; verificationEvidence?: Record<string, unknown>;` to the seed options and include both columns in the `error_groups` INSERT (match the existing reason-field pattern at L147-153).

**Step 2: Add the contract test** (same file as the reason-code contract):

```ts
it('exposes candidate_diff and verification_evidence on needs_human incidents', async () => {
  const evidence = { version: 1, tier: 'E1', checks: [{ name: 'build', outcome: 'passed', command: 'npm run build', output_tail: '' }] };
  // seed a needs_human group with reasonCode: 'low_confidence_fix',
  // candidateDiff: '--- a/f\n+++ b/f\n', verificationEvidence: evidence
  // then GET the incident via the read API (existing helper)
  expect(incident.candidate_diff).toContain('+++ b/f');
  expect(incident.verification_evidence?.tier).toBe('E1');
});
```

**Step 3: Full repository gate:**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Step 4: Live smoke** (required — the pipeline changed): apply migrations, seed, rebuild ingestion + worker, send an event from `test-fixtures/vue-app`, and confirm:
- terminal state reached;
- for a `pr_created` run, the PR body contains the `**Verification:**` section with real check lines;
- for a `needs_human` run, the dashboard shows evidence + candidate diff, and `reason_code` distinguishes no-runner (`low_confidence_fix`) from infra (`verification_infra_error`);
- run the e2e suite per `test-e2e`'s README/AGENTS instructions.

**Step 5: Commit:** `git commit -am "test(e2e): evidence + candidate diff read-API contract"`

---

## After both phases land

- Merge per repo convention (PR from `evidence-tiered-verification` to `main`).
- **Write the Phase 2 plan** (repro gate / E2) against the now-real Phase 0/1 code: harness-owned repro outside the worktree, 3×red / 3×green / reversal, `asserts_behavior`, judge anti-swallowing question, `repro_not_achievable` routing (the reason code already exists), and the pre-clone guard change for stackless-but-replay errors. The design doc's Phase 2 section is the spec.

## Known constraints for the executor

- Never weaken the precision gate, terminal-status, or lease contracts — fix test setup instead (root `AGENTS.md`).
- The `POST /api/v1/events` wire contract is untouched by this plan; do not modify anything under `test-fixtures/wire/`.
- All new worker code is AGPL-3.0-only territory (server-side) — nothing here goes into SDK/CLI/shared except the type-only contract additions in `shared` (MIT), which are intentional.
- If `db.test.ts` runs against a live local Postgres, migration 014 must be applied before its new-column tests pass; use a disposable database for clean-state verification.
