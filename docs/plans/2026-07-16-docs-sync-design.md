# Docs-sync — keep prose docs from drifting from code

**Date:** 2026-07-16
**Status:** Proposed — revised after security review (2026-07-16)
**Goal:** When a PR changes behavior, the docs that describe that behavior get updated too — automatically proposed, human-reviewed. A semantic layer on top of the existing deterministic drift gate, modeled on promptless.ai.

## What already exists (and what it can't do)

`scripts/check-docs-drift.mjs` is a deterministic gate, wired into `pnpm test` (the `js` CI job). It catches **structural** drift between code and the `reference/` tier: HTTP routes, env vars, SDK options, reason codes, and `llms.txt` links. It fails the build when a reference table disagrees with code.

It cannot catch **semantic** drift — a guide, architecture doc, or overview whose *prose* goes stale when behavior changes. That is the gap this design fills.

## Security model (read first)

The security review reshaped this design. Two rules are non-negotiable:

1. **The LLM never touches version control.** Claude receives only the matched documents and diff slices, and may only edit files. Every mutation — running the mapper, pushing a branch, opening/updating a PR, posting a comment — happens in **deterministic workflow steps**. After Claude edits, a deterministic step rejects the run unless *every* changed path is in the matched-doc allowlist. This closes the prompt-injection path: PR-controlled content can influence at most the text inside an already-allowlisted doc, never branch creation, arbitrary files, or `gh` commands. (Anthropic's own [Claude Action security guidance](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) warns about PR-content injection.)

2. **The Action is internal-only.** `pull_request` from a fork gets a read-only token and **no** repository secrets, so `CLAUDE_CODE_OAUTH_TOKEN` is absent and the write path cannot run. We do **not** work around this with `pull_request_target` — [GitHub warns](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target) that checking out untrusted PR code under that trigger is a privileged-code path. The Action therefore skips fork PRs explicitly and is documented as covering trusted same-repo contributors only. External-contributor docs are handled by a maintainer running the local `/docs-sync` skill on the PR branch, or re-pushing the branch from within the repo.

## Scope decisions

- **Prose tier only, one canonical predicate.** A single exported `isProseTierDoc(path)` (in `scripts/docs-map.mjs`) defines the tier and is imported by the mapper, the lint, and the workflow — no three-way drift. v1 tier: `docs/guides/**`, `docs/architecture/**`, `docs/quickstart/**`, and `docs/install.md`. Excluded: `reference/` (already deterministic), `contracts/`, `agents/`, and `docs/plans/`.
- **Two entry points, one engine.** A local `/docs-sync` skill (fast path while coding) and a PR GitHub Action (internal safety net). Both run **Claude Code restricted to Read/Edit**; all VCS is deterministic.
- **Subscription auth, no API billing.** Same token style as `asset-management-jira`: local CLI uses the local session; the Action passes `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) to a headless Claude run. No metered `ANTHROPIC_API_KEY`.
- **PR behavior: companion docs PR, non-blocking.** The Action never edits the code PR and never fails CI. It opens a separate `claude/docs-sync-<PR#>` PR, linked to the source PR.
- **Deterministic scoping via `covers:` frontmatter.** Each prose doc declares the code globs it documents; Claude only sees docs whose globs match the PR's changed files.

## Component 1 — `covers:` frontmatter

```yaml
---
title: React guide
covers:
  - packages/sdk/src/react/**
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

Claude's allowed tools are `Read` and `Edit` on the single target file — no `Bash`, no `git`, no `gh`.

## Component 4 — local `/docs-sync` skill

- Resolves the merge base against the upstream default branch (`git merge-base @{upstream} HEAD`, falling back to `origin/main`), then diffs **committed + staged + working-tree** changes against it — so work-in-progress is included, not silently excluded.
- Runs the Component 3 loop in the local session, editing matched docs in the working tree. You review and commit alongside the code.
- Uses the local subscription session — no token setup.

## Component 5 — PR Action (`.github/workflows/docs-sync.yml`)

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write        # push claude/docs-sync-<PR#>
  pull-requests: write   # open/update the companion PR
  id-token: write

concurrency:
  group: docs-sync-${{ github.event.pull_request.number }}
  cancel-in-progress: true   # a newer push supersedes an in-flight run
```

Guards (job-level `if`), all required:

- Skip forks: `github.event.pull_request.head.repo.fork == false`.
- Skip the companion branch: head ref does **not** start with `claude/docs-sync-`.
- Skip docs-only PRs: if the changed set is entirely under `docs/`, there is no code to sync from.

Deterministic steps (Claude appears only in the middle, tool-restricted):

1. Check out the **source PR head at a pinned `head.sha`** (all later steps use that SHA, so a race can't mix trees).
2. Compute changed paths vs. the PR base; run `docs-map.mjs`.
3. If `uncovered:` code paths exist, post a one-line advisory comment on the source PR. (No edits for them.)
4. For each matched doc, run the Component 3 headless Claude session (Read/Edit on that file only).
5. **Validate:** `git status --porcelain` must show only files in the matched-doc allowlist; otherwise abort, open no PR, and log the rejected paths.
6. If there are edits, force-update branch `claude/docs-sync-<PR#>` from the validated tree with a guarded push (fail if the remote branch moved unexpectedly) and open or update the companion PR. Body links `Docs for #<PR#>`.

All third-party Actions (including `anthropics/claude-code-action` if used to supply the runtime, or a direct `npx` invocation) are **pinned to a full 40-char commit SHA** with the release tag in a trailing comment — `scripts/check-action-pins.mjs` fails the build otherwise.

### Companion branch lifecycle (resolves the ancestry question)

**Recommended model — docs PR targets the code branch:**

- Base of `claude/docs-sync-<PR#>` = the **source PR head SHA**. Target branch = the **source PR's own branch**.
- The companion contains **only doc commits** (validated in step 5), so reviewing it shows just the doc delta even though it sits on top of the code.
- Merging it lands the docs **into the code branch**, so docs and code reach `main` together via the original PR — docs can never merge ahead of the behavior they describe.
- On a new push to the source PR: the run rebuilds the branch from the new `head.sha` (force-update), keeping docs current with the latest code.
- On source PR **merge or close**: the companion PR is closed and its branch deleted by a cleanup step (`on: pull_request: [closed]`), since its target no longer exists.

Alternative (target `main`, mark draft, label "merge-with-#X") is viable but pushes merge-ordering onto humans; the recommended model enforces ordering structurally. **This is the one choice to confirm before implementation.**

## Component 6 — coverage lint

Extend the `pnpm test` gate (in `check-docs-drift.mjs` or a sibling using the shared `isProseTierDoc`): every prose-tier doc must declare a non-empty `covers:`. Stops new prose docs from silently escaping the map. An allowlist (mirroring the drift script's `KNOWN_DRIFT` pattern) can exempt a doc that legitimately covers nothing yet.

## Prerequisites / setup

- `claude setup-token` → repo secret `CLAUDE_CODE_OAUTH_TOKEN`.
- Settings → Actions → Workflow permissions: allow Actions to create and approve pull requests.
- Resolve and pin the runtime Action/CLI SHA.

## Verification

Deterministic layer (`docs-map.mjs`, lint) — unit tests, no LLM:

- Matched/uncovered sets correct for a fixture diff; `**` globs resolve; empty diff → empty match.
- **Malformed frontmatter** → loud failure, not silent skip.
- **Overlapping globs** → union of docs, no duplicates.
- **Renamed / deleted** code paths still map to their docs; deleted docs drop from the index.
- **Invalid / non-existent** paths handled without crashing.
- Lint fails when a prose-tier doc omits `covers:`; passes when all present; canonical predicate is the only definition of "prose tier".

Workflow layer:

- **Recursion guards:** dry-run the `if` against a `claude/docs-sync-*` head, a fork PR, and a docs-only PR — all three skip.
- **Output enforcement:** a Claude run that edits a non-matched file is rejected by step 5 and opens no PR.
- **Concurrency:** two rapid `synchronize` events — the older run cancels; the branch reflects the newer `head.sha`.
- **Lifecycle:** reopened PR re-runs; merged/closed source PR triggers companion cleanup; a stale companion branch is force-updated, not duplicated.
- **End-to-end:** a PR changing `packages/sdk/src/react/**` yields a companion PR editing `guides/react.md` and nothing else; a docs-only PR produces no run.

## Open questions

- **Confirm the companion branch model** (target the code branch, per above) vs. the target-`main`-draft alternative.
- Should `docs/contracts/**` eventually join the prose tier, or stay contract-reviewed by hand?
- Advisory "uncovered code" comment: always-on, or gated by a per-path allowlist so intentionally undocumented code stays quiet?
