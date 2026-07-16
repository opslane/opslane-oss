---
name: docs-sync
description: Maps current-branch code changes to covered prose docs and updates only stale prose in isolated Claude sessions. Use before opening a PR, after changing documented behavior, or when the user invokes `/docs-sync`.
---

# docs-sync

Run from anywhere in the repository:

```bash
node "$(git rev-parse --show-toplevel)/.claude/skills/docs-sync/scripts/run.mjs"
```

Use `--dry-run` to resolve the base and print mapper results without starting Claude or editing files.

The runner performs this deterministic workflow:

1. Resolve the `@{upstream}` merge-base candidate, then validate it against the upstream default branch. Prefer `refs/remotes/origin/HEAD`, then `origin/main`; use the upstream candidate only when neither default-branch ref is available. This prevents a pushed feature branch from making `BASE=HEAD` and hiding committed PR changes.
2. Build a rename-aware, deduplicated path set from all local work:
   - `git diff --name-status -z --find-renames "$BASE" -- .` for committed and tracked working-tree changes.
   - `git diff --name-status -z --find-renames --cached "$BASE" -- .` for staged changes.
   - `git ls-files -z --others --exclude-standard` for untracked files.
3. Pipe those paths into `node scripts/docs-map.mjs` and use its `matched` and `uncovered` output. Do not infer additional docs.
4. Process each matched doc sequentially, passing only that document and its relevant code diff through standard input. Include matched untracked-file contents as added-file context because Git diff omits them.
5. Start a fresh headless Claude session for each doc with **all built-in tools disabled**, MCP disabled, and settings/customizations disabled. Require a schema-validated response containing the complete resulting Markdown. This prevents the model from reading the repository, environment, or version control.
6. Deterministically write only the matched target doc when the returned content changed. The runner never stages, commits, or pushes.
7. Report changed docs, unchanged docs, and mapper-reported uncovered code paths. Do not edit docs for uncovered paths.

Review the resulting working-tree diff and commit the docs with the code change.
