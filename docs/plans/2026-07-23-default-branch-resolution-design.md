# Default branch resolution (issue #180)

Onboarding fails for every repo whose default branch is not `main`.
`projects.default_branch` is written once with the schema default and never
corrected from GitHub.

Reviewed with `/plan-eng-review` on 2026-07-23 against `b18c6be`.

## Root cause

`001_baseline.sql:21` declares `default_branch TEXT NOT NULL DEFAULT 'main'`.
That is not a default, it is a guess the schema cannot distinguish from a fact.
Nothing downstream can tell "we confirmed `main`" apart from "we had to write
something." Every other symptom in this issue follows from that one property.

The two-phase onboarding design (`docs/plans/2026-07-22-onboarding-10x-design.md`,
D1) makes "unknown" a normal state, not an edge case: Phase 1 is explicitly
**"Local aha (no GitHub)"**. The project and its API key are minted before the
GitHub App exists, from a repo string read off the local git remote. At that
moment the default branch is genuinely unknowable, and the schema forces a lie.

## Decision

Let the column say "I don't know," then learn the answer at each of the three
moments it becomes knowable. Never guess.

```
Phase 1 (no GitHub)          Phase 2 boundary            Every job
─────────────────────        ─────────────────           ─────────
OnboardProvision             PersistInstallation         git clone (no --branch)
CreateProject                (App granted)                 └─> checks out remote HEAD
  │                            │                              │
  └─> default_branch = NULL    └─> resolve from the           ├─> PR base (same job)
      no GitHub call               []Repo already in          └─> UPDATE projects
      no authz check               hand — zero new                (cache refresh)
                                   API calls
                             SetGitHubConfig
                               └─> resolve + authorize
                                   (App already installed)
```

Why not the issue's proposal 1 (fetch and store at every write path): two of the
four write paths run in Phase 1 where GitHub does not exist yet, so the call
cannot be made there at all. And `webhook.go:57` ignores every event except
`pull_request`, so a stored value goes stale on a default-branch rename
regardless. Clone-time resolution is the only mechanism that stays correct.

## Resolved decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Fix shape | Clone derives the branch; the DB column is a self-healing cache, never an authority |
| 1 | Plumbing | Resolve at clone, return it, thread it to the PR base. Drop `defaultBranch` from `CloneOptions` |
| 2 | Unresolvable HEAD | **Corrected.** Three-way classification via `ls-remote --heads`, not `rev-parse`. Typed error carrying repo + discovered branch |
| 3 | Where to resolve | **Corrected.** Phase 1 paths do nothing. `PersistInstallation` resolves at the Phase 2 boundary, for **three** callers. `SetGitHubConfig` resolves and authorizes |
| 4 | Error capture | Include `err.stderr`, redacted and truncated, on both clone sites |
| 5 | DRY | One shared `resolveClonedBranch(run)` helper across both clone backends |
| 6 | Schema | Nullable. `NULL` means unknown |

### Correction log

**C1.** An earlier draft of decision 3 put an installation lookup on the
project-create path. That contradicts D1 of the onboarding design — Phase 1 has
no GitHub by construction, so the check would have failed every CLI provision.
The check moved to `PersistInstallation`.

**C2.** That fix was itself incomplete. There is a **third** installation caller:
agent-callback onboarding flattens repos at `handler/agent_setup.go:449-452`,
calls `PersistInstallation` at `db/agent_provision.go:217`, and creates the
project only afterwards at `:232`. A NULL-fill inside `PersistInstallation`
therefore cannot see that project — the row does not exist yet. This path needs
the branch carried in `AgentProvisionInput` and applied after `CreateProjectTx`,
inside the same transaction.

**C3.** Decision 2 used `git rev-parse --verify HEAD` to detect an empty repo.
Verified empirically that this does not discriminate:

| | genuinely empty | non-empty, HEAD → missing ref |
|---|---|---|
| `git clone` exit | 0 | 0 |
| git stderr | `warning: You appear to have cloned an empty repository.` | **identical warning — actively wrong** |
| `rev-parse --verify HEAD` | 128 | 128 |
| `symbolic-ref --short HEAD` | `master` | `nonexistent` |
| `ls-remote --heads origin` | **0** | **1** |

