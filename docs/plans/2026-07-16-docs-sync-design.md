# Docs-sync — keep prose docs from drifting from code

**Date:** 2026-07-16
**Status:** Proposed
**Goal:** When a PR changes behavior, the docs that describe that behavior get updated too — automatically proposed, human-reviewed. A semantic layer on top of the existing deterministic drift gate, modeled on promptless.ai.

## What already exists (and what it can't do)

`scripts/check-docs-drift.mjs` is a deterministic gate, wired into `pnpm test` (the `js` CI job). It catches **structural** drift between code and the `reference/` tier: HTTP routes, env vars, SDK options, reason codes, and `llms.txt` links. It fails the build when a reference table disagrees with code.

It cannot catch **semantic** drift — a guide, architecture doc, or overview whose *prose* goes stale when behavior changes. Nothing today notices that the React setup steps no longer match the SDK. That is the gap this design fills.

## Scope decisions

- **Prose tier only.** `covers:`-based sync applies to `docs/guides/**`, `docs/architecture/**`, and top-level narrative docs (`docs/install.md`). The `reference/` tier stays with `check-docs-drift.mjs` — it is already deterministic and exact.
- **Two entry points, one engine.** A local `/docs-sync` skill (fast path while coding) and a PR GitHub Action (safety net). Both run **Claude Code** as the reasoning step, so there is one prompt and one mapping helper to maintain.
- **Subscription auth, no API billing.** Both paths authenticate the same way as `asset-management-jira`: the local CLI uses the local session; the Action uses `anthropics/claude-code-action@v1` with `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` (from `claude setup-token`). No metered `ANTHROPIC_API_KEY`.
- **PR behavior: companion docs PR.** The Action never edits the code PR and never blocks CI. It opens a separate `claude/docs-sync-<PR#>` PR with concrete doc edits, linked back to the source PR. Keeps code review clean; docs get their own review.
- **Deterministic scoping via `covers:` frontmatter.** Each prose doc declares the code globs it documents. The LLM only reads/edits docs whose globs match the PR's changed files. Cheapest per PR, self-documenting, and it can't wander into unrelated files.

## Component 1 — `covers:` frontmatter

Each prose doc declares the code it describes:

```yaml
---
title: React guide
covers:
  - packages/sdk/src/react/**
  - packages/sdk/vite-plugin/**
---
```

- Only the prose tier is tagged (~a dozen files, tagged once).
- The `reference/` tier is intentionally **not** tagged.

## Component 2 — `scripts/docs-map.mjs` (deterministic, no LLM)

Pure function, unit-tested against a fixture diff — same discipline as `check-docs-drift.mjs`.

- Reads every `docs/**/*.md`, collects `covers:` globs into a `glob → doc` index.
- Takes the PR's changed file paths on stdin.
- Prints two lists: `matched:` (docs to consider updating) and `uncovered:` (changed **code** paths — not tests/config — that matched no doc).
- No git calls inside the script; the diff/paths are passed in, so it is testable in isolation.

## Component 3 — the shared prompt

Both wrappers feed Claude Code the same instruction:

> Run `scripts/docs-map.mjs` on this PR's changed files. For each **matched** doc: read it and the relevant diff slices, and update **only** what the code change made stale. If nothing is stale, leave the doc untouched. Never invent features or document behavior not in the diff. If there are **uncovered** code paths, note them — do not edit anything for them.

One doc at a time, low temperature, so a bad suggestion on one doc can't corrupt another.

## Component 4 — local `/docs-sync` skill

- Runs `git diff main...HEAD`, feeds the diff + prompt to the local Claude Code session.
- Edits affected docs in the current branch. You review and commit alongside the code.
- Uses the local subscription session — no token setup.

## Component 5 — PR Action (`.github/workflows/docs-sync.yml`)

Modeled on `asset-management-jira`'s `claude-code-review.yml`, with raised permissions and skip guards.

```yaml
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: write        # push claude/docs-sync-<PR#>
  pull-requests: write   # open the companion PR
  id-token: write
```

- Uses `anthropics/claude-code-action@v1` with `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.
- `claude_args` allow-list adds `Edit`, `Bash(git ...)`, and `Bash(gh pr create:*)` on top of the read-only `gh` tools.
- On changes: pushes `claude/docs-sync-<PR#>` and opens a companion PR whose body links `Docs for #<PR#>`. If that branch already exists (a later push to the source PR), it updates it instead of opening a second PR — idempotent.
- On no changes: no PR, optionally a one-line status.
- If `docs-map.mjs` reports `uncovered:` code paths, the Action drops a one-line advisory comment on the source PR ("these files aren't covered by any doc — intended?") so missing coverage surfaces instead of rotting.

### Recursion guards (required)

The companion PR is itself a `pull_request`, so the workflow must skip:

1. When `head_ref` starts with `claude/docs-sync-`.
2. When the PR's changed files are **only** under `docs/` (no code to sync from).

## Component 6 — coverage lint

Extend `check-docs-drift.mjs` (or a sibling check in the same `pnpm test` gate): every doc under `guides/` and `architecture/` **must** declare a non-empty `covers:`. Stops new prose docs from silently escaping the map.

## Prerequisites / setup

- `claude setup-token` → store as repo secret `CLAUDE_CODE_OAUTH_TOKEN` (same token style as `asset-management-jira`).
- Confirm the org allows a GitHub Action to open PRs (Settings → Actions → Workflow permissions).

## Verification

- `docs-map.mjs`: unit tests over a fixture diff — matched set correct, uncovered set correct, globs with `**` resolve, empty diff → empty match.
- Coverage lint: fails when a `guides/` doc omits `covers:`; passes when all present.
- Recursion guards: dry-run the workflow condition against a `claude/docs-sync-*` head and a docs-only PR — both skip.
- End-to-end: open a test PR that changes `packages/sdk/src/react/**`, confirm a companion PR appears editing `guides/react.md` and nothing else; open a docs-only PR and confirm no run.

## Open questions

- Which top-level narrative docs beyond `install.md` join the prose tier (e.g. `architecture/overview.md`, `architecture/life-of-an-error.md`)? All three architecture docs are strong candidates.
- Should the advisory "uncovered code" comment be opt-in per-path (some code legitimately has no doc), maybe via an allowlist mirroring the drift script's `KNOWN_DRIFT` pattern?
