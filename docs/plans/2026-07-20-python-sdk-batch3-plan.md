# Python SDK Batch 3 — worker plan ("agent fixes Python")

Issue: #89. Design: `docs/plans/2026-07-17-python-sdk-design.md` §9.
Status: plan v4 (after three Codex review rounds). Batches 0/1/2 merged and closed.

Batch 3 is the payoff batch: a Python error becomes a verified PR. Batches 0-2
get Python errors in and visible; nothing today makes the agent fix them.

Every claim was verified by reading or running the code. Where the design doc or
issue #89 contradicts the code, that is called out.

---

## 1. Reality check — where the design doc is wrong

### 1.1 Python dies twice before the agent runs

**Guard A — pre-clone, `index.ts:278`:** `hasNoAppFrames` is
`extractStackTraceFiles(stack).length === 0` (`stack-trace-utils.ts:88`), and none
of its four regexes match CPython syntax. Measured on a real traceback:

```
EXTRACTED: []          HAS_NO_APP_FRAMES: true
```

**Guard B — post-clone, `index.ts:396`:** `investigateError` runs before a fix job
exists, and `index.ts:416` terminalizes on `!triage.fixable && confidence === 'high'`.
That investigator is JS-specific: no platform in `InvestigateInput`
(`investigate.ts:358`), prompt language about node_modules and source maps
(`investigate.ts:283`), its own `unfixable_no_sourcemap` allow-list
(`investigate.ts:261`), and a platform-less `extractStackTraceFiles` call
(`investigate.ts:399`).

Fixing only `buildPythonSystemPrompt()` changes nothing observable.

### 1.2 `runTestGate()` does not exist

`grep -rn "runTestGate" packages/worker/src/` returns nothing. The gate is inlined
at `agent-fix.ts:617` (baseline) and `:849` (post-patch), composed from
`planTests` / `runSuite` / `compareSuiteRuns`.

### 1.3 No E2B template is wired, and no sandbox lifetime is set

`sandbox-runtime.ts:36` is `Sandbox.create()` — default image, implicit lifetime.
The Batch 0 spike passes 900s explicitly (`scripts/spike-python-sandbox.mjs:17`),
with the comment that lifetime must exceed its longest command timeout (600s).

### 1.4 No TS prefix list, and Go semantics are richer than a regex

Only Go has the list (`grouping/python.go:14-18`). `pythonFrames`
(`python.go:37-82`) takes the **final chained-exception segment only**, filters
libraries, reverses newest-first, dedupes on `relativePath + ":" + function`, and
caps at 5. A flat scan pulls stale frames from earlier segments and orders them
wrong. Known bug on both sides: `/venv/` does not match `/.venv/`.

### 1.5 `platform` never reaches the worker

Ingestion writes it (`queries.go:528`, `:557`). `getErrorGroup` (`db.ts:930`) and
`getErrorEvent` (`db.ts:1045`) select neither; `PipelineInput` (`pipeline.ts:19`)
and `AgentFixInput` (`agent-fix.ts:33`) have no field.

---

## 2. Decisions

### D0 — Feature flag contract (new in v3)

- **Name:** `OPSLANE_PYTHON_PIPELINE` (`1`/`true` enables). Default **off**.
- **Evaluated once per incident, in `processInvestigateJob`**, producing an
  effective platform: `flagOn && group.platform === 'python' ? 'python' : 'javascript'`.
  Everything downstream takes the effective platform, never reads the env again.
- **Durable routing:** the effective platform is **persisted on the fix job** created
  at `index.ts:433`, and `processFixJob` reads it from the job rather than
  re-evaluating the flag. Without this, turning the flag off between the two durable
  stages routes an already-approved Python fix through the JavaScript path. This is a
  job-payload field, so it is a schema-touching task, not an afterthought.
- **Disabled disposition:** Python groups behave exactly as today (guard A
  rejects them). No new terminal state, no partial path.
- **Propagation:** `docker-compose.yml` worker env (alongside the vars at
  `docker-compose.yml:98`) and a row in `docs/reference/environment-variables.md`
  (worker table, `:38`).
- **Tests:** flag-off Python group → unchanged behavior; flag-on → Python path.