Two consequences. `ls-remote --heads` is the discriminator, not `rev-parse`. And
git's own stderr misreports the second case, so T4's "surface git's reason" is
necessary but **not sufficient** for issue #180's "name the repo and the branch"
criterion — that needs a typed error we construct ourselves.

**C4.** Decision 3's fill used `IS NULL`, which would leave legacy rows holding
the schema-guessed `'main'` permanently indistinguishable from a confirmed value
— the exact root cause this plan opens by naming. Changed to `IS DISTINCT FROM`.
Safe because no custom-target-branch feature exists: there is no UI, no API
field, and no query that sets `default_branch` to anything but the schema
default.

## What already exists

| Thing | Where | Reused or rebuilt |
|---|---|---|
| `default_branch` parsed from the GitHub API | `github/app.go:42` | **Reused.** Already populated on every `ListInstallationRepos` result. |
| `[]Repo` in hand at the installation boundary | `github_oauth.go:367`, `:639`, and `handler/agent_setup.go:449` | **Reused.** All **three** callers already have `DefaultBranch` and throw it away flattening to `repoNames` at `:373`, `:643`, and `:449-452`. |
| Transactional installation write | `db/installations.go:26` (`PersistInstallation`) | **Reused.** Already runs under an advisory lock in the caller's tx — the branch update joins it. Note the agent-callback caller creates its project *after* this call (`agent_provision.go:232`), so that path needs the branch applied post-create instead. |
| Repo-grant authorization on the agent path | `agent_setup.go:448` (`repo_not_granted`) | **Already correct.** This path matches the canonical repo against granted repos; only the dashboard settings path lacks the check. |
| The value already served to the browser | `github_oauth.go:820`; `dashboard/src/types/api.ts:294` | **Not used.** We resolve server-side rather than trusting a client-supplied branch. |
| Token redaction on clone errors | `repo-clone.ts:88`, `sandbox-repo.ts:134` | **Reused** for the newly captured stderr. |
| `needs_human` reason-code channel | `setup-agent.ts:52` | **Reused** for the empty-repo case. |
| Project row updates from the worker | `db.ts:1106` | **Reused** pattern for the write-back. |
| Argument-injection guard on branch names | `repo-clone.ts:67` | **Retired.** Its input leaves the interface under decision 1; its two tests (`repo-clone.test.ts:222,228`) go with it. |

## Changes

### Schema

1. `027_default_branch_nullable.sql` — drop `NOT NULL` and the `'main'` default
   on `projects.default_branch`. Existing rows keep their current value and heal
   on next clone; no backfill.
2. `db/queries.go` — 8 `DefaultBranch` scan sites move to a nullable type.
   `db.ts:1068` `ProjectData.default_branch` becomes `string | null`. The type
   change is the point: the compiler enumerates every reader.

### Worker

3. `repo-clone.ts` — remove `defaultBranch` from `CloneOptions`. Clone without
   `--branch`. Add `resolveClonedBranch(run)` returning a three-way result, and
   a typed `CloneResolutionError` carrying `{ repo, discoveredBranch, kind }`:

   | Condition | `kind` | Message |
   |---|---|---|
   | `ls-remote --heads` returns 0 refs | `empty_repository` | "`owner/repo` has no commits yet" |
   | heads exist, `symbolic-ref` names an absent ref | `invalid_default_branch` | "default branch `X` does not exist in `owner/repo`" |
   | `symbolic-ref` itself fails (detached HEAD) | `unresolvable_head` | "could not determine the default branch of `owner/repo`" |

   Do **not** rely on `rev-parse --verify HEAD` to classify, and do not rely on
   git's stderr to name the branch — see correction C3. Return
   `{ repoDir, defaultBranch, cleanup }` on success. Capture `stderr` in the
   catch, scrubbed and truncated, as supporting detail rather than as the
   classification.
