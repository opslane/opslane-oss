# Docs-sync — keep prose docs from drifting from code

**Date:** 2026-07-16
**Status:** Proposed — revised after security review (2026-07-16)
**Goal:** When a PR changes behavior, the docs that describe that behavior get updated too — automatically proposed, human-reviewed. A semantic layer on top of the existing deterministic drift gate, modeled on promptless.ai.

## What already exists (and what it can't do)

`scripts/check-docs-drift.mjs` is a deterministic gate, wired into `pnpm test` (the `js` CI job). It catches **structural** drift between code and the `reference/` tier: HTTP routes, env vars, SDK options, reason codes, and `llms.txt` links. It fails the build when a reference table disagrees with code.

It cannot catch **semantic** drift — a guide, architecture doc, or overview whose *prose* goes stale when behavior changes. That is the gap this design fills.

## Security model (read first)

Two security reviews reshaped this design. Four rules are non-negotiable (see the implementation plan for how each is enforced):

1. **Trusted code, untrusted data.** Every executed script comes from the **base/default branch**. The PR head is read only as git blobs (its diff and doc contents) — never executed. No `pnpm install` of PR packages, no running PR scripts. This closes the "privileged job runs PR-controlled code with the secret" path.

2. **The LLM has no filesystem or version-control tools.** One matched doc plus its diff slice is passed over stdin to a fresh Claude process with all built-in tools disabled, MCP/settings disabled, and schema-validated output. `--allowed-tools` alone is *not* a sandbox — it only pre-approves. Trusted code performs every filesystem mutation deterministically. Three gates run before any push: (a) allowlist — every edited path ∈ matched docs; (b) secret scan — reject if an edited doc contains the OAuth token or a secret pattern; (c) guarded `--force-with-lease` push pinned to the recorded head SHA.

3. **Split privilege across two jobs.** A `plan` job holds `CLAUDE_CODE_OAUTH_TOKEN` with `contents: read` only. A separate `publish` job holds `contents: write` with no Claude token. They communicate via an artifact.

4. **The Action is internal-only.** `pull_request` from a fork gets a read-only token and **no** repository secrets, so the write path cannot run. We do **not** work around this with `pull_request_target` — [GitHub warns](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target) that checking out untrusted PR code under that trigger is a privileged-code path. The Action skips fork PRs explicitly. External-contributor docs are handled by a maintainer running the local `/docs-sync` skill.

## Scope decisions

- **Prose tier only, one canonical predicate.** A single exported `isProseTierDoc(path)` (in `scripts/docs-map.mjs`) defines the tier and is imported by the mapper, the lint, and the workflow — no three-way drift. v1 tier: `docs/guides/**`, `docs/architecture/**`, `docs/quickstart/**`, and `docs/install.md`. Excluded: `reference/` (already deterministic), `contracts/`, `agents/`, and `docs/plans/`.
- **Two entry points, one engine.** A local `/docs-sync` skill (fast path while coding) and a PR GitHub Action (internal safety net). Both run **Claude Code with all built-in tools disabled** and accept only schema-validated document output; all filesystem and VCS operations are deterministic.
- **Subscription auth, no API billing.** Same token style as `asset-management-jira`: local CLI uses the local session; the Action passes `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) to a headless Claude run. No metered `ANTHROPIC_API_KEY`.
- **PR behavior: commit onto the source branch.** The Action commits the doc updates directly to the code PR's own branch (`docs: sync for #<PR#>`), so docs and code review and merge together and the update can't be silently dropped. This was chosen over a companion PR because a companion targeting the code branch does not *guarantee* landing — a maintainer can merge the source first. Internal-only scope makes committing to the branch safe. Trade-off: the code PR's diff now includes the doc changes.
- **Deterministic scoping via `covers:` frontmatter.** Each prose doc declares the code globs it documents; Claude only sees docs whose globs match the PR's changed files.

## Component 1 — `covers:` frontmatter

```yaml
---
title: React guide
covers:
  - packages/sdk/src/react.tsx
  - packages/sdk/vite-plugin/**
---
```

- Every prose-tier doc must declare a non-empty `covers:` (enforced by lint, Component 6).
- The `reference/` tier is intentionally **not** tagged.

## Component 2 — `scripts/docs-map.mjs` (deterministic, no LLM)

Pure function, unit-tested against fixtures — same discipline as `check-docs-drift.mjs`.

- Exports `isProseTierDoc(path)` — the one canonical scope predicate.
- Reads every prose-tier doc, collects `covers:` globs into a `glob → doc` index.
- Takes changed file paths on stdin (from a **resolved** diff, see below). Handles renames and deletions: a deleted/renamed code path still maps to its docs so stale references get caught; a deleted doc is dropped from the index.
- Rejects malformed frontmatter loudly (parse error → non-zero exit, not silent skip). Overlapping globs are fine — a changed path may map to several docs; the union is returned.
- Prints two lists: `matched:` (docs to consider) and `uncovered:` (changed **code** paths — not tests/config — matching no doc).
- No git calls inside the script; the caller supplies paths, so it is testable in isolation.

## Component 3 — the reasoning step (per-document, deterministic loop)

The workflow (and the skill) run a **deterministic loop**: for each matched doc, invoke a **separate** headless Claude session scoped to that one document plus the relevant diff slices. Isolation is enforced by the loop, not by a prompt claim, so a bad edit to one doc cannot affect another. (We do not claim a temperature setting — the CLI does not expose one; determinism comes from single-doc scoping and output validation, not sampling.)

Per-doc prompt, in essence:

> Here is one document and the slices of this PR's diff that touch code it covers. Update **only** what the change made stale. If nothing is stale, make no edit. Never invent features or document behavior absent from the diff. You may edit only this file.