**The flag does not protect the JS path from shared refactors.** Changes to
`createRepoSandbox`, `installSucceeded`, `createSandboxRuntime`, `planTests`,
`extractStackTraceFiles`, and tool construction execute for JavaScript regardless.
Those need JS-preserving defaults and their existing tests green, which is why
phase 1 lands types and defaults before behavior.

### D1 — No Python draft PRs in v1 (decided in v3)

v2 said "an explicit minimum-evidence rule is needed" without stating it. Stating
it: **Python never publishes a draft PR in batch 3.**

Rationale: `draftEligible` is `qualityConfirmed && buildGatePassed && !verified`
(`agent-fix.ts:1128`), and `buildGatePassed` is only true on `passed`
(`agent-fix.ts:895`). A pure-Python repo cannot produce that through the JS build
gate. Making "not applicable" satisfy it would permit an LLM-judge-only draft with
neither build nor pytest evidence — a policy change this batch should not smuggle in.

Consequence: Python produces either a verified PR or `needs_human`. `verified`
depends only on a non-skipped passing test gate (`agent-fix.ts:1076`), so verified
Python PRs are unaffected.

**Enforcement point:** the delivery-policy gate at `pipeline.ts:122`, which must
require `platform !== 'python'` to publish a draft. Relying on `draftEligible`
alone is not enough — a **polyglot** Python repo can pass the Node build gate,
skip pytest, and satisfy `draftEligible` incidentally. That exact case gets a
regression test.

Build gate stays **capability-based, not platform-based**: `runBuildGate` already
returns `skipped_no_runner` with no `package.json`/`tsconfig.json`
(`sandbox-repo.ts:177`), and skipping by *event* platform would break polyglot
repos where a Django app has a real Node frontend build.

### D2 — pytest verification, and the pass rule must be fixed (scope change in v3)

Command: `python -m pytest --junit-xml=…`. The spike proved `python -m pytest`
(`spike-python-sandbox.mjs:39` runs `python -m pytest -v`); **`--junit-xml` is new
and unproven** and must be exercised in the phase 4 template smoke. JUnit XML is
built into pytest — no plugin.

**v2 deferred a soundness hole; v3 brings it in scope.** When a per-test map
exists:

```ts
const passed = post.tests ? newFailures.length === 0 : comparison.comparable;
```

`post.outcome` is not consulted (`agent-fix.ts:872`), so a suite that is still
red with only pre-existing failures records as **passed**. Separately,
`missingFromPost` only flags baseline-**passing** tests that vanish
(`test-runner.ts:107`), so deleting a baseline-failing test is invisible. Together
these are an automatic-PR bypass, and #89's criterion says "pytest passing."

Fix in this batch, split deliberately because the two halves have different blast
radius:

1. **Shared soundness fix (JS + Python):** widen `missingFromPost` to flag *any*
   baseline test absent post-patch, not only baseline-passing ones. Deleting a
   failing test is never legitimate evidence.
2. **Python-only strict rule:** require `post.outcome === 'passed'` in addition to
   `newFailures.length === 0`.

The strict rule stays Python-only on purpose. `pr.ts:312` publishes E1 to users as
"no new test failures compared with the pre-fix baseline"; making JS require a
fully green suite would change a documented product promise, which is a separate
review. #89 says pytest passes, so Python gets the stricter bar.

**JUnit parse contract** (must be pinned, not left to the implementer):
- Identity: `classname + "::" + name`; on duplicates, failure wins over pass
- Decode XML entities; handle nested `<testsuites>`
- `<error>` (collection/import) → `infra_error` for the run, not a test failure
- `<skipped>` tests are excluded from the map, matching vitest handling
- Missing or malformed XML → `infra_error`
- Exit codes: 0 pass, 1 failures, 2/3/4 internal or usage error, 5 no tests
  collected. 2/3/4/5 → `infra_error`
- Config detection is `[tool.pytest.ini_options]`, not `[tool.pytest]`. Current
  detection uses `files.read` (`test-runner.ts:123`), which cannot detect a
  `tests/` **directory** — needs a directory probe

No XML dependency exists in the worker and AGENTS.md requires justifying new deps.
Plan a small hand-rolled parser over pytest's narrow JUnit subset.

