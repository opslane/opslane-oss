# Default Branch Resolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop pinning `--branch` at clone time so onboarding and fix PRs work for repos whose default branch is not `main`, and make `projects.default_branch` a self-healing cache that can honestly say "unknown".

**Architecture:** A plain `git clone` checks out the remote's HEAD, which *is* the repository's current default branch. Resolve the name from the clone, thread it through the job to the PR base, and write it back as a cache. The column becomes nullable so Phase 1 onboarding (which runs before GitHub exists) can leave it unset instead of guessing `'main'`. Three GitHub-installation callers additionally fill it in the moment the App is granted, from data they already hold.

**Tech Stack:** Go 1.24 + pgx (ingestion), Node 22 + TypeScript + Vitest (worker), Postgres.

**Design doc:** `docs/plans/2026-07-23-default-branch-resolution-design.md`. Read it first — it carries the root cause, the four corrections, and the rejected alternatives.

**Issue:** https://github.com/opslane/opslane-oss/issues/180

---

## Before you start

Read these, in this order. The plan assumes you have:

1. `docs/plans/2026-07-23-default-branch-resolution-design.md` — especially correction **C3**, which contains an empirical result you must not re-derive: `git rev-parse --verify HEAD` **cannot** tell an empty repo apart from a repo whose HEAD points at a missing ref. Both exit 128, and git's own stderr calls both "empty". The discriminator is `git ls-remote --heads origin`.
2. `docs/plans/2026-07-22-onboarding-10x-design.md:33` — Phase 1 of onboarding is **"Local aha (no GitHub)"**. No handler on the project-create path may call the GitHub API. If you find yourself adding one, stop; you have misread the plan.

**Rules that are easy to violate:**

- `projects.default_branch` is a **cache, never an authority**. Every write to it is best-effort. Never fail a job because the cache write failed.
- The **host** clone is the branch authority, not the sandbox clone. The host checkout is the one that receives the diff and is pushed. The sandbox is a separate, later clone that could observe a rename mid-job.
- **Resolution needs credentials.** `resolveClonedBranch` runs `git ls-remote --heads origin`, a network call — it is the only way to tell an empty repo (0 heads) from a broken-HEAD repo (>=1 head), since a shallow clone leaves 0 local refs for both. On the **host**, the token is embedded in the origin URL by `buildRepoUrl`, so `ls-remote` works after the clone. In the **sandbox**, auth is a `.netrc` that the existing code deletes at `sandbox-repo.ts:140` — so resolution MUST run **before** that deletion, or `ls-remote` fails auth on every private repo. Verified: after `git clone --depth 1`, `for-each-ref` returns 0 refs for both empty and broken-HEAD, so there is no local-only shortcut.

**Codex review corrections (applied):** the counts and call sites below were checked against the code. `index.ts` has **three** clone sites (`:344`, `:523`, `:737`), not four — the old `:882` reference was a pipeline argument, not a clone. Cache write-back lands at **four** sites (those three + `setup-pr.ts`), not five. Six existing test files reference the fields being changed and must be fixed in the same tasks. `redactCloneDetail` goes in `harness/redact.ts` (which already exports `scrubSecrets` and is already imported by `sandbox-repo.ts`), NOT in `sandbox-repo.ts`, to avoid an import cycle with `repo-clone.ts`.

**Verify your environment before Task 1:**

```bash
cd packages/ingestion && go build ./... && go test ./db ./handler
cd ../.. && pnpm --filter @opslane/worker test
```

Expected: both green. If not, fix that first — you need a clean baseline to trust the failures this plan asks you to produce.

---

## Phase 0 — Schema: let the column say "unknown"

This phase gates everything else. The type change is deliberate: it makes the Go and TypeScript compilers enumerate every reader of `default_branch` for you.

### Task 1: Make `projects.default_branch` nullable

**Files:**
- Create: `packages/ingestion/db/migrations/027_default_branch_nullable.sql`

**Step 1: Write the migration**

```sql
-- projects.default_branch was NOT NULL DEFAULT 'main', which cannot express
-- "we have not learned this repo's default branch yet". Onboarding Phase 1
-- creates projects before GitHub is connected, so the guess was written as
-- fact and later used to `git clone --branch main`, breaking every repo whose
-- default branch is not 'main' (issue #180).
--
-- NULL now means unknown. Existing rows keep their current value on purpose:
-- they are corrected when the GitHub App installation lands, or on the next
-- successful clone. Blanking them here would strip a usable value out from
-- under jobs that are mid-flight.
ALTER TABLE projects
  ALTER COLUMN default_branch DROP NOT NULL,
  ALTER COLUMN default_branch DROP DEFAULT;
```

**Step 2: Apply it against a disposable database**

Do **not** use the shared dev Postgres on 5434 — other worktrees share it.

```bash
docker run --rm -d --name pg-dbr -e POSTGRES_USER=opslane \
  -e POSTGRES_PASSWORD=opslane_dev -e POSTGRES_DB=opslane -p 5499:5432 postgres:16
sleep 5
for f in packages/ingestion/db/migrations/*.sql; do
  PGPASSWORD=opslane_dev psql -h localhost -p 5499 -U opslane -d opslane -q -f "$f" || echo "FAILED: $f"
done
```

Expected: no `FAILED` lines.

**Step 3: Prove the new semantics and the preserved rows**

```bash
PGPASSWORD=opslane_dev psql -h localhost -p 5499 -U opslane -d opslane -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
INSERT INTO orgs (name) VALUES ('t') RETURNING id \gset
INSERT INTO projects (org_id, name, github_repo) VALUES (:'id', 'p1', 'o/r1');
SELECT default_branch IS NULL AS new_row_is_null FROM projects WHERE name = 'p1';
INSERT INTO projects (org_id, name, github_repo, default_branch)
  VALUES (:'id', 'p2', 'o/r2', 'master');
SELECT default_branch FROM projects WHERE name = 'p2';
ROLLBACK;
SQL
```

Expected: `new_row_is_null` = `t`, and `p2` = `master`.

**Step 4: Commit**

```bash
git add packages/ingestion/db/migrations/027_default_branch_nullable.sql
git commit -m "feat(db): allow projects.default_branch to be NULL

NULL means 'not yet learned from GitHub'. The old NOT NULL DEFAULT 'main'
could not express that, so onboarding wrote a guess as fact. Refs #180."
```

---

### Task 2: Make the Go type nullable

**Files:**
- Modify: `packages/ingestion/db/queries.go:88` (struct field) and the 7 scan sites at `:153`, `:216`, `:2926`, `:2942`, `:2965`, `:3173`, `:3423`

**Step 1: Change the struct field**

`packages/ingestion/db/queries.go:88`, inside `type Project struct`:

```go
	GithubRepo              *string
	DefaultBranch           *string // NULL until learned from GitHub or a clone
	FrictionAutonomy        string
```

**Step 2: Build to find every reader**

```bash
cd packages/ingestion && go build ./...
```