Claude receives the document and diff through stdin with **no built-in tools** and returns the complete document through a JSON schema. It cannot read the runner filesystem, environment, git repository, or `gh`; the trusted driver alone decides whether to write the returned content.

## Component 4 — local `/docs-sync` skill

- Resolves the merge base against the upstream default branch (`git merge-base @{upstream} HEAD`, falling back to `origin/main`), then diffs **committed + staged + working-tree** changes against it — so work-in-progress is included, not silently excluded.
- Runs the Component 3 loop in the local session, editing matched docs in the working tree. You review and commit alongside the code.
- Uses the local subscription session — no token setup.

## Component 5 — PR Action (`.github/workflows/docs-sync.yml`)

Two jobs, split by privilege (security rule #3). Concurrency is per-PR with `cancel-in-progress`.

**`plan` job** — `contents: read` only, holds `CLAUDE_CODE_OAUTH_TOKEN`:

1. Check out the **base/default branch** (trusted scripts). `persist-credentials: false`.
2. Fetch the PR head `head.sha` as data (`git fetch`), never checked out for execution. No `pnpm install`.
3. Compute changed paths with `git diff --name-status -z --find-renames base...head` (three-dot = merge-base; rename-aware), map via `docs-map.mjs`. Docs-only PR ⇒ skip.
4. For each matched doc: pass that doc (its `head` contents, as data) + its diff slice over stdin to a fresh Claude process; disable all built-in tools, MCP, and settings, and require schema-validated full-document output.
5. Upload the edited docs + `map.json` as an artifact.

**`publish` job** — `contents: write`, **no** Claude token, needs `plan`:

6. Download the artifact. If none, nothing to do.
7. **Gate 1 (allowlist):** every edited path ∈ `map.json` matched set, else abort.
8. **Gate 2 (secret scan):** reject if any edited doc contains the OAuth token or a secret pattern.
9. Check out the **source PR head branch** with write creds (git-only; no PR code executed). Copy edited docs in. If `git status` is clean ⇒ exit 0 (idempotent).
10. Commit `docs: sync for #<PR#>`; **guarded push** (`--force-with-lease` pinned to `head.sha`, fails if the branch advanced) to the source branch.

Guards (job-level `if`), all required: skip forks (`head.repo.fork == false`); skip our own bot commits (`head.ref` not `claude/*`, latest message not `docs: sync for #`); skip docs-only PRs.

All third-party Actions are **pinned to a full 40-char commit SHA** with the release tag in a trailing comment — `scripts/check-action-pins.mjs` fails the build otherwise. The Claude CLI is pinned by npm version.

### Landing model (resolves the ancestry question)

The Action commits doc edits **directly onto the source PR's branch**, so there is no companion branch to reconcile — docs and code are one PR, reviewed and merged together, and cannot be dropped. Re-runs are idempotent: identical edits already on the branch produce no new commit (gate at step 9). Note: a commit pushed with the default `GITHUB_TOKEN` does not re-trigger PR checks; if the docs commit must re-run CI, `publish` uses a GitHub App token instead (documented in the plan).

## Component 6 — coverage lint

Extend the `pnpm test` gate (in `check-docs-drift.mjs` or a sibling using the shared `isProseTierDoc`): every prose-tier doc must declare a non-empty `covers:`. Stops new prose docs from silently escaping the map. An allowlist (mirroring the drift script's `KNOWN_DRIFT` pattern) can exempt a doc that legitimately covers nothing yet.

## Prerequisites / setup

- `claude setup-token` → repo secret `CLAUDE_CODE_OAUTH_TOKEN`.
- Confirm branch protection allows the Action to push to PR branches (the `publish` job commits `docs: sync for #<PR#>`).
- If the docs commit must re-run required checks, provision a GitHub App token for the `publish` push (default `GITHUB_TOKEN` pushes don't re-trigger workflows).
- Resolve and pin the runtime Action/CLI SHA/version.

## Verification

Deterministic layer (`docs-map.mjs`, lint) — unit tests, no LLM:

- Matched/uncovered sets correct for a fixture diff; `**` globs resolve; empty diff → empty match.
- **Malformed frontmatter** → loud failure, not silent skip.
- **Overlapping globs** → union of docs, no duplicates.
- **Renamed / deleted** code paths still map to their docs; deleted docs drop from the index.
- **Invalid / non-existent** paths handled without crashing.
- Lint fails when a prose-tier doc omits `covers:`; passes when all present; canonical predicate is the only definition of "prose tier".

Workflow layer:

- **Guards:** dry-run the `if` against a `claude/*` head, a bot `docs: sync for #` commit, a fork PR, and a docs-only PR — all skip.
- **Allowlist gate:** a Claude run that edits a non-matched file is rejected before any push.
- **Secret-scan gate:** an edited doc containing the OAuth token / a secret pattern is rejected before any push.
- **Concurrency:** two rapid `synchronize` events — the older run cancels; the pushed commit reflects the newer `head.sha`; the guarded push fails rather than clobber a moved branch.
- **Idempotency:** identical edits already on the branch produce no new commit.
- **End-to-end:** a PR changing `packages/sdk/src/react.tsx` yields a `docs: sync for #<PR#>` commit on the same branch editing only `guides/react.md`; a docs-only PR produces no run.
- **Injection drill:** a diff that instructs the model to write the OAuth token into a doc cannot access that token because the model has no tools or secret-bearing context; the secret scan still rejects an exact or token-shaped leak before push.

## Open questions

- Should `docs/contracts/**` eventually join the prose tier, or stay contract-reviewed by hand?
- Advisory "uncovered code" comment: always-on, or gated by a per-path allowlist so intentionally undocumented code stays quiet?
