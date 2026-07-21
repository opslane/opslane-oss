# Python SDK Batch 3 live verification evidence

Date: 2026-07-20

Scope of this document: it records what was observed during one manual
verification pass. It is not a claim of end-to-end assurance. Each section
states what was real, what was mocked, and how to re-run it. See
"Not covered" at the end for the gaps.

Credentials were loaded into the test processes from the existing development
environment and were not copied into this repository or printed. The live runs
below required `OPSLANE_PYTHON_PIPELINE=1` in the local process environment; no
deployed environment's flag was changed.

## Published E2B template

Reproduce with `node packages/worker/scripts/spike-python-sandbox.mjs`
(requires `E2B_API_KEY`).

- Template: `opslane-python`
- Template ID: `84c1j5abpjvqq2g5n5va`
- Build ID: `c598ecc8-8d68-4b4c-a610-d776729c9235`
- Build result: successful

A fresh sandbox created from the published template produced, in a single
measurement (n=1, timings are one sample and not a characterisation):

- sandbox boot: 794 ms;
- dependency installation: 18,646 ms;
- Python 3.12.13;
- pytest 8.2.2;
- xz 5.8.1;
- one fixture test passed; and
- `/tmp/opslane-junit.xml` was generated and read successfully.

The spike completed with `SPIKE PASSED`.

## Live Python eval

What this exercises: real GitHub clones, Anthropic calls, E2B sandboxes, and
for the two fix cases, pytest/JUnit verification, patch application, and
quality grading.

What it does **not** exercise: `eval/src/pipeline-caller.ts` calls
`runAgentFix` directly. There is no database, no `investigateError`, neither
pre-clone guard, no `runPipeline`, and no PR creation. As the batch 3 plan
states, green evals prove nothing about routing.

Result: 3/3 cases met their expectations, but the three cases are not
equivalent in strength.

| Case | Outcome | What was actually verified | Judge |
| --- | --- | --- | --- |
| `python-attribute-error-003` | fix | executable: failing test repaired; four unaffected tests passed | 6/6 |
| `python-none-arithmetic-001` | fix | executable: failing test repaired; four unaffected tests passed | 6/6 |
| `python-third-party-002` | `needs_human` / `unfixable_third_party` | **no executable verification** — `bug_patch` is null and `fail_to_pass`/`pass_to_pass` are empty, so no patch is applied and no test runs. This is an outcome plus reason-code string comparison on one LLM give-up decision. | not applicable (`grader.ts` scores quality only for `fix_pr`) |

So: 2 of 3 cases were executable and quality-gated; 1 of 3 was an assertion on
a single string.

Both generated fixes changed only `cart.py`, applied cleanly, and identified
`cart.py` as the root-cause file.

Reproducibility limits, stated plainly:

- n=1 on a nondeterministic LLM pipeline. The `3/3` and the `6/6` judge scores
  are one sample and are not re-derivable from this repository.
- No runner output is committed, so a reader cannot check these numbers.
- The three case files clone by URL with no pinned commit
  (`repo_url` in each `case.json`, default branch resolution in
  `pipeline-caller.ts`). A push to `defender-eval-flask-app` silently
  invalidates the recorded result without turning any test red.

## Real production-delivery PR

- Fixture repository: <https://github.com/opslane/defender-eval-flask-app>
- PR: <https://github.com/opslane/defender-eval-flask-app/pull/1>
- Base branch: `e2e-none-arithmetic`
- Head branch: `opslane/fix-dbb24c8d`
- Head SHA: `15a89c8681400f8d702708df22a7715531b1e816`
- PR posture: ready for review, not draft

The `runPipeline` path performed investigation, generated and verified the fix
in E2B, pushed the branch, and opened the PR. The one-line diff filters `None`
prices before summing.

The PR body discloses both runtimes:

- Customer: CPython 3.11.8
- Sandbox: CPython 3.12.13

An independent checkout of the exact PR head SHA was installed into a fresh
local virtual environment and produced `5 passed in 0.28s`.

Caveats on this artifact:

- The mechanism is not recorded. No ingested event payload, job ids, group id,
  or command was captured, so the repository alone cannot establish whether the
  run entered through ingestion and the investigate stage or `runPipeline` was
  driven directly. The root `AGENTS.md` live smoke (migrations,
  `scripts/seed-e2e.sql`, `POST /api/v1/events`, terminal state) was not the
  recorded path.
- The published verification block is the baseline-tolerant E1 tier: two
  baseline failures, five post-patch passes, zero new failures, with
  `Build: skipped_no_runner` and pre-existing baseline failures excluded from
  the gate. The run happened to be fully green post-patch; that is not the same
  as the gate having enforced green. The Python-strict rule
  (`post.outcome === 'passed'`) is pinned by unit test, not by this artifact.
- This run predates the syntax gate added during review; `Build:
  skipped_no_runner` is what the Python path produced at the time.

## Durable routing: unit evidence

`python-production-path.test.ts` ran against a fresh Postgres 16 database with
all migrations applied. Both cases passed:

- persisted Python routing survived a feature-flag change between investigate
  and fix stages; and
- a Python incident followed the existing terminal path when the flag was off.

This is a real database round-trip of `error_group_jobs.platform` and it is not
tautological: flipping the flag to `'0'` between stages and still asserting the
persisted platform reaches the fix stage would genuinely fail if `processFixJob`
re-derived platform from the environment.

Its limits:

- `runAgentFix` is mocked (`vi.mock('../agent-fix.js')`). No sandbox is created,
  no Python E2B template is selected, no pytest runs, no JUnit is parsed. The
  test proves the platform string is passed as an argument to a mocked function.
- The fix job is claimed with hand-rolled SQL, not `db.claimJob`. The production
  claim path — the `RETURNING` list that must include `platform`, and the
  string-to-`Platform` normalisation — is never exercised. Dropping `platform`
  from `claimJob` would leave this test green.
- The suite is gated on `DATABASE_URL` and becomes `describe.skip` without it.
  A default `pnpm --filter @opslane/worker test` run does **not** execute it.

## Not covered

None of the following was exercised by any live run above. A reader should not
infer coverage for them:

- pip install failure (`installOutcome: 'failed'` to `verificationInfraError`);
- dependency managers other than `requirements.txt` and PEP 621 `[project]`
  (Poetry, bare `setup.py`, Pipenv, uv all yield `not_applicable`);
- pytest exit code 5, and collection or teardown `<error>` elements mapping to
  `infra_error`;
- truncated, non-XML, or plugin-extended JUnit output;
- polyglot repositories (the xz-utils reason the template was rebuilt is never
  exercised end to end);
- the no-draft delivery gate on a live Python run;
- the `OPSLANE_E2B_PYTHON_TEMPLATE` override;
- artifact hygiene (`__pycache__`, `.pytest_cache`) on a live run;
- concurrency behaviour of the shared job queue; and
- deployment layouts other than the fixture's flat repository root.

Every live datapoint recorded here is a happy path.