Expected: FAIL. The compiler lists every site that treats it as a `string`. This is the point of the change — work the list it gives you. The 7 `.Scan(...)` sites need no edit (pgx scans `NULL` into `*string` natively); anything that *dereferences* or compares it does.

**Step 3: Fix each reported site**

For any site that needs a concrete branch, do not substitute a default. Propagate the absence. If a caller genuinely cannot proceed without a branch, return an error naming the project — do not invent `"main"`.

**Step 4: Build and test**

```bash
cd packages/ingestion && go build ./... && go test ./db ./handler
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/db/queries.go
git commit -m "refactor(db): Project.DefaultBranch is *string

Nullable in the schema as of 027; the pointer makes every reader handle
'unknown' explicitly rather than silently receiving a guess. Refs #180."
```

---

### Task 3: Make the worker type nullable

**Files:**
- Modify: `packages/worker/src/db.ts:1068`

**Step 1: Change the interface**

`packages/worker/src/db.ts`, in `ProjectData`:

```ts
export interface ProjectData {
  id: string;
  name: string;
  github_repo: string;
  /** NULL until learned from GitHub or resolved from a clone. Never guess. */
  default_branch: string | null;
  friction_autonomy: FrictionAutonomy;
  pr_posture?: PRPosture;
  draft_pr_cap?: number;
}
```

**Step 2: Typecheck to find every reader**

```bash
pnpm --filter @opslane/worker build
```

Expected: FAIL, listing each site passing `default_branch` where a `string` is required. Those sites are exactly what Phase 2 and Phase 3 rewrite. Leave them broken for now if the fix belongs to a later task; note them.

Known callers and tests that reference `defaultBranch` on the changed types and **will** break — you do not have to fix them in this task, but you must not be surprised by them, and Task 17's full build will not pass until they are all handled by their owning tasks:

- `packages/worker/src/__tests__/repo-clone.test.ts:103`, `:115`, `:135`, `:220` (Task 6)
- `packages/worker/src/harness/__tests__/sandbox-repo-setup.test.ts:64` (Task 7)
- `packages/worker/src/__tests__/agent-fix.test.ts:102` (Task 7)
- `packages/worker/src/__tests__/python-production-path.test.ts:195` — mocks `CloneResult`; add `defaultBranch` to the mock (Task 6)
- `packages/worker/src/__tests__/index.test.ts:10` — must mock `cacheProjectDefaultBranch` and have the clone mock return a `defaultBranch` (Task 12)
- `packages/worker/src/__tests__/pipeline.test.ts` and `precision-gate.test.ts` — pass `defaultBranch: 'main'` literals; these stay valid because `PipelineInput.defaultBranch` remains a required `string` (now sourced from the clone). No change needed, but confirm.

**Step 3: Commit**

```bash
git add packages/worker/src/db.ts
git commit -m "refactor(worker): ProjectData.default_branch is nullable

Mirrors migration 027. Refs #180."
```

---

## Phase 1 — Resolve the branch from the clone

The heart of the fix. Build it test-first with real git fixtures, because the failure modes here are git behaviours you cannot mock honestly.

### Task 4: Write the clone-resolution fixtures

**Files:**
- Create: `packages/worker/src/__tests__/clone-resolution.test.ts`

**Step 1: Write the fixture builders and the failing tests**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClonedBranch, CloneResolutionError, execFileGitRunner } from '../repo-clone.js';

const execFile = promisify(execFileCb);

/** Isolate from the developer's ~/.gitconfig so init.defaultBranch cannot skew results. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
} as NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]) =>
  execFile('git', args, { cwd, env: GIT_ENV });

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'dbr-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** A normal repo whose default branch is `master`, not `main`. */
async function masterRemote(name: string): Promise<string> {
  const work = join(root, `${name}-work`);
  await execFile('git', ['init', '-q', '--initial-branch=master', work], { env: GIT_ENV });
  await execFile('sh', ['-c', `echo hi > ${work}/a.txt`]);
  await git(work, 'add', '-A');
  await git(work, 'commit', '-qm', 'init');
  const bare = join(root, `${name}-bare`);
  await execFile('git', ['clone', '-q', '--bare', work, bare], { env: GIT_ENV });
  return `file://${bare}`;
}

/** A repo with commits whose HEAD points at a branch that does not exist. */
async function brokenHeadRemote(name: string): Promise<string> {
  const url = await masterRemote(name);
  const bare = url.replace('file://', '');
  await git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/nonexistent');
  return url;
}

/** A repo with no commits at all. */
async function emptyRemote(name: string): Promise<string> {
  const bare = join(root, `${name}-bare`);
  await execFile('git', ['init', '-q', '--bare', '--initial-branch=master', bare], { env: GIT_ENV });
  return `file://${bare}`;
}

async function cloneTo(url: string, name: string): Promise<string> {
  const dir = join(root, name);
  await execFile('git', ['clone', '--depth', '1', '--', url, dir], { env: GIT_ENV });
  return dir;
}