4. `harness/sandbox-repo.ts` — same helper with a `sandbox.commands.run` runner.
   Read `err.stderr` (typed at `sandbox-runtime.ts:71`) instead of `err.message`
   alone. Sandbox resolution is used for **validation and error reporting only**,
   never as PR-base authority.
5. `setup-agent.ts:80` and `index.ts:358` — stop mapping every clone failure to
   `repo_access_denied`. Map `CloneResolutionError.kind` to the right
   `reason_code` and remediation; today an empty repo tells the user to fix
   GitHub App permissions.
6. `setup-pr.ts` — use the **host** clone's resolved branch for `base` at
   line 103. The host checkout is the one that receives the diff and is pushed
   (`gitCommitAndPush(repoDir, …)`); the sandbox at `agent-fix.ts:611` is a
   separate, later clone that could observe a rename mid-job.
7. Thread the host value: `CloneResult.defaultBranch` → `PipelineInput` → PR
   creation. **Remove** `defaultBranch` from `AgentFixInput`, `AgentSetupInput`,
   and the sandbox clone inputs entirely, so there is one authority and no
   second value to drift.
8. `db.ts` — `updateProjectDefaultBranch(projectId, branch)`. Wire the call at
   every host clone site: `index.ts:346`, `:525`, `:739`, `:882` and the
   `setup-pr.ts` clone. Because the column is a cache and never an authority,
   **every** write-back failure is logged and swallowed — not just the zero-rows
   case. A transient UPDATE error must never fail work that already holds the
   correct resolved branch.

### Ingestion

9. `db/installations.go` — `PersistInstallationParams.Repos` carries
   `[]gh.Repo` (or a `{name, defaultBranch}` pair) instead of `[]string`. In the
   same transaction, update `default_branch` for every project in the org whose
   `github_repo` matches a covered repo and whose value `IS DISTINCT FROM` the
   authoritative one. **Not `IS NULL`** — see correction C4; legacy `'main'` rows
   are precisely the ambiguous case that needs correcting.
10. `handler/github_oauth.go:373` and `:643` — stop flattening the branch away.
11. `handler/agent_setup.go:449-452` and `db/agent_provision.go` — the third
    caller. Flattening changes with the `Repos` type. Because
    `CreateProjectTx` runs at `agent_provision.go:232`, *after*
    `PersistInstallation` at `:217`, the NULL-fill cannot reach this project.
    Carry the matched branch on `AgentProvisionInput` and set it on the project
    immediately after creation, inside the same transaction.
12. `handler/github_settings.go` — resolve the submitted repo against the org's
    installation list. Unknown repo → 400 naming the repo and telling the user to
    install the App on it. Store the matched `DefaultBranch`.

### Explicitly unchanged

`handler/onboard_provision.go` and `handler/onboarding.go`. Phase 1 makes no
GitHub call, performs no repo authorization, and writes no branch. This is the
correction described above, not an oversight.

## Test coverage