### D3 — Reorder sandbox setup, and fix the Python image (corrected in v3)

v2 said "skip Node bootstrap for repos with no `package.json`." **Impossible as
written:** `ensureModernNode(sandbox)` runs at `sandbox-repo.ts:86`, before the
clone at `:98`. The repo does not exist yet.

Required reorder: create runtime → clone → inspect manifests → bootstrap Node only
if `package.json` exists → install.

**Second defect:** the Python template cannot run the Node bootstrap even when a
polyglot repo needs it. `ensureModernNode` does `tar -xJf` (`sandbox-repo.ts:66`),
but `e2b-python/e2b.Dockerfile:8` installs only
`build-essential libpq-dev libffi-dev git curl` on `python:3.12-slim` — **no
`xz-utils`**. Add it to the template, or the polyglot fallback fails before either
language's checks run.

**Editing the Dockerfile does not change the deployed template.** Phase 4 must
rebuild and republish the E2B template, record the new template identity, and
re-run the spike against it — including a `--junit-xml` run (D2). Checking that
the old template `84c1j5abpjvqq2g5n5va` is still live is not sufficient.

Set an explicit sandbox lifetime (start at the spike's 900s): a 300s install plus
clone, baseline suite, agent turns, retries, post suite, and judging cannot rely on
an implicit default.

### D4 — Tri-state install, with baseline behavior defined (corrected in v3)

Ladder: `requirements.txt` → `pip install -r … --no-cache-dir`; `pyproject.toml`
with `[project]` → `pip install -e .`; neither → no install. 300s.

v2 correctly noted `installSucceeded: boolean` (`sandbox-repo.ts:41`) cannot
express three states, but did not say what `not_applicable` *does*. Deciding:

| State | Baseline suite | On failure |
|---|---|---|
| `installed` | Run normally | `infra_error` |
| `not_applicable` (no manifest) | **Still run baseline.** The template preinstalls pytest (`e2b.Dockerfile:12`), so collection can succeed for a dependency-free repo. If collection fails → `infra_error` | — |
| `failed` | Skip; `verificationInfraError = true` | Current behavior |

This matters because baseline runs *before* the agent (`agent-fix.ts:617`), so
"let the agent install" cannot rescue a `not_applicable` repo whose collection
needs dependencies. Accepting `infra_error` there is the honest v1 outcome.

Also fix the hardcoded `'npm install failed'` message (`agent-fix.ts:622`).

Accepted v1 gaps, documented not hidden: `requirements-dev.txt`, `src/` layouts
needing editable install alongside `requirements.txt`, extras, uv / Poetry / PDM.
Preinstalled bare pytest does not supply collection plugins the repo's tests import.

### D5 — No new reason codes, but enforce the enum

Existing 25 cover the Python give-up paths; add none. Required work:
- Remove `unfixable_no_sourcemap` from the Python path in **both**
  `agent-fix.ts:154` and `investigate.ts:261`
- `unfixable_no_app_frames` carries browser/CORS remediation (`reason-codes.ts:49`)
  that is nonsense for a malformed traceback — make it platform-aware
- Map "requires a schema migration" to `insufficient_context`
- **Enforce the enum at the tool boundary:** `give_up` accepts any string
  (`tool-bridge.ts:157`) and `agent-fix.ts:800` casts it blindly; the DB only
  checks non-empty (`db.ts:1293`). Validate against the union, fall back to
  `triage_unfixable`

### D6 — Two APIs, and where each runs (sharpened in v3)

- `parsePythonFrames(stack): PythonFrame[]` — lexical, ordered, mirrors
  `pythonFrames` semantics. Used by guard A pre-clone (candidate check only,
  tolerant of false positives).
- `resolveFrames(frames, trackedFiles): string[]` — strips deployment prefixes,
  drops library frames, exact-matches against a tracked-file set. No fuzzy matching.

**There are three host clones plus the sandbox clone**, not two: `index.ts:339`
(investigate), `index.ts:515` (setup), `index.ts:727` (fix job), and
`sandbox-repo.ts:98`. Resolution therefore runs against different file sets at
different stages.

Nothing persists `PythonFrame[]` between durable jobs, and adding a column for it
is not worth it. Decision: **recompute frames from the stored raw stack at each
stage.** `parsePythonFrames` is pure and cheap; only the effective platform (D0)
is persisted.

### D7 — Artifact hygiene needs enforcement, not just .gitignore

`extractDiff` runs `git add -A` (`sandbox-repo.ts:149`) and setup ignores only
`node_modules`, `.cache`, `coverage` (`sandbox-repo.ts:109`). Three layers:
1. Write exclusions to `.git/info/exclude` (sandbox-local; does not dirty the repo)
2. Reject known generated paths from the candidate diff as defense in depth
3. Test that pytest plus editable install leaves none of `__pycache__`, `*.pyc`,
   `.pytest_cache`, `.coverage`, `htmlcov`, `*.egg-info`, `build/`, `dist/` in
   `affectedFiles`

### D8 — `RuntimeInfo` type and full propagation

Customer runtime is inside opaque `context.runtime` JSON (`error_event.go:125`);
the worker selects `context::text` (`db.ts:1046`), types it as `string`
(`db.ts:1037`), and forwards it unparsed (`index.ts:862`).

Define `RuntimeInfo { name, version }`. Propagation, all of it:
1. Parse and validate from the **current sample event's** `context.runtime`
2. Into `InvestigateInput`, `PipelineInput`, `AgentFixInput`
3. Sandbox's observed Python version captured at setup, returned on `RepoSandbox`
4. Returned on `AgentFixResult`, threaded through `pipeline.ts:299` into `PRInput`
5. Customer version stated as a constraint in the Python prompt
6. PR body renders both, or explicit `unknown` when absent

Missing or malformed → `unknown`, never a thrown error.

Ingestion is stricter than first assessed: `error_event.go:125-147` deletes any
caller-supplied `context.runtime` and re-marshals a clean `{name, version}` from
the validated top-level wire field, so the **shape** is guaranteed. The **values**
are still arbitrary SDK-supplied strings, so bound their length and fence them in
the prompt the way `buildSystemPrompt` fences user data — otherwise a crafted
`runtime.version` becomes prompt injection.

---

## 3. Phases

Ordering is dependency-driven. The flag (D0) lands first so every later phase has
a safe default.

### Phase 1 — Flag, types, defaults

D0 flag contract, config propagation, docs row. Platform and `RuntimeInfo` types
threaded through `ErrorGroupData`, `ErrorEventData`, `InvestigateInput`,
`PipelineInput`, `AgentFixInput`, `AgentFixResult`, `createRepoSandbox`,
`createSandboxRuntime`. `NULL` platform → `javascript`. `setup-agent.ts:74` passes
`javascript` explicitly rather than relying on a default.

**Verifies:** `pnpm --filter @opslane/worker test` green with no behavior change.

### Phase 2 — Frame parsing

`parsePythonFrames` + `resolveFrames` (D6). Guard A becomes platform-aware.
Contract test against Go: a **shared fixture file of traceback→expected-frames
pairs**, consumed by both `python_test.go` and the TS test, so the mechanism is
executable rather than aspirational. Fix `/venv/` → also match `/.venv/` on both
sides.

**Verifies:** `stack-trace-utils.test.ts` (114 lines, primary blast radius) green;
Python traceback yields ordered app frames.

### Phase 3 — Investigator

Platform into `InvestigateInput`; Python prompt variant; drop
`unfixable_no_sourcemap` (`investigate.ts:261`); exclude `.venv`, `venv`,
`site-packages`, `.pytest_cache`, `*.egg-info` from **all three** traversal sites:
`investigate.ts:73`, `:90`, `:137`, and the agent's own search tool
(`tool-bridge.ts:119`), which has no exclusions at all.

**Verifies:** `investigate.test.ts` (462) green; Python reaches `fixable`.

### Phase 4 — Sandbox

Setup reorder and Python image fix (D3), template selection with lifetime,
tri-state install (D4), artifact hygiene (D7), sandbox Python version capture (D8).
Confirm the E2B template is still live on the team account before starting — the
spike was 2026-07-17 and nobody has rechecked.

**Verifies:** command-sequence assertions like `sandbox-repo-setup.test.ts`;
`sandbox-repo.test.ts` green.

### Phase 5 — Verification, prompts, PR body

pytest planning, JUnit parser, and the pass-rule fix (D2). `buildPythonSystemPrompt()`
sharing `MODEL_CASCADE` / `MAX_STACK_TRACE` / budget constants. Also the **quick
triage prompt** (`agent-fix.ts:220`, used when `repoPath` is absent) and tool
descriptions naming npm/node_modules/sourcemaps (`tool-bridge.ts:76`, `:157`).
Skip source maps for Python (`index.ts:366`, `:753`). PR body renders both runtime
versions. Reason-code work (D5). Check `tool-middleware.ts:5`, where any output
containing `fail` or `error` counts as failure — a passing `test_error.py` leaves
`testsRan=false`.

**Verifies:** `test-runner.test.ts` (276), `pr.test.ts` (593), `agent-fix.test.ts`
(1081) green.

### Phase 6 — Eval and production-path test

Eval harness cannot select Python today: `EvalErrorEvent` has no `platform` or
`runtime` (`eval/src/types.ts:3`) and `callPipeline` passes neither
(`pipeline-caller.ts:47`), so Python cases default to the JS path.

- Extend the eval schema with `platform` and `runtime`
- Local app under `eval/apps/<app>` — grading copies from there (`runner.ts:98`, copied at `sandbox.ts:40`),
  so a remote repo alone is insufficient
- `eval/src/sandbox.ts:49` unconditionally runs `npm install`; add a Python path
- `eval/src/test-executor.ts:17` is Vitest-only; add pytest node-id syntax
- Root `package.json` has **no `eval` script** — use the eval package's script or add one
- 2+ cases, at least one `expected.outcome: needs_human`
- **The give-up gate is currently fake:** `grader.ts:46` passes a `needs_human`
  case on outcome alone and ignores `reason_code` mismatch. Make an expected
  reason code mandatory when supplied, or the acceptance criterion is unenforced

**Production-path test spans both durable job stages.** `processInvestigateJob`
only creates a fix job (`index.ts:433`); PR delivery is `processFixJob`
(`index.ts:655`). The test drives `processJobInner` (or the poller) across both
transitions — a `runAgentFix`-only test proves nothing about routing.

### Phase 7 — Enable

Live sandbox and live PR smoke, then set `OPSLANE_PYTHON_PIPELINE=1` **in the target
deployment**. The code default stays off, or D0 stops being true.

---

## 4. Acceptance gate mapping (#89)

| Criterion | Phase | Proof |
|---|---|---|
| Real Python error → PR, pytest passes in-sandbox | 6 | Two-stage production-path test |
| PR description records runtime versions | 1→5 (D8) | `pr.test.ts` + live PR |
| JS pipeline unchanged | 1-5 | `pnpm --filter @opslane/worker test`, 39 files |
| Give-up → `needs_human` + reason code | 3, 5 | Eval case expecting `needs_human` |
| 2+ Python eval cases pass quality gate | 6 | Eval runner |
| `pnpm -r build` passes | all | CI |

The live leg needs **#104**. PR #127 fixes it; land that first.

---

## 5. Risks

- **Wrong entry point.** v1's largest error was planning against `agent-fix.ts`
  when `investigate.ts` terminalizes first.
- **Green evals, broken production.** The eval path bypasses both guards, the
  pipeline, and PR creation. Phase 6's two-stage test is the only closure.
- **The flag does not cover shared refactors.** JS executes the same
  `createRepoSandbox` / `planTests` / `extractStackTraceFiles` changes.
- **D2 changes JS verification semantics.** Correct, but it will reclassify some
  JS runs that previously passed. Expect eval-baseline movement.
- **Sandbox setup reorder (D3)** touches the JS happy path directly.
- **Runtime fidelity** is a documented approximation — sandbox 3.12, SDK 3.11+.
- **E2B template liveness unverified** since 2026-07-17.
- **Adjacent worker bugs** #73, #71, #70, #72 will surface during the live e2e.

---

## 6. Out of scope

FastAPI / Django / Celery integrations, SQL and HTTP breadcrumbs, per-version
sandbox templates, multi-repo, filtered per-platform polling. Adjacent issues
#102, #103, #125 are separate.