describe('resolveClonedBranch', () => {
  it('returns the real default branch when it is not main', async () => {
    const dir = await cloneTo(await masterRemote('ok'), 'ok-clone');
    await expect(resolveClonedBranch(execFileGitRunner(dir), 'o/r')).resolves.toBe('master');
  });

  it('classifies a repo with no commits as empty_repository', async () => {
    const dir = await cloneTo(await emptyRemote('empty'), 'empty-clone');
    const err = await resolveClonedBranch(execFileGitRunner(dir), 'o/empty').catch(e => e);
    expect(err).toBeInstanceOf(CloneResolutionError);
    expect(err.kind).toBe('empty_repository');
    expect(err.message).toContain('o/empty');
  });

  // The regression this whole classification exists for. `rev-parse --verify HEAD`
  // exits 128 here exactly as it does for an empty repo, and git's own stderr
  // calls this repo "empty" too. Only `ls-remote --heads` tells them apart.
  it('does NOT call a broken-HEAD repo empty, and names the missing branch', async () => {
    const dir = await cloneTo(await brokenHeadRemote('broken'), 'broken-clone');
    const err = await resolveClonedBranch(execFileGitRunner(dir), 'o/broken').catch(e => e);
    expect(err).toBeInstanceOf(CloneResolutionError);
    expect(err.kind).toBe('invalid_default_branch');
    expect(err.discoveredBranch).toBe('nonexistent');
    expect(err.message).toContain('o/broken');
    expect(err.message).toContain('nonexistent');
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @opslane/worker test clone-resolution
```

Expected: FAIL — `resolveClonedBranch`, `CloneResolutionError`, and `execFileGitRunner` are not exported from `repo-clone.ts`.

**Step 3: Commit the failing test**

```bash
git add packages/worker/src/__tests__/clone-resolution.test.ts
git commit -m "test(worker): failing fixtures for clone branch resolution

Includes the broken-HEAD case that rev-parse cannot distinguish from an
empty repo. Refs #180."
```

---

### Task 5: Implement `resolveClonedBranch`

**Files:**
- Modify: `packages/worker/src/repo-clone.ts`

**Step 1: Add the runner abstraction, the error type, and the resolver**

Append to `packages/worker/src/repo-clone.ts`:

```ts
/** Result of a git invocation that is allowed to fail without throwing. */
export interface GitResult { stdout: string; stderr: string; exitCode: number }

/**
 * Runs git and reports failure as data, not exceptions. Two backends implement
 * it: execFile on the host, and `sandbox.commands.run` inside E2B. The transport
 * differs; the classification rule below must not.
 */
export type GitRunner = (args: string[]) => Promise<GitResult>;

export type CloneResolutionKind =
  | 'empty_repository'
  | 'invalid_default_branch'
  | 'unresolvable_head';

export class CloneResolutionError extends Error {
  readonly kind: CloneResolutionKind;
  readonly repo: string;
  /** The branch HEAD names, when we got that far. Absent for an empty repo. */
  readonly discoveredBranch?: string;

  constructor(kind: CloneResolutionKind, repo: string, discoveredBranch?: string) {
    super(CloneResolutionError.describe(kind, repo, discoveredBranch));
    this.name = 'CloneResolutionError';
    this.kind = kind;
    this.repo = repo;
    this.discoveredBranch = discoveredBranch;
  }

  private static describe(kind: CloneResolutionKind, repo: string, branch?: string): string {
    switch (kind) {
      case 'empty_repository':
        return `${repo} has no commits yet, so there is no branch to work from`;
      case 'invalid_default_branch':
        return `default branch '${branch}' does not exist in ${repo}`;
      case 'unresolvable_head':
        return `could not determine the default branch of ${repo}`;
    }
  }
}

/** A GitRunner backed by execFile against an already-cloned working directory. */
export function execFileGitRunner(repoDir: string): GitRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFile('git', args, {
        cwd: repoDir, timeout: 15_000, env: scrubbedEnv(),
      });
      return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? ''),
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  };
}

/**
 * Determine a clone's default branch, distinguishing the three ways it can fail.
 *
 *   ls-remote --heads ── 0 refs ─────────────────> empty_repository
 *          │
 *       >=1 refs
 *          │
 *   symbolic-ref HEAD ── fails ──────────────────> unresolvable_head
 *          │
 *       branch name
 *          │
 *   rev-parse --verify HEAD ── fails ────────────> invalid_default_branch
 *          │                                        (HEAD names an absent ref)
 *        commit
 *          │
 *          └────────────────────────────────────> branch
 *
 * Do NOT reorder these. `rev-parse --verify HEAD` exits 128 for BOTH an empty
 * repo and a broken-HEAD repo, and `git clone` prints "you appear to have cloned
 * an empty repository" for both. `ls-remote --heads` is the only discriminator.
 * See correction C3 in the design doc for the measured evidence.
 */
export async function resolveClonedBranch(run: GitRunner, repo: string): Promise<string> {
  const heads = await run(['ls-remote', '--heads', 'origin']);
  if (heads.exitCode === 0 && heads.stdout.trim() === '') {
    throw new CloneResolutionError('empty_repository', repo);
  }

  const symbolic = await run(['symbolic-ref', '--short', 'HEAD']);
  if (symbolic.exitCode !== 0) {
    throw new CloneResolutionError('unresolvable_head', repo);
  }
  const branch = symbolic.stdout.trim();
  if (branch === '') {
    throw new CloneResolutionError('unresolvable_head', repo);
  }

  const head = await run(['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0) {
    throw new CloneResolutionError('invalid_default_branch', repo, branch);
  }

  return branch;
}
```

**Step 2: Run the tests**

```bash
pnpm --filter @opslane/worker test clone-resolution
```

Expected: PASS, all three.

**Step 3: Commit**

```bash
git add packages/worker/src/repo-clone.ts
git commit -m "feat(worker): resolve a clone's default branch, classified

Three-way classification via ls-remote --heads, because rev-parse cannot
tell an empty repo from one whose HEAD names a missing ref. Refs #180."
```

---

### Task 6: Stop pinning `--branch` on the host clone

**Files:**
- Modify: `packages/worker/src/repo-clone.ts` (`CloneOptions`, `CloneResult`, `cloneRepo`)
- Modify: `packages/worker/src/__tests__/repo-clone.test.ts:219-233` (delete the dead guard tests)

**Step 1: Write the failing test**

Append to `packages/worker/src/__tests__/clone-resolution.test.ts`:

```ts
import { cloneRepo } from '../repo-clone.js';

describe('cloneRepo without a pinned branch', () => {
  it('clones a master-default repo and reports the branch', async () => {
    const url = await masterRemote('hostclone');
    process.env['OPSLANE_GITHUB_URL'] = url; // exercised via buildRepoUrl
    const result = await cloneRepo({
      githubRepo: 'o/r', jobId: `t-${Date.now()}`, githubToken: 'x',
    });
    expect(result.defaultBranch).toBe('master');
    await result.cleanup();
  });
});
```

> If routing a `file://` remote through `buildRepoUrl` proves awkward, extract the
> URL-building step behind an optional `repoUrl` override on `CloneOptions` rather
> than weakening the assertion. Do not delete the test.

**Step 2: Run to verify it fails**

```bash
pnpm --filter @opslane/worker test clone-resolution
```

Expected: FAIL — `defaultBranch` is not on `CloneResult`, and `CloneOptions` still requires `defaultBranch`.

**Step 3: Change the interfaces and the clone**

In `packages/worker/src/repo-clone.ts`:

```ts
export interface CloneOptions {
  githubRepo: string;   // "owner/repo"
  jobId: string;
  timeoutMs?: number;
  githubToken?: string;
}

export interface CloneResult {
  repoDir: string;
  /** Resolved from the clone itself. This is the branch authority for the job. */
  defaultBranch: string;
  cleanup: () => Promise<void>;
}
```

In `cloneRepo`, delete the `defaultBranch` destructure and the branch guard at `:67`:

```ts
  // REMOVED: the `unsafe branch name` guard. It defended against a stored branch
  // being parsed as a git option; there is no longer a stored branch to pass.
```

Replace the clone invocation:

```ts
    // No `--branch`: a plain clone checks out the remote's HEAD, which IS the
    // repository's current default branch. `--` still ends options so neither
    // the URL nor the directory can be reinterpreted as a git option.
    await execFile('git', [
      'clone', '--depth', '1',
      '--', cloneUrl, repoDir,
    ], { timeout: timeoutMs, env: scrubbedEnv() });
```

After the clone succeeds, resolve and return:

```ts
  const defaultBranch = await resolveClonedBranch(execFileGitRunner(repoDir), githubRepo);

  return {
    repoDir,
    defaultBranch,
    cleanup: async () => {
      await execFile('rm', ['-rf', repoDir]).catch(() => {});
    },
  };
```

**Step 4: Delete the now-dead guard tests**

Remove `packages/worker/src/__tests__/repo-clone.test.ts:222` (`rejects a branch that could be parsed as a git option`) and `:228` (`rejects a branch containing whitespace`). Keep `:232` (`rejects a repo that is not owner/name`) — the repo guard still has an input.

**Step 5: Run the full worker suite**

```bash
pnpm --filter @opslane/worker test
```

Expected: the new tests PASS; call sites in `index.ts`, `setup-pr.ts`, and `pipeline.ts` now fail to typecheck. That is expected and is Phase 3's work.

**Step 6: Commit**

```bash
git add packages/worker/src/repo-clone.ts packages/worker/src/__tests__/
git commit -m "feat(worker): clone without --branch, return the resolved branch

Remote HEAD is by definition the current default branch, so pinning a
stored value could only ever be stale or wrong. Refs #180."
```

---

### Task 7: Do the same for the sandbox clone

**Files:**
- Modify: `packages/worker/src/harness/sandbox-repo.ts:109-140`
- Modify: `packages/worker/src/harness/redact.ts` (add `redactCloneDetail` — NOT in sandbox-repo.ts)

> **Why redact.ts and not sandbox-repo.ts:** `sandbox-repo.ts:3` already imports
> from `repo-clone.ts` (`buildGitNetrc`). If `repo-clone.ts` then imported
> `redactCloneDetail` back from `sandbox-repo.ts`, that is a cycle. `redact.ts`
> is dependency-neutral, already exports `scrubSecrets`, and is already imported
> by `sandbox-repo.ts`. Build on `scrubSecrets` rather than re-writing the URL scrub.

**Step 1: Add `redactCloneDetail` to `redact.ts`**

```ts
/** Max clone detail carried into a stored error. An adversarial repo can emit a lot. */
const CLONE_DETAIL_LIMIT = 2_000;

/**
 * Scrub credentials from a clone failure detail and bound its length before it
 * is stored in setup_pr_error or shown in the dashboard. Reuses scrubSecrets
 * (which already handles the https userinfo and PAT/token formats) and adds the
 * x-access-token:...@ shape the host clone URL uses.
 */
export function redactCloneDetail(detail: string): string {
  const scrubbed = scrubSecrets(detail)
    .replace(/x-access-token:[^@\s]{1,512}@/g, 'x-access-token:***@');
  return scrubbed.length > CLONE_DETAIL_LIMIT
    ? `${scrubbed.slice(0, CLONE_DETAIL_LIMIT)}… (truncated)`
    : scrubbed;
}
```

**Step 2: Rewrite the sandbox clone block — resolve BEFORE deleting `.netrc`**

The existing ordering is: write `.netrc` (`:125`) → clone (`:131`) → `rm -f /home/user/.netrc` (`:140`). `resolveClonedBranch` runs `ls-remote --heads origin`, which needs that credential. So resolution goes **between the clone and the delete**, and the delete moves into a `finally` so it always runs.

```ts
    const runner: GitRunner = async (args) => {
      const r = await sandbox.commands.run(
        `git -C ${SANDBOX_REPO} ${args.map(shellEscape).join(' ')}`,
        { timeoutMs: 30_000 },
      ).catch((e: unknown) => e);
      if (r instanceof Error) {
        return { stdout: '', stderr: String((r as { stderr?: string }).stderr ?? r.message), exitCode: 1 };
      }
      return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: 0 };
    };

    let sandboxDefaultBranch: string | undefined;
    try {
      // No --branch: a plain clone checks out the remote's HEAD. The sandbox
      // resolves its branch for VALIDATION AND ERROR REPORTING ONLY; the host
      // clone is the PR-base authority.
      await sandbox.commands.run(
        `git clone --depth 1 ${shellEscape(opts.repoUrl)} ${SANDBOX_REPO}`,
        { timeoutMs: 120_000 },
      );
      // Resolve WHILE .netrc still exists — ls-remote needs the credential.
      sandboxDefaultBranch = await resolveClonedBranch(runner, opts.githubRepo ?? 'repo');
    } catch (err: unknown) {
      const detail = err instanceof Error
        // err.stderr is declared on the runtime error type (sandbox-runtime.ts:71)
        // and is where git's actual reason lives. Reading only .message is why
        // production recorded the useless "clone failed: exit status 128" (#180).
        ? `${err.message}${(err as { stderr?: string }).stderr ? `\n${(err as { stderr?: string }).stderr}` : ''}`
        : String(err);
      throw new Error(`clone failed: ${redactCloneDetail(detail)}`);
    } finally {
      if (gitNetrc) await sandbox.commands.run('rm -f /home/user/.netrc').catch(() => {});
    }
```

Delete the now-duplicated `rm -f /home/user/.netrc` that was at `:140`. `createRepoSandbox`'s options need a `githubRepo` field for the error messages; thread it from the caller (it already has `project.github_repo`).

Apply `redactCloneDetail` (imported from `./redact.js`) to the catch in `repo-clone.ts` `cloneRepo`, replacing its inline single-pattern scrub.

**Step 3: Write the redaction test**

Create `packages/worker/src/harness/__tests__/clone-detail-redaction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { redactCloneDetail } from '../redact.js';

describe('redactCloneDetail', () => {
  it('scrubs an x-access-token credential', () => {
    const out = redactCloneDetail('fatal: https://x-access-token:ghs_SECRET@github.com/o/r.git not found');
    expect(out).not.toContain('ghs_SECRET');
    expect(out).toContain('***@');
  });

  it('scrubs a bare userinfo credential', () => {
    expect(redactCloneDetail('https://user:pw@example.com/x')).not.toContain('pw@');
  });

  it('truncates adversarially long output', () => {
    const out = redactCloneDetail('x'.repeat(10_000));
    expect(out.length).toBeLessThan(2_100);
    expect(out).toContain('truncated');
  });

  it('keeps the useful part of a real git failure', () => {
    const out = redactCloneDetail("fatal: Remote branch main not found in upstream origin");
    expect(out).toContain('Remote branch main not found');
  });
});
```

**Step 4: Run**

```bash
pnpm --filter @opslane/worker test clone-detail-redaction
```

Expected: PASS.

**Step 5: Remove `defaultBranch` from the sandbox input**

Delete `defaultBranch` from the `createRepoSandbox` options type (`sandbox-repo.ts:111`, add `githubRepo`) and from `AgentSetupInput` (`setup-agent.ts:41`) and `AgentFixInput` (`agent-fix.ts:53`). There must be exactly one branch value in the system per job, and it comes from the host clone. Fix the two tests the type change breaks now: `sandbox-repo-setup.test.ts:64` and `agent-fix.test.ts:102`.

**Step 6: Commit**

```bash
git add packages/worker/src/harness/ packages/worker/src/repo-clone.ts packages/worker/src/setup-agent.ts packages/worker/src/agent-fix.ts
git commit -m "feat(worker): unpinned sandbox clone, and surface git's stderr

The sandbox error path read only err.message, discarding the stderr its own
error type declares — the direct cause of the undiagnosable
'clone failed: exit status 128' in #180. Refs #180."
```

---

## Phase 2 — Say what actually went wrong

Today every clone failure is reported as `repo_access_denied` with the remediation "Ensure the GitHub App has read access". An empty repo therefore tells the user to fix permissions they already have.

### Task 8: Add the three reason codes

**Files:**
- Modify: `shared/src/types.ts:120-133`
- Modify: `packages/worker/src/reason-codes.ts:8`

**Step 1: Extend the union**

In `shared/src/types.ts`, add to `ReasonCode`:

```ts
  | 'empty_repository'
  | 'invalid_default_branch'
  | 'unresolvable_head'
```

**Step 2: Build to trigger the exhaustiveness check**

```bash
pnpm -r build
```

Expected: FAIL in `reason-codes.ts`. `DEFAULT_REMEDIATION` is typed `Record<ReasonCode, string>`, so a missing entry is a compile error by design.

**Step 3: Add the remediations**

```ts
  empty_repository:
    'Push at least one commit to this repository, then retry — there is no branch for Opslane to work from yet.',
  invalid_default_branch:
    "This repository's default branch points at a branch that no longer exists. Set a valid default branch in GitHub (Settings → Branches), then retry.",
  unresolvable_head:
    'Opslane could not determine this repository\'s default branch. Check the repository is not in an unusual state, then retry.',
```

**Step 4: Build**

```bash
pnpm -r build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/src/types.ts packages/worker/src/reason-codes.ts
git commit -m "feat(shared): reason codes for the three clone-resolution failures

Refs #180."
```

---

### Task 9: Map resolution failures to their real reason code

**Files:**
- Modify: `packages/worker/src/setup-agent.ts:80-86`
- Modify: `packages/worker/src/index.ts:352-360`

**Step 1: Write the failing test**

Create `packages/worker/src/__tests__/clone-failure-classification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CloneResolutionError } from '../repo-clone.js';
import { cloneFailureReason } from '../repo-clone.js';

describe('cloneFailureReason', () => {
  it('does not blame permissions for an empty repo', () => {
    const r = cloneFailureReason(new CloneResolutionError('empty_repository', 'o/r'));
    expect(r.reason_code).toBe('empty_repository');
    expect(r.remediation).not.toMatch(/read access|permission/i);
  });

  it('names the missing branch for an invalid default', () => {
    const r = cloneFailureReason(new CloneResolutionError('invalid_default_branch', 'o/r', 'gone'));
    expect(r.reason_code).toBe('invalid_default_branch');
    expect(r.reason_message).toContain('gone');
    expect(r.reason_message).toContain('o/r');
  });

  it('still reports a genuine access failure as repo_access_denied', () => {
    const r = cloneFailureReason(new Error('remote: Repository not found'));
    expect(r.reason_code).toBe('repo_access_denied');
  });

  it('still detects a missing token', () => {
    expect(cloneFailureReason(new Error('GITHUB_TOKEN is not set')).reason_code)
      .toBe('missing_github_token');
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @opslane/worker test clone-failure-classification
```

Expected: FAIL — `cloneFailureReason` is not exported.

**Step 3: Implement it once, in `repo-clone.ts`**

```ts
import { DEFAULT_REMEDIATION } from './reason-codes.js';
import type { NeedsHumanReason } from '@opslane/shared';

/**
 * Single classifier for clone failures, shared by the host and sandbox paths.
 * Before this existed, both sites hardcoded `repo_access_denied`, so an empty
 * repository told the user to fix GitHub App permissions.
 */
export function cloneFailureReason(err: unknown): NeedsHumanReason {
  if (err instanceof CloneResolutionError) {
    return {
      reason_code: err.kind,
      reason_message: err.message,
      remediation: DEFAULT_REMEDIATION[err.kind],
    };
  }
  const raw = err instanceof Error ? err.message : String(err);
  const code = raw.includes('GITHUB_TOKEN') ? 'missing_github_token' : 'repo_access_denied';
  return {
    reason_code: code,
    reason_message: redactCloneDetail(raw),
    remediation: DEFAULT_REMEDIATION[code],
  };
}
```

**Step 4: Use it at EVERY clone catch site**

There are more than two. Codex review found that only fixing the first host-clone catch leaves empty/broken-HEAD repos still reported as `repo_access_denied` on the fix paths. Replace the hardcoded classification at all of them:

- `setup-agent.ts:80-86` — the `repo_access_denied` block
- `index.ts:352-360` — the first host-clone `isTokenMissing` ternary
- `index.ts:529` — the friction-path clone catch
- `index.ts:745` — the fix-path clone catch
- `agent-fix.ts:620` — the sandbox-fix classification

Grep to be sure you have them all before committing:

```bash
grep -rn "repo_access_denied\|isTokenMissing" packages/worker/src --include=*.ts | grep -v __tests__ | grep -v reason-codes.ts
```

Expected after the edit: zero hardcoded `repo_access_denied` assignments outside `cloneFailureReason` and `DEFAULT_REMEDIATION`.

**Step 5: Run and commit**

```bash
pnpm --filter @opslane/worker test
git add packages/worker/src/
git commit -m "fix(worker): classify clone failures instead of blaming permissions

An empty repo previously told the user to check GitHub App read access.
Refs #180."
```

---

## Phase 3 — Thread the host branch, and heal the cache

### Task 10: Use the resolved branch as the PR base

**Files:**
- Modify: `packages/worker/src/setup-pr.ts:12-18`, `:72`, `:91`, `:103`
- Modify: `packages/worker/src/__tests__/setup-pr.test.ts:5`

**Step 1: Write the failing test**

In `packages/worker/src/__tests__/setup-pr.test.ts`, make the stubbed project carry a *stale* row and the clone report the truth:

```ts
  // The row is stale on purpose: this asserts the PR base comes from the clone,
  // not from the database. A stale row is the normal state for every project
  // created before this fix landed.
  getProject: vi.fn().mockResolvedValue({ github_repo: 'o/r', default_branch: 'main' }),
  clone: vi.fn().mockResolvedValue({
    repoDir: '/tmp/x', defaultBranch: 'master', cleanup: async () => {},
  }),
```

Add:

```ts
  it('bases the PR on the branch resolved by the clone, not the stale row', async () => {
    const d = deps();
    await runSetupPr(job, d);
    expect(d.createPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ base: 'master' }),
    );
  });
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @opslane/worker test setup-pr
```

Expected: FAIL — base is `main`.

**Step 3: Rewire `runSetupPr`**

The clone must move **above** `runAgentSetup`, because the agent no longer receives a branch and the PR base now comes from the clone:

```ts
    const cloneResult = await d.clone({
      githubRepo: project.github_repo,
      jobId: job.jobId,
      githubToken: token,
    });
    cleanup = cloneResult.cleanup;
    // The clone is the authority for this job. project.default_branch may be
    // stale, NULL, or a pre-#180 guess; none of that matters here.
    const defaultBranch = cloneResult.defaultBranch;

    const agent = await d.runAgentSetup({
      repoUrl, githubToken: token,
      apiKeyEnvVar: job.apiKeyEnvVar, releaseEnvVar: job.releaseEnvVar,
    });
```

and at the PR creation:

```ts
      base: defaultBranch,
```

Update the `SetupPrDeps` interface: drop `default_branch` from `getProject`'s return type, drop `defaultBranch` from `clone`'s options and from `runAgentSetup`'s input, and add `defaultBranch: string` to `clone`'s result.

**Step 4: Run and commit**

```bash
pnpm --filter @opslane/worker test setup-pr
git add packages/worker/src/setup-pr.ts packages/worker/src/__tests__/setup-pr.test.ts
git commit -m "fix(worker): base the setup PR on the resolved branch

Fixing only the clone would still 422 on PR creation for every stale row.
Refs #180."
```

---

### Task 11: Thread the branch through the fix pipeline

**Files:**
- Modify: `packages/worker/src/index.ts:344`, `:523`, `:737` (the **three** real `cloneRepo` sites — verify with `grep -n 'cloneRepo(' packages/worker/src/index.ts`)
- Modify: `packages/worker/src/pipeline.ts:41`, `:117`, `:310`

> `index.ts:882` is **not** a clone site — it is a `defaultBranch:` field on a
> pipeline-input object. It gets the resolved value like the others, but there is
> no clone there to change.

**Step 1: Fix the call sites the compiler is already flagging**

At each of the three `index.ts` `cloneRepo` sites, drop `defaultBranch: project.default_branch` from the clone call and pass `cloneResult.defaultBranch` into the pipeline input (including the object at `:882`) instead.

**Step 2: Build**

```bash
pnpm --filter @opslane/worker build
```

Expected: PASS. `PipelineInput.defaultBranch` stays a required `string` — it is now always supplied from a clone, never from the nullable row.

**Step 3: Run the suite and commit**

```bash
pnpm --filter @opslane/worker test
git add packages/worker/src/index.ts packages/worker/src/pipeline.ts
git commit -m "fix(worker): fix PRs base on the resolved branch too

Refs #180."
```

---

### Task 12: Write the branch back as a cache

**Files:**
- Modify: `packages/worker/src/db.ts`
- Modify: `packages/worker/src/index.ts` (4 sites), `packages/worker/src/setup-pr.ts`

**Step 1: Write the failing test**

Create `packages/worker/src/__tests__/default-branch-cache.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { cacheProjectDefaultBranch } from '../db.js';

describe('cacheProjectDefaultBranch', () => {
  it('never throws when the update fails', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection reset')) };
    // The column is a cache, never an authority. A failed cache write must not
    // fail work that already holds the correct resolved branch.
    await expect(cacheProjectDefaultBranch('p1', 'master', pool as never)).resolves.toBeUndefined();
  });

  it('never throws when the project no longer exists', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    await expect(cacheProjectDefaultBranch('gone', 'master', pool as never)).resolves.toBeUndefined();
  });

  it('writes only when the value differs', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    await cacheProjectDefaultBranch('p1', 'master', pool as never);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('IS DISTINCT FROM'),
      ['p1', 'master'],
    );
  });
});
```

**Step 2: Run to verify it fails, then implement**

```ts
/**
 * Refresh the cached default branch. Best-effort by contract: the column is a
 * cache, never an authority, so EVERY failure here is logged and swallowed.
 * A transient UPDATE error must never fail a job that already resolved the
 * branch correctly from its clone.
 */
export async function cacheProjectDefaultBranch(
  projectId: string,
  branch: string,
  pool = getPool(),
): Promise<void> {
  try {
    await pool.query(
      `UPDATE projects SET default_branch = $2
       WHERE id = $1 AND default_branch IS DISTINCT FROM $2`,
      [projectId, branch],
    );
  } catch (err: unknown) {
    console.warn('[default-branch-cache] refresh failed', { projectId, branch, err });
  }
}
```

**Step 3: Wire every caller**

Call it immediately after each successful host clone — `index.ts:344`, `:523`, `:737`, and the `setup-pr.ts` clone. **Four sites** (there are three `cloneRepo` calls in `index.ts`, not four; `:882` is a pipeline arg, not a clone).

> A helper with no callers is a task that looks complete and heals nothing. Grep
> before you commit: `grep -rn cacheProjectDefaultBranch packages/worker/src --include=*.ts | grep -v __tests__`
> must report the definition plus 4 call sites.

Also update `packages/worker/src/__tests__/index.test.ts:10` — its module mock must add `cacheProjectDefaultBranch` (a no-op) and its clone mock must return a `defaultBranch`, or the suite fails to run.

**Step 4: Run and commit**

```bash
pnpm --filter @opslane/worker test
grep -rn "cacheProjectDefaultBranch" packages/worker/src --include=*.ts | grep -v __tests__
git add packages/worker/src/
git commit -m "feat(worker): cache the resolved branch back to the project row

Self-heals every stale row on its next job, with no migration. Refs #180."
```

---

## Phase 4 — Fill the branch when the installation lands

Three callers reach `PersistInstallation`. One of them creates its project *afterwards*, so it needs different handling. Getting this wrong is the mistake the design review made; see correction **C2**.

### Task 13: Carry the branch into `PersistInstallationParams`

**Files:**
- Modify: `packages/ingestion/db/installations.go:15-22`, `:47-73`
- Modify: `packages/ingestion/handler/github_oauth.go:373`, `:643`
- Modify: `packages/ingestion/handler/agent_setup.go:449`

**Step 1: Write the failing test**

Create `packages/ingestion/db/installations_default_branch_test.go`. It must assert the `IS DISTINCT FROM` behaviour explicitly:

```go
// A project row holding the pre-#180 schema guess 'main' is indistinguishable
// from a confirmed value. When the installation lands with authoritative data,
// it must be corrected — not skipped as "already set".
func TestPersistInstallationCorrectsStaleDefaultBranch(t *testing.T) {
	// seed: org, project with github_repo='o/r' and default_branch='main'
	// act:  PersistInstallation with Repos=[{FullName:"o/r", DefaultBranch:"master"}]
	// want: project.default_branch == "master"
}

func TestPersistInstallationFillsNullDefaultBranch(t *testing.T) {
	// seed: project with default_branch NULL (the Phase 1 onboarding state)
	// want: filled with the installation's value
}

func TestPersistInstallationLeavesUnmatchedProjectsAlone(t *testing.T) {
	// seed: project with github_repo='o/other'
	// want: untouched
}
```

Follow the existing table/setup conventions in `packages/ingestion/db` for transaction handling.

**Step 2: Run to verify it fails**

```bash
cd packages/ingestion && go test ./db -run DefaultBranch -v
```

Expected: FAIL to compile — the rich repo type does not exist.

**Step 3: Change the type and add the update**

```go
// InstallationRepo is a repository covered by an installation, with the
// metadata GitHub already gave us. DefaultBranch was previously discarded at
// every caller, which is why projects kept the schema guess (issue #180).
type InstallationRepo struct {
	FullName      string
	DefaultBranch string
}

type PersistInstallationParams struct {
	InstallationID int64
	GitHubOrgName  string
	GitHubOrgID    int64
	OrgID          string
	Repos          []InstallationRepo
}
```

`InsertInstallationLanded` and the `reposJSON` marshal at `installations.go:47-51` still take `[]string`. Flatten once at the top of `PersistInstallation` so both the JSON column and the audit contract are unchanged:

```go
	repoNames := make([]string, 0, len(params.Repos))
	for _, r := range params.Repos {
		repoNames = append(repoNames, r.FullName)
	}
	// existing code: reposJSON = json.Marshal(repoNames); INSERT ... repos = reposJSON;
	// InsertInstallationLanded(ctx, tx, ..., repoNames)
```

Add, inside the existing transaction, after the org column update:

```go
	// Fill in the default branch for projects pointed at a covered repo.
	// IS DISTINCT FROM, not IS NULL: rows still holding the pre-#180 schema
	// guess 'main' are exactly the ambiguous case that needs correcting, and
	// there is no feature that lets a user pick a non-default target branch.
	for _, repo := range params.Repos {
		if repo.DefaultBranch == "" {
			continue
		}
		if _, err := tx.Exec(ctx,
			`UPDATE projects SET default_branch = $3
			 WHERE org_id = $1 AND github_repo = $2
			   AND default_branch IS DISTINCT FROM $3`,
			params.OrgID, repo.FullName, repo.DefaultBranch); err != nil {
			return fmt.Errorf("refresh project default branch: %w", err)
		}
	}
```

**Step 4: Update all three callers AND the agent-provision fallback AND an existing test**

Codex review confirmed the type change breaks more than the three flatten sites:

- Stop flattening at `github_oauth.go:373`, `:643`, and `agent_setup.go:449`. Build `[]db.InstallationRepo` from the `[]gh.Repo` each already holds.
- `agent_provision.go:213-215` has a fallback `installationRepos := in.Repos; if len(...) == 0 { installationRepos = []string{in.CanonicalRepo} }`. After `in.Repos` becomes `[]InstallationRepo`, the `[]string{...}` literal no longer compiles. Change it to `[]db.InstallationRepo{{FullName: in.CanonicalRepo, DefaultBranch: in.CanonicalDefaultBranch}}` (the `CanonicalDefaultBranch` field is added in Task 14 — if you do Task 13 first, use `""`).
- `packages/ingestion/db/oauth_installation_test.go:33` constructs `Repos` as `[]string`. Update the fixture to `[]db.InstallationRepo`.

**Step 5: Build and test**

```bash
cd packages/ingestion && go build ./... && go test ./db ./handler
```

Expected: PASS. If a caller you did not expect fails to compile, add it and note it in the design doc.

**Step 6: Commit**

```bash
git add packages/ingestion/db/installations.go packages/ingestion/handler/github_oauth.go packages/ingestion/handler/agent_setup.go packages/ingestion/db/installations_default_branch_test.go
git commit -m "feat(ingestion): learn default_branch when the installation lands

All three callers already held DefaultBranch and discarded it. Refs #180."
```

---

### Task 14: Fix the agent-callback ordering

**Files:**
- Modify: `packages/ingestion/db/agent_provision.go:21-35`, `:217`, `:232`
- Modify: `packages/ingestion/handler/agent_setup.go:453`

**Step 1: Understand the ordering before you touch it**

```
ProvisionAgentSession (one transaction)
  :217  PersistInstallation ──> UPDATE projects ... ──> matches NOTHING
  :232  CreateProjectTx     ──> the project is created HERE, afterwards
```

The Task 13 update cannot see this project. It does not exist yet.

**Step 2: Write the failing test**

In `packages/ingestion/db/agent_provision_test.go` (follow the existing conventions there):

```go
// The agent-callback path creates its project AFTER PersistInstallation runs,
// so the branch fill in PersistInstallation cannot reach it. Regression test
// for correction C2.
func TestProvisionAgentSessionStoresMasterDefaultBranch(t *testing.T) {
	// act:  ProvisionAgentSession with CanonicalRepo="o/r" whose installation
	//       repo list reports DefaultBranch="master"
	// want: the created project has default_branch == "master"
}
```

**Step 3: Run to verify it fails**

```bash
cd packages/ingestion && go test ./db -run ProvisionAgentSession -v
```

Expected: FAIL — branch is NULL.

**Step 4: Carry the branch and apply it post-create**

```go
type AgentProvisionInput struct {
	SessionID      string
	InstallationID int64
	CanonicalRepo  string
	Repos          []InstallationRepo
	// CanonicalDefaultBranch is the default branch of CanonicalRepo, taken from
	// the installation's repo list. Empty when GitHub did not report one.
	CanonicalDefaultBranch string
	// ... unchanged fields
}
```

Immediately after `CreateProjectTx` at `:232`:

```go
	// PersistInstallation ran at :217, before this project existed, so its
	// branch fill could not match. Apply it here, in the same transaction.
	if in.CanonicalDefaultBranch != "" {
		if _, err := tx.Exec(ctx,
			`UPDATE projects SET default_branch = $2 WHERE id = $1`,
			project.ID, in.CanonicalDefaultBranch); err != nil {
			return nil, fmt.Errorf("set project default branch: %w", err)
		}
	}
```

In `agent_setup.go`, populate it from the matched repo — the loop that computes `canonical` around `:435` already has the `gh.Repo`.

**Step 5: Test and commit**

```bash
cd packages/ingestion && go build ./... && go test ./db ./handler
git add packages/ingestion/db/agent_provision.go packages/ingestion/handler/agent_setup.go packages/ingestion/db/agent_provision_test.go
git commit -m "fix(ingestion): agent-callback projects get their default branch

The project is created after PersistInstallation, so the branch fill there
could not reach it. Refs #180."
```

---

## Phase 5 — The settings door

### Task 15: Resolve and authorize in `SetGitHubConfig`

**Files:**
- Modify: `packages/ingestion/handler/github_settings.go:22-59`
- Modify: `packages/ingestion/db/queries.go:3198` (`SetProjectGitHubConfig`)
- Create: `packages/ingestion/handler/github_settings_test.go`

> This handler has **no test file today**. You are adding the first one, and it
> must include a regression test that an ordinary `main`-default repo still works.

**Step 1: Write the failing tests**

Use `gh.OverrideHTTPClientForTests` (`github/app.go:211`) to stub `ListInstallationRepos`:

```go
func TestSetGitHubConfigStoresMasterDefaultBranch(t *testing.T)      { /* 200; row == "master" */ }
func TestSetGitHubConfigRejectsRepoOutsideInstallation(t *testing.T) { /* 400; body names the repo */ }
func TestSetGitHubConfigReturns502WhenGitHubUnreachable(t *testing.T){ /* 502, not 500 */ }
func TestSetGitHubConfigStillAcceptsMainDefaultRepo(t *testing.T)    { /* REGRESSION: 200 */ }
```

**Step 2: Run to verify they fail**

```bash
cd packages/ingestion && go test ./handler -run SetGitHubConfig -v
```

**Step 3: Implement**

After the existing shape validation, resolve against the installation:

```go
	// Shape validation is not authorization. Until now this handler accepted any
	// owner/repo string without checking the org's App installation covers it.
	// The lookup we need for default_branch answers that question too.
	installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
	if err != nil || installationID == 0 {
		writeJSONError(w, http.StatusBadRequest, "GitHub App not installed for this organization")
		return
	}
	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	installToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "could not reach GitHub, please retry")
		return
	}
	repos, err := gh.ListInstallationRepos(installToken.Token)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "could not reach GitHub, please retry")
		return
	}
	var matched *gh.Repo
	for i := range repos {
		if repos[i].FullName == req.GithubRepo {
			matched = &repos[i]
			break
		}
	}
	if matched == nil {
		writeJSONError(w, http.StatusBadRequest,
			fmt.Sprintf("the Opslane GitHub App is not installed on %s — install it, then retry", req.GithubRepo))
		return
	}
```

Then pass `matched.DefaultBranch` through to `SetProjectGitHubConfig`, extending that query to write both columns.

> Phase 1 rule check: this is the dashboard settings handler. The App is already
> installed by the time it runs. Do **not** copy this into
> `onboard_provision.go` or `onboarding.go`.

**Step 4: Test and commit**

```bash
cd packages/ingestion && go build ./... && go test ./db ./handler
git add packages/ingestion/handler/github_settings.go packages/ingestion/handler/github_settings_test.go packages/ingestion/db/queries.go
git commit -m "feat(ingestion): resolve and authorize the repo in SetGitHubConfig

Stores the real default branch, and closes a gap where any owner/repo string
was accepted without checking the org's installation. Refs #180."
```

---

### Task 16: Regression — Phase 1 onboarding stays GitHub-free

**Files:**
- Modify: `packages/ingestion/handler/onboard_provision_test.go`

**Step 1: Write the test**

```go
// Onboarding Phase 1 is "Local aha (no GitHub)" — see
// docs/plans/2026-07-22-onboarding-10x-design.md:33. The project and its API
// key are minted before the GitHub App exists. This asserts the ABSENCE of a
// GitHub call, not merely that provisioning succeeds: an earlier draft of the
// #180 fix added an installation check here, which would have failed every CLI
// provision.
func TestOnboardProvisionMakesNoGitHubCall(t *testing.T) {
	called := false
	restore := gh.OverrideHTTPClientForTests(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			called = true
			return nil, fmt.Errorf("no GitHub call expected during Phase 1 provisioning")
		}),
	})
	defer restore()
	// act: POST /api/v1/onboard/provision
	// want: 201, project default_branch IS NULL, called == false
}
```

**Step 2: Run, then commit**

```bash
cd packages/ingestion && go test ./handler -run OnboardProvision -v
git add packages/ingestion/handler/onboard_provision_test.go
git commit -m "test(ingestion): Phase 1 provisioning makes no GitHub call

Guards the onboarding design boundary against a regression the #180 review
nearly introduced. Refs #180."
```

---

## Phase 6 — Prove it end to end

### Task 17: Full gate

**Step 1: Run everything**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Note: root `pnpm test` **excludes** `@opslane/test-e2e`. Run it explicitly:

```bash
pnpm --filter @opslane/test-e2e test
```

**Step 2: Live smoke against a master-default repo**

Per `AGENTS.md`, pipeline changes require a live smoke. Use a disposable database, not the shared 5434.

```bash
# apply migrations, seed, rebuild ingestion + worker, then:
curl -X POST http://localhost:8082/api/v1/events -H 'content-type: application/json' -d @test-fixtures/...
```

Confirm the job reaches its expected terminal state and that a setup PR opens against `master`.

**Step 3: Verification ledger**

Fill this in with real output. Do not mark a row proven from reading code.

| Claim | Proof | Result |
|---|---|---|
| Migration 027 allows NULL, preserves existing rows | Task 1 Step 3 psql output | |
| Empty repo classified `empty_repository` | `clone-resolution.test.ts` | |
| Broken-HEAD repo classified `invalid_default_branch`, names the branch | `clone-resolution.test.ts` | |
| Unpinned clone resolves `master` | `clone-resolution.test.ts` | |
| Setup PR bases on the resolved branch, not the row | `setup-pr.test.ts` | |
| Cache write never throws | `default-branch-cache.test.ts` | |
| Cache helper is actually called at 5 sites | `grep` output from Task 12 | |
| Stale `'main'` corrected on installation | `installations_default_branch_test.go` | |
| Agent-callback project gets `master` | `agent_provision_test.go` | |
| `SetGitHubConfig` rejects an uncovered repo | `github_settings_test.go` | |
| Phase 1 provisioning makes no GitHub call | `onboard_provision_test.go` | |
| Tokens never survive in a clone error | `clone-detail-redaction.test.ts` | |
| Setup PR opens against `master` end to end | live smoke | |

**Step 4: Update the design doc**

Mark the plan as implemented and link the PR.

---

## Acceptance criteria (issue #180)

| Criterion | Task |
|---|---|
| Configuring a `master` repo stores `default_branch = 'master'` | 13 (web install), 14 (agent callback), 15 (settings) |
| Setup PR succeeds end to end against a `master` repo | 6, 10, 17 |
| Stale row still clones successfully | 6 — the unpinned clone ignores the row entirely |
| Missing branch names the repo and the branch | 5 — the typed error; **not** git's stderr, which calls this case "empty" |
| Regression test covers a non-`main` default through the setup-PR path | 10, 17 |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | design-stage: 6 issues, 4 corrections |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 7 findings (4 P1, 3 P2), all verified + applied |

**CODEX:** Reviewed the implementation plan against the real code. All 7 findings confirmed by direct inspection and folded into the plan: (P1) sandbox resolution must run before the `.netrc` delete at `sandbox-repo.ts:140` or `ls-remote` fails auth on private repos; (P1) `index.ts` has 3 clone sites not 4, so cache write-back is 4 sites not 5; (P1) 6 existing test files reference the changed types and break the build; (P1) the `agent_provision.go:215` `[]string` fallback and `oauth_installation_test.go:33` fixture stop compiling after the `Repos` type change; (P2) `redactCloneDetail` in `sandbox-repo.ts` would create an import cycle with `repo-clone.ts`, moved to `redact.ts`; (P2) Task 9 must fix all 5 clone-catch sites, not 2.

**CROSS-MODEL:** No contested findings. Codex's `.netrc` and import-cycle catches were both missed by the design review and this author; both verified empirically before applying.

**VERDICT:** ENG + CODEX CLEARED — plan is implementation-ready. The verification ledger in Task 17 must be filled with real output during execution, not marked from reading.

NO UNRESOLVED DECISIONS