```
CODE PATHS                                              USER FLOWS
[~] packages/worker/src/repo-clone.ts                   [+] Onboard a master-default repo
  └── cloneRepo()                                         ├── [GAP] [→E2E] setup PR opens against master
      ├── [★★ TESTED] no token — :100                     └── [GAP]        wizard leaves step 4
      ├── [★★ TESTED] token scrubbed — :107
      ├── [★★ TESTED] alt host — :127                   [+] CLI Phase 1, no GitHub yet
      ├── [GAP]       unpinned clone → master             ├── [GAP]        provision succeeds with NULL branch
      ├── [GAP]       resolveClonedBranch returns name    └── [GAP]        no GitHub call is made   ← REGRESSION
      ├── [GAP]       0 heads → empty_repository
      ├── [GAP]       heads + absent ref →              [+] Phase 2, App granted (web)
      │               invalid_default_branch (NOT empty)  └── [GAP]        NULL and stale 'main' both fill in
      ├── [GAP]       detached → unresolvable_head
      ├── [GAP]       error names repo AND branch       [+] Phase 2, App granted (agent callback)
      ├── [GAP]       stderr surfaced in error            ├── [GAP]        project created AFTER install
      └── [GAP]       token not leaked via stderr         │                still gets its branch
      └── [DELETE]    branch guard — :222,:228            └── [GAP]        master-default repo end to end

[~] packages/worker/src/harness/sandbox-repo.ts        [+] Existing project, stale 'main' row
  └── createRepoSandbox()                                 └── [GAP]        clones + heals + PR base correct
      ├── [★★ TESTED] setupCommands — :63,:78
      ├── [GAP]       unpinned clone                   [+] Configure an uncovered repo in settings
      ├── [GAP]       resolution failure propagates      └── [GAP]        400 names the repo
      └── [GAP]       err.stderr reaches the message
                                                       [+] Clone fails for a non-branch reason
                                                         └── [GAP]        reason is not "fix your permissions"

[~] packages/worker/src/setup-pr.ts
  └── runSetupPr()
      ├── [★★ TESTED] opens PR ×5 — :17,:31,:42,:55,:65
      └── [GAP]       PR base uses RESOLVED branch, not project.default_branch

[~] packages/worker/src/db.ts + callers
  └── updateProjectDefaultBranch()
      ├── [GAP]       writes on change
      ├── [GAP]       no-op when unchanged
      ├── [GAP]       ANY failure is swallowed, not just 0 rows
      └── [GAP]       called at all 5 host clone sites            ← helper must not ship unused

[~] packages/worker/src/setup-agent.ts + index.ts
  └── clone failure classification
      ├── [GAP]       empty repo is NOT reported repo_access_denied
      └── [GAP]       invalid default branch gets its own reason_code

[~] packages/ingestion/db/installations.go
  └── PersistInstallation()
      ├── [GAP]       fills NULL branches for matching projects
      ├── [GAP]       CORRECTS a stale 'main' to 'master'                ← IS DISTINCT FROM
      ├── [GAP]       no matching project is a no-op
      └── [GAP]       existing installation persistence unaffected      ← REGRESSION

[~] packages/ingestion/db/agent_provision.go
  └── ProvisionAgentSession()
      ├── [GAP]       project created at :232 gets the branch
      ├── [GAP]       master-default repo through agent callback         ← REGRESSION
      └── [GAP]       Repos type change does not break the caller        ← REGRESSION

[~] packages/ingestion/handler/github_settings.go     ← NO TEST FILE EXISTS TODAY
  └── SetGitHubConfig()
      ├── [GAP]       stores master for a master repo
      ├── [GAP]       400 on repo outside the installation
      ├── [GAP]       502 when GitHub is unreachable
      └── [GAP]       existing main-default repo still works            ← REGRESSION

[~] packages/ingestion/db/migrations/027_*.sql
      ├── [GAP]       NULL is accepted after migration
      └── [GAP]       existing rows keep their value                    ← REGRESSION

COVERAGE: 8/42 paths tested (19%)  |  Code paths: 8/32 (25%)  |  User flows: 0/10 (0%)
QUALITY: ★★★:0 ★★:8 ★:0  |  GAPS: 34 (1 E2E, 0 eval)  |  DELETE: 2
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke | [→E2E] needs integration test

### Regression tests (mandatory, not optional)

Six paths change behaviour for callers that work today:

- **CLI Phase 1 provisioning must still work, and must still make no GitHub
  call.** Assert the absence, not just the success — the whole point of the
  correction is that this path stays GitHub-free.
- **Agent-callback onboarding must still work end to end**, including against a
  `master`-default repo, since its project is created after the installation is
  persisted.
- Existing installation persistence is unaffected by the `Repos` type change,
  across all three callers.
- A `main`-default repo covered by the installation still succeeds through
  `SetGitHubConfig`, which has no test file at all today.
- A stale `'main'` row is corrected to `'master'` when the installation lands —
  the `IS DISTINCT FROM` behaviour, asserted directly.
- The migration leaves existing row values intact.

### Test fixtures needed

- A bare git remote with `--initial-branch=master`, mirroring `repo-clone.test.ts:158`.
- A bare git remote with zero commits for the empty-repo path.
- A fake `ListInstallationRepos` response via the existing
  `gh.OverrideHTTPClientForTests` hook at `github/app.go:211`.

## Failure modes

| New codepath | Realistic production failure | Test? | Error handling? | User sees |
|---|---|---|---|---|
| Unpinned clone | Repo has zero commits | planned | `ls-remote --heads` = 0 | "`owner/repo` has no commits yet" |
| Unpinned clone | Repo has commits but HEAD points at an absent ref | planned | `ls-remote --heads` > 0 + absent symref | "default branch `X` does not exist in `owner/repo`" |
| `resolveClonedBranch` | Detached HEAD; `symbolic-ref` exits non-zero | planned | third `kind` | "could not determine the default branch" |
| Clone failure classification | Any of the above reported as `repo_access_denied` | planned | `kind` → `reason_code` map | correct cause, not "fix your permissions" |
| Branch write-back | Project deleted mid-job, or any transient UPDATE error | planned | **all failures swallowed + logged** | nothing; job still succeeds |
| Branch write-back | Two concurrent jobs write the same value | no | idempotent | nothing |
| Branch write-back | Helper ships but is never called | planned | caller tests at all 5 sites | rows never heal, silently |
| `PersistInstallation` branch fill | Org has many projects; the UPDATE runs inside the advisory-lock tx | no | bounded by projects-per-org | nothing |
| Agent-callback provisioning | Project created at `agent_provision.go:232` after the fill runs, so it is missed | planned | branch set post-create in the same tx | nothing |
| `SetGitHubConfig` lookup | GitHub 5xx or timeout | planned | 502, not 500 | "could not reach GitHub, retry" |
| Nullable column | A reader dereferences NULL and passes it to git | planned | type change forces handling | compile error, not a runtime one |
| stderr capture | Adversarial repo emits megabytes of stderr | planned | truncate before the DB write | truncated error |
| stderr capture | Token in stderr in an unscrubbed format | planned | both scrub patterns applied | redacted |

**Critical gaps:** none, on three conditions. The write-back must swallow *all*
failures, not just zero rows — otherwise a transient UPDATE error fails work that
already holds the correct branch. The migration must not be paired with a
backfill that blanks existing rows, or in-flight jobs lose a value they are
mid-way through using. And the `updateProjectDefaultBranch` callers must be
wired in the same task as the helper, or the helper ships unused and nothing
heals — a silent no-op that looks like a completed task.

## NOT in scope

- **`repository` webhook handling to track renames.** `webhook.go:57` ignores
  everything but `pull_request`. Clone-time resolution self-heals on every job,
  so a webhook is redundant for correctness. Captured as a TODO.
- **Backfilling or blanking existing rows.** They heal on next clone. A backfill
  would need a GitHub call per project and risks disturbing in-flight jobs.
- **Sending `default_branch` from the browser.** `RepoSelector.vue` has the value,
  but a client-supplied branch is a trust boundary we do not need to open.
- **Any GitHub call in Phase 1.** Deliberately excluded — see the correction log.
- **Supporting a non-default target branch per project.** Real feature, unrelated.
- **Enterprise host PR links** (existing TODOS.md item) — unrelated.

## Parallelization

| Lane | Steps | Modules | Depends on |
|---|---|---|---|
| A | 1, 2 (migration + nullable scan sites) | `packages/ingestion/db/`, `packages/worker/src/db.ts` | — |
| B | 3, 4, 7 (clone, resolve, write-back) | `packages/worker/src/`, `packages/worker/src/harness/` | — |
| C | 8, 9, 10 (installation fill + settings authz) | `packages/ingestion/db/`, `packages/ingestion/handler/` | Lane A |
| D | 5, 6 (thread resolved branch to PR base) | `packages/worker/src/` | Lane B |

Launch A and B in parallel. Then C and D in parallel. A and C both touch
`packages/ingestion/db/` — sequential. B and D both touch
`packages/worker/src/` — sequential. A and B touch `worker/src/db.ts` and
`worker/src/` respectively; coordinate that one file or land A first.

## Implementation Tasks

Synthesized from this review's findings.

- [ ] **T1 (P1, human: ~1.5 days / CC: ~40min)** — ingestion/db — Make `default_branch` nullable
  - Surfaced by: Root cause — `001_baseline.sql:21` cannot express "unknown"
  - Files: `packages/ingestion/db/migrations/027_default_branch_nullable.sql`, `db/queries.go` (8 scan sites), `packages/worker/src/db.ts:1068`
  - Verify: `cd packages/ingestion && go build ./... && go test ./...`; `pnpm -r build`
- [ ] **T2 (P1, human: ~1 day / CC: ~25min)** — worker/clone — Clone unpinned, resolve the branch, return it
  - Surfaced by: Architecture — `index.ts:346` and `pr.ts:692` share one stale value
  - Files: `packages/worker/src/repo-clone.ts`, `packages/worker/src/harness/sandbox-repo.ts`
  - Verify: `pnpm --filter @opslane/worker test repo-clone sandbox-repo`
- [ ] **T3 (P1, human: ~1 day / CC: ~30min)** — worker/clone — Three-way HEAD classification with a typed error
  - Surfaced by: Correction C3 — `rev-parse --verify HEAD` returns 128 for both an empty repo and a repo whose HEAD points at an absent ref, and git's stderr calls both "empty"
  - Files: `packages/worker/src/repo-clone.ts`
  - Verify: three fixtures — bare remote with zero commits; non-empty remote with `symbolic-ref HEAD refs/heads/nonexistent`; detached HEAD. Assert `ls-remote --heads` discriminates and the error names repo AND branch
- [ ] **T3b (P1, human: ~4h / CC: ~15min)** — worker — Map clone-resolution kinds to real reason codes
  - Surfaced by: Correction C3 — `setup-agent.ts:80` and `index.ts:358` report every clone failure as `repo_access_denied` with "Ensure the GitHub App has read access"
  - Files: `packages/worker/src/setup-agent.ts`, `packages/worker/src/index.ts`, `shared` reason codes
  - Verify: an empty repo does not tell the user to fix permissions
- [ ] **T4 (P1, human: ~4h / CC: ~15min)** — worker/clone — Capture redacted, truncated stderr on both clone sites
  - Surfaced by: Code Quality — `sandbox-repo.ts:133` reads `.message`, drops the typed `.stderr`
  - Files: `packages/worker/src/harness/sandbox-repo.ts`, `packages/worker/src/repo-clone.ts`
  - Verify: test asserts git's reason surfaces and an embedded token does not
- [ ] **T5 (P1, human: ~1 day / CC: ~25min)** — worker/pipeline — Make the HOST clone the single branch authority
  - Surfaced by: Architecture — the host checkout receives the diff and is pushed (`gitCommitAndPush(repoDir, …)`); the sandbox at `agent-fix.ts:611` is a separate later clone that could observe a rename mid-job
  - Files: `packages/worker/src/setup-pr.ts`, `pipeline.ts`, `agent-fix.ts`, `index.ts`, `setup-agent.ts`
  - Verify: host `CloneResult.defaultBranch` reaches `PipelineInput` and PR creation; `defaultBranch` is **removed** from `AgentFixInput`, `AgentSetupInput`, and sandbox clone inputs so no second value exists
- [ ] **T6 (P2, human: ~5h / CC: ~20min)** — worker/db — Write the branch back, and wire every caller
  - Surfaced by: Failure modes — a helper with no callers is a silently completed task that heals nothing
  - Files: `packages/worker/src/db.ts`, `packages/worker/src/index.ts` (:346, :525, :739, :882), `packages/worker/src/setup-pr.ts`
  - Verify: caller tests at all 5 host clone sites; **all** write-back failures logged and swallowed, not only the 0-rows case
- [ ] **T7 (P1, human: ~1 day / CC: ~35min)** — ingestion/db — Fill branches when the installation lands, all three callers
  - Surfaced by: Corrections C2 and C4 — `github_oauth.go:373,:643` and `agent_setup.go:449-452` all discard `DefaultBranch` that is already in hand; `IS NULL` would leave legacy `'main'` rows ambiguous forever
  - Files: `packages/ingestion/db/installations.go`, `handler/github_oauth.go`, `handler/agent_setup.go`, `db/agent_provision.go`
  - Verify: uses `IS DISTINCT FROM`, so a stale `'main'` becomes `'master'`. All three callers compile against the new `Repos` type
- [ ] **T7b (P1, human: ~5h / CC: ~20min)** — ingestion/db — Set the branch on the agent-callback project after creation
  - Surfaced by: Correction C2 — `PersistInstallation` runs at `agent_provision.go:217`, `CreateProjectTx` at `:232`, so the fill cannot see this project
  - Files: `packages/ingestion/db/agent_provision.go`, `handler/agent_setup.go`
  - Verify: carry the matched branch on `AgentProvisionInput`, apply post-create in the same tx; regression test onboards a `master`-default repo through the agent callback
- [ ] **T8 (P1, human: ~1 day / CC: ~25min)** — ingestion/handler — Resolve and authorize the repo in settings
  - Surfaced by: Architecture — `github_settings.go:42` validates shape only
  - Files: `packages/ingestion/handler/github_settings.go`, `db/queries.go`
  - Verify: `cd packages/ingestion && go test ./handler/...`
- [ ] **T9 (P1, human: ~4h / CC: ~15min)** — ingestion/handler — Create the missing `github_settings_test.go`
  - Surfaced by: Test review — the handler has no test file and this diff changes its behaviour
  - Files: `packages/ingestion/handler/github_settings_test.go`
  - Verify: master-default storage, 400 on uncovered repo, 502 on GitHub failure, main-default regression
- [ ] **T10 (P1, human: ~3h / CC: ~15min)** — ingestion/handler — Regression: Phase 1 provisioning stays GitHub-free
  - Surfaced by: Correction log — an earlier draft would have broken this path
  - Files: `packages/ingestion/handler/onboard_provision_test.go`
  - Verify: asserts provisioning succeeds with a NULL branch and makes no GitHub call
- [ ] **T11 (P2, human: ~4h / CC: ~20min)** — test-e2e — End-to-end setup PR against a master-default repo
  - Surfaced by: Acceptance criterion 2 in issue #180
  - Files: `test-e2e/`
  - Verify: `pnpm --filter @opslane/test-e2e test`

## Acceptance criteria (from #180, mapped)

| Criterion | Met by |
|---|---|
| Configuring a `master` repo stores `default_branch = 'master'` | T7 (web install), T7b (agent callback), T8 (settings) |
| Setup PR succeeds end to end against a `master` repo | T2, T5, T11 |
| Stale row still clones successfully | T2 — the unpinned clone ignores the row entirely |
| Genuinely missing branch names the repo and branch | **T3, not T4.** Git's stderr calls a broken-HEAD repo "empty", so the typed `CloneResolutionError` supplies the repo and branch; stderr is supporting detail only |
| Regression test covers a non-`main` default through the setup-PR path | T9, T11 |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 issues, 0 critical gaps, 4 corrections |
| Outside Voice | external reviewer | Plan challenge | 1 | issues_found | 5 findings, all confirmed and applied |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE VOICE:** An external review raised 5 findings after this plan was
first written. All 5 were verified against the code and all 5 were correct;
all are applied above as corrections C2-C4 and tasks T3, T3b, T5, T6, T7, T7b.
Finding 2 was verified empirically rather than by reading — the test is
reproduced in correction C3.

**CROSS-MODEL:** No tension. Every outside-voice finding was confirmed, none
contested. The core design (nullable unknown, unpinned clone, runtime
resolution) was endorsed by both reviewers.

**VERDICT:** ENG CLEARED — ready to implement.

**Calibration note.** This review missed two things that a human and an outside
reviewer caught: that Phase 1 onboarding is GitHub-free, and that a third
installation caller exists. Both were reachable by reading code this review
had already opened. The pattern to correct: after grepping for a call site
(`ListInstallationRepos` returned three hits), inspect **all** hits before
concluding, and read the sibling worktree's design docs when a plan touches
onboarding.

NO UNRESOLVED DECISIONS
