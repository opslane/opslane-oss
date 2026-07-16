# Docs-sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically keep prose docs (`guides/`, `architecture/`, `quickstart/`, `install.md`) in sync with code changes — via a deterministic file→doc mapper plus a Claude reasoning step that edits only the matched docs — exposed as a local `/docs-sync` skill and an internal-only PR GitHub Action that opens a companion docs PR.

**Architecture:** A pure, dependency-free Node script (`scripts/docs-map.mjs`) maps a PR's changed files to the docs that declare them in `covers:` frontmatter. The LLM never touches version control: it is handed one matched doc + relevant diff slices and may only edit that file; deterministic workflow steps run the mapper, validate the changed-file allowlist, push the branch, and open the companion PR. The companion PR targets the source PR's own branch so docs land with the code. Design doc: `docs/plans/2026-07-16-docs-sync-design.md`.

**Tech Stack:** Node 22 ESM `.mjs` scripts, `node:test` + `node:assert` (no new deps — matches the existing `scripts/check-*.mjs` convention), GitHub Actions, Claude Code headless CLI authenticated by `CLAUDE_CODE_OAUTH_TOKEN`.

**Conventions to honor:**
- Scripts are dependency-free `.mjs` run with `node`, mirroring `scripts/check-docs-drift.mjs`.
- `pnpm test` (root `package.json`) is the gate: it runs `node scripts/check-docs-drift.mjs && pnpm -r ... test`. New deterministic checks wire in here.
- Third-party workflow `uses:` must be 40-char SHA-pinned or `scripts/check-action-pins.mjs` fails CI.
- Commit after every green step. TDD for the deterministic layer.

---

## Phase A — Deterministic engine (`scripts/docs-map.mjs`)

This phase is fully TDD-able and has no LLM. Build it first and trust it.

### Task A1: Scope predicate `isProseTierDoc`

**Files:**
- Create: `scripts/docs-map.mjs`
- Create: `scripts/__tests__/docs-map.test.mjs`

**Step 1: Write the failing test**

```js
// scripts/__tests__/docs-map.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProseTierDoc } from '../docs-map.mjs';

test('isProseTierDoc: prose tiers included', () => {
  assert.equal(isProseTierDoc('docs/guides/react.md'), true);
  assert.equal(isProseTierDoc('docs/architecture/overview.md'), true);
  assert.equal(isProseTierDoc('docs/quickstart/self-host.md'), true);
  assert.equal(isProseTierDoc('docs/install.md'), true);
  assert.equal(isProseTierDoc('./docs/guides/vue.md'), true); // leading ./ tolerated
});

test('isProseTierDoc: excluded tiers', () => {
  assert.equal(isProseTierDoc('docs/reference/http-routes.md'), false);
  assert.equal(isProseTierDoc('docs/contracts/reliability.md'), false);
  assert.equal(isProseTierDoc('docs/agents/domain.md'), false);
  assert.equal(isProseTierDoc('docs/plans/x.md'), false);
  assert.equal(isProseTierDoc('packages/sdk/src/index.ts'), false);
  assert.equal(isProseTierDoc('docs/guides/react.txt'), false); // non-md
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: FAIL — `isProseTierDoc` is not exported / module not found.

**Step 3: Write minimal implementation**

```js
// scripts/docs-map.mjs
// Maps a PR's changed files to the prose docs that declare them in `covers:`
// frontmatter. Pure + dependency-free, like scripts/check-docs-drift.mjs.
// No git calls: the caller passes changed paths on stdin.

const stripDot = (p) => p.replace(/^\.\//, '');

export function isProseTierDoc(p) {
  const rel = stripDot(p);
  if (!rel.endsWith('.md')) return false;
  if (rel === 'docs/install.md') return true;
  return /^docs\/(guides|architecture|quickstart)\//.test(rel);
}
```

**Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add scripts/docs-map.mjs scripts/__tests__/docs-map.test.mjs
git commit -m "feat(docs-sync): add isProseTierDoc scope predicate"
```

---

### Task A2: Strict frontmatter reader `readCovers`

Malformed frontmatter must fail loudly (design §Component 2), never silently skip.

**Files:**
- Modify: `scripts/docs-map.mjs`
- Modify: `scripts/__tests__/docs-map.test.mjs`

**Step 1: Write the failing test**

```js
import { readCovers } from '../docs-map.mjs';

test('readCovers: parses a covers list', () => {
  const src = [
    '---',
    'title: React guide',
    'covers:',
    '  - packages/sdk/src/react/**',
    '  - packages/sdk/vite-plugin/**',
    '---',
    '# React setup',
  ].join('\n');
  assert.deepEqual(readCovers(src), [
    'packages/sdk/src/react/**',
    'packages/sdk/vite-plugin/**',
  ]);
});

test('readCovers: no frontmatter returns empty', () => {
  assert.deepEqual(readCovers('# Just a heading\n'), []);
});

test('readCovers: unterminated frontmatter throws', () => {
  assert.throws(() => readCovers('---\ncovers:\n  - a/**\n'), /unterminated frontmatter/i);
});

test('readCovers: covers present but empty throws', () => {
  const src = '---\ntitle: x\ncovers:\n---\n# h';
  assert.throws(() => readCovers(src), /empty covers/i);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: FAIL — `readCovers` not exported.

**Step 3: Write minimal implementation** (append to `docs-map.mjs`)

```js
// Reads the `covers:` YAML list from a doc's frontmatter. Strict: a doc that
// opens with `---` but never closes it, or declares `covers:` with no items,
// throws rather than silently yielding [].
export function readCovers(src) {
  if (!src.startsWith('---\n')) return [];
  const end = src.indexOf('\n---', 4);
  if (end === -1) throw new Error('unterminated frontmatter');
  const block = src.slice(4, end);
  const lines = block.split('\n');
  const idx = lines.findIndex((l) => /^covers:\s*$/.test(l));
  if (idx === -1) return [];
  const items = [];
  for (const l of lines.slice(idx + 1)) {
    const m = l.match(/^\s+-\s+(.+?)\s*$/);
    if (!m) break; // list ends at first non-item line
    items.push(m[1].replace(/^["']|["']$/g, ''));
  }
  if (items.length === 0) throw new Error('empty covers list');
  return items;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/docs-map.mjs scripts/__tests__/docs-map.test.mjs
git commit -m "feat(docs-sync): add strict covers frontmatter reader"
```

---

### Task A3: Glob matcher `globToRegExp`

**Files:**
- Modify: `scripts/docs-map.mjs`
- Modify: `scripts/__tests__/docs-map.test.mjs`

**Step 1: Write the failing test**

```js
import { globToRegExp } from '../docs-map.mjs';

test('globToRegExp: ** matches across slashes', () => {
  const re = globToRegExp('packages/sdk/src/react/**');
  assert.equal(re.test('packages/sdk/src/react/index.tsx'), true);
  assert.equal(re.test('packages/sdk/src/react/hooks/use.ts'), true);
  assert.equal(re.test('packages/sdk/src/vue/index.ts'), false);
});

test('globToRegExp: single * stays within a segment', () => {
  const re = globToRegExp('packages/*/package.json');
  assert.equal(re.test('packages/sdk/package.json'), true);
  assert.equal(re.test('packages/sdk/src/package.json'), false);
});

test('globToRegExp: escapes regex metachars', () => {
  const re = globToRegExp('a.b/c+d/**');
  assert.equal(re.test('a.b/c+d/x'), true);
  assert.equal(re.test('aXb/cXd/x'), false);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: FAIL — `globToRegExp` not exported.

**Step 3: Write minimal implementation** (append to `docs-map.mjs`)

```js
// Converts a doc glob to an anchored RegExp. `**` spans path separators;
// a single `*` stays within one segment. All other regex metachars escaped.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1; // absorb the slash after **
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}
```

**Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/docs-map.mjs scripts/__tests__/docs-map.test.mjs
git commit -m "feat(docs-sync): add glob-to-regexp matcher"
```

---

### Task A4: Core mapper `mapChangedPaths` (union, uncovered, deletes/renames)

**Files:**
- Modify: `scripts/docs-map.mjs`
- Modify: `scripts/__tests__/docs-map.test.mjs`

**Step 1: Write the failing test** — use an injectable doc set so the test needs no real files.

```js
import { mapChangedPaths } from '../docs-map.mjs';

// docsIndex: array of { path, covers }
const DOCS = [
  { path: 'docs/guides/react.md', covers: ['packages/sdk/src/react/**'] },
  { path: 'docs/guides/vue.md', covers: ['packages/sdk/src/vue/**'] },
  { path: 'docs/architecture/overview.md', covers: ['packages/sdk/src/react/**', 'packages/worker/**'] },
];

test('mapChangedPaths: union across overlapping globs, deduped', () => {
  const r = mapChangedPaths(['packages/sdk/src/react/boundary.tsx'], DOCS);
  assert.deepEqual(r.matched.sort(), ['docs/architecture/overview.md', 'docs/guides/react.md']);
  assert.deepEqual(r.uncovered, []);
});

test('mapChangedPaths: uncovered lists code paths matching no doc', () => {
  const r = mapChangedPaths(['packages/ingestion/handler/routes.go'], DOCS);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.uncovered, ['packages/ingestion/handler/routes.go']);
});

test('mapChangedPaths: tests and config are never "uncovered" noise', () => {
  const r = mapChangedPaths(
    ['packages/sdk/src/react/x.test.ts', 'package.json', 'docs/guides/react.md'],
    DOCS,
  );
  assert.deepEqual(r.matched, []); // a test file covers nothing; the doc itself is not "code"
  assert.deepEqual(r.uncovered, []); // test + config + doc are all excluded from uncovered
});

test('mapChangedPaths: a deleted covered code path still maps to its doc', () => {
  const r = mapChangedPaths(['packages/sdk/src/react/old.tsx'], DOCS);
  assert.ok(r.matched.includes('docs/guides/react.md'));
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: FAIL — `mapChangedPaths` not exported.

**Step 3: Write minimal implementation** (append to `docs-map.mjs`)

```js
// A changed path is "code" for uncovered-reporting purposes unless it is a
// test, config, or a doc itself. Kept deliberately conservative.
function isCodePath(p) {
  const rel = stripDot(p);
  if (rel.startsWith('docs/')) return false;
  if (/(^|\/)__tests__\//.test(rel) || /\.test\.[cm]?[jt]sx?$/.test(rel) || /_test\.go$/.test(rel)) return false;
  if (/(^|\/)(package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|.*\.ya?ml|.*\.md)$/.test(rel)) return false;
  return true;
}

// docsIndex: Array<{ path, covers: string[] }>. Returns matched docs (union,
// deduped, sorted) and uncovered code paths (sorted).
export function mapChangedPaths(changed, docsIndex) {
  const compiled = docsIndex.map((d) => ({ path: d.path, res: d.covers.map(globToRegExp) }));
  const matched = new Set();
  const uncovered = new Set();
  for (const raw of changed) {
    const p = stripDot(raw);
    let hit = false;
    for (const d of compiled) {
      if (d.res.some((re) => re.test(p))) {
        matched.add(d.path);
        hit = true;
      }
    }
    if (!hit && isCodePath(p)) uncovered.add(p);
  }
  return { matched: [...matched].sort(), uncovered: [...uncovered].sort() };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/docs-map.mjs scripts/__tests__/docs-map.test.mjs
git commit -m "feat(docs-sync): add core mapChangedPaths engine"
```

---

### Task A5: CLI wiring — read docs from disk, paths from stdin, emit JSON

**Files:**
- Modify: `scripts/docs-map.mjs`
- Modify: `scripts/__tests__/docs-map.test.mjs`

**Step 1: Write the failing test** for the disk-reading index builder.

```js
import { buildDocsIndex } from '../docs-map.mjs';

test('buildDocsIndex: reads covers from real prose docs', () => {
  // Runs against the repo's actual docs/ after Task B tags them.
  const index = buildDocsIndex();
  const react = index.find((d) => d.path === 'docs/guides/react.md');
  assert.ok(react, 'react guide is indexed');
  assert.ok(react.covers.length > 0, 'react guide declares covers');
});
```

> Note: this test depends on Task B having added frontmatter. If running A before B, mark it `test.skip` and re-enable after B. Prefer doing B5's tagging before this assertion.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Expected: FAIL — `buildDocsIndex` not exported.

**Step 3: Write minimal implementation** (append to `docs-map.mjs`)

```js
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function* walk(dir) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) yield* walk(rel);
    else if (e.name.endsWith('.md')) yield rel;
  }
}

// Builds the { path, covers } index over every prose-tier doc on disk.
// Throws (via readCovers) on malformed frontmatter — fail loud.
export function buildDocsIndex() {
  const index = [];
  for (const rel of walk('docs')) {
    if (!isProseTierDoc(rel)) continue;
    const covers = readCovers(readFileSync(join(root, rel), 'utf8'));
    index.push({ path: rel, covers });
  }
  return index;
}

// CLI: paths on stdin (newline-separated), JSON {matched, uncovered} on stdout.
// Only runs when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = readFileSync(0, 'utf8');
  const changed = input.split('\n').map((s) => s.trim()).filter(Boolean);
  const { matched, uncovered } = mapChangedPaths(changed, buildDocsIndex());
  process.stdout.write(JSON.stringify({ matched, uncovered }, null, 2) + '\n');
}
```

**Step 4: Run test to verify it passes** (after Task B tags docs)

Run: `node --test scripts/__tests__/docs-map.test.mjs`
Manual smoke: `printf 'packages/sdk/src/react/x.tsx\n' | node scripts/docs-map.mjs`
Expected: JSON with `docs/guides/react.md` in `matched`.

**Step 5: Commit**

```bash
git add scripts/docs-map.mjs scripts/__tests__/docs-map.test.mjs
git commit -m "feat(docs-sync): wire docs-map CLI (disk index + stdin paths)"
```

---

### Task A6: Wire mapper tests into the `pnpm test` gate

**Files:**
- Modify: `package.json` (root)

**Step 1:** Add scripts:

```json
"docs:map:test": "node --test scripts/__tests__/",
```

and prepend it to the root gate so the deterministic engine is covered by CI:

```json
"test": "node scripts/check-docs-drift.mjs && node --test scripts/__tests__/ && pnpm -r --filter '!@opslane/test-e2e' test",
```

**Step 2: Verify**

Run: `pnpm docs:map:test` → all mapper tests pass.
Run: `pnpm test` → gate still green (mapper tests now included).

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore(docs-sync): run docs-map tests in the root gate"
```

---

## Phase B — Tag the prose docs + coverage lint

### Task B1–B4: Add `covers:` frontmatter to every prose-tier doc

**Files (all currently have NO frontmatter — they open with `# Title`):**
- `docs/guides/react.md`, `docs/guides/vue.md`, `docs/guides/vanilla.md`, `docs/guides/replay-privacy.md`, `docs/guides/github-app.md`, `docs/guides/source-maps.md`
- `docs/architecture/overview.md`, `docs/architecture/trust.md`, `docs/architecture/precision.md`, `docs/architecture/life-of-an-error.md`
- `docs/quickstart/self-host.md`
- `docs/install.md`

**For each doc:** read it, decide the code globs it actually documents, prepend frontmatter. Example for `docs/guides/react.md`:

```markdown
---
covers:
  - packages/sdk/src/react/**
  - packages/sdk/vite-plugin/**
---
# React setup
...
```

Suggested starting `covers:` (verify against each doc's real content before committing — do not guess):
- guides/react.md → `packages/sdk/src/react/**`, `packages/sdk/vite-plugin/**`
- guides/vue.md → `packages/sdk/src/vue/**`, `packages/sdk/vite-plugin/**`
- guides/vanilla.md → `packages/sdk/src/**` (core, excluding framework dirs — narrow if too broad)
- guides/replay-privacy.md → `packages/sdk/src/replay/**` (confirm dir name)
- guides/github-app.md → `packages/worker/src/github/**`, `packages/ingestion/handler/webhook.go`
- guides/source-maps.md → `packages/sdk/vite-plugin/**`
- architecture/overview.md → `packages/ingestion/**`, `packages/worker/**`, `packages/sdk/**` (broad by design)
- architecture/trust.md → `packages/ingestion/handler/**`, `packages/worker/src/**`
- architecture/precision.md → `packages/worker/src/**`
- architecture/life-of-an-error.md → `packages/ingestion/**`, `packages/worker/**`
- quickstart/self-host.md → `docker-compose*.yml`, `packages/ingestion/db/migrations/**`
- install.md → `packages/sdk/**`

**Verify each:** `git diff` shows only prepended frontmatter, body untouched. Commit in small batches (guides, architecture, quickstart+install) so review is easy.

```bash
git add docs/guides/*.md && git commit -m "docs(docs-sync): add covers frontmatter to guides"
git add docs/architecture/*.md && git commit -m "docs(docs-sync): add covers frontmatter to architecture docs"
git add docs/quickstart/self-host.md docs/install.md && git commit -m "docs(docs-sync): add covers frontmatter to quickstart and install"
```

---

### Task B5: Confirm frontmatter does not break the Astro `docs-site` build

The new `docs-site/` (Astro) renders these docs. Frontmatter is native to Astro/Markdown, but a content-collection schema may reject an unknown `covers` key.

**Step 1:** Build the site.

Run: `cd docs-site && pnpm install && pnpm build` (or the script defined in `docs-site/package.json`).
Expected: build succeeds.

**Step 2:** If Astro's content schema errors on `covers`, extend the collection schema in `docs-site/src/content/config.ts` (or equivalent) to allow `covers: z.array(z.string()).optional()`. Re-run the build.

**Step 3: Commit** (only if a schema change was needed)

```bash
git add docs-site/src/content/config.ts
git commit -m "chore(docs-site): allow covers frontmatter in content schema"
```

---

### Task B6: Coverage lint — every prose-tier doc must declare `covers:`

**Files:**
- Modify: `scripts/check-docs-drift.mjs`
- Modify: `scripts/__tests__/docs-map.test.mjs` (test the exported check helper)

**Step 1: Write the failing test** for a reusable checker in `docs-map.mjs`:

```js
import { findUncoveredProseDocs } from '../docs-map.mjs';

test('findUncoveredProseDocs: reports docs missing a covers list', () => {
  const index = [
    { path: 'docs/guides/react.md', covers: ['packages/sdk/src/react/**'] },
    { path: 'docs/guides/orphan.md', covers: [] },
  ];
  assert.deepEqual(findUncoveredProseDocs(index), ['docs/guides/orphan.md']);
});
```

**Step 2:** Run `node --test scripts/__tests__/docs-map.test.mjs` → FAIL (`findUncoveredProseDocs` missing).

**Step 3: Implement** in `docs-map.mjs`:

```js
export function findUncoveredProseDocs(index) {
  return index.filter((d) => d.covers.length === 0).map((d) => d.path).sort();
}
```

Then wire the real check into `check-docs-drift.mjs` (add near the other checks), reusing the module:

```js
import { buildDocsIndex, findUncoveredProseDocs } from './docs-map.mjs';
// ---------- 7. prose docs declare covers: ----------
for (const p of findUncoveredProseDocs(buildDocsIndex())) {
  problems.push(`prose doc ${p} is missing a non-empty covers: frontmatter list`);
}
```

**Step 4: Verify**

Run: `node --test scripts/__tests__/docs-map.test.mjs` → PASS.
Run: `pnpm docs:check` → passes (all prose docs tagged in Task B1–B4). Temporarily remove a `covers:` block from one doc, re-run, confirm it fails, then restore.

**Step 5: Commit**

```bash
git add scripts/docs-map.mjs scripts/check-docs-drift.mjs scripts/__tests__/docs-map.test.mjs
git commit -m "feat(docs-sync): lint that every prose doc declares covers"
```

---

## Phase C — Local `/docs-sync` skill

### Task C1: Author the skill

**Files:**
- Create: `.claude/skills/docs-sync/SKILL.md` (confirm the repo's skill directory convention first; match existing skills if any)

**Content (behavioral spec the local agent follows):**

```markdown
---
name: docs-sync
description: Update prose docs to match uncommitted + committed code changes on the current branch. Run before opening a PR.
---

# docs-sync

1. Resolve the diff base: `git merge-base @{upstream} HEAD` (fall back to `origin/main` if no upstream). Call it BASE.
2. Collect changed paths including working-tree edits:
   `git diff --name-only BASE` and `git diff --name-only` and `git diff --name-only --cached`, unioned.
3. Pipe those paths into the mapper:
   `printf '%s\n' "${paths[@]}" | node scripts/docs-map.mjs`
4. For EACH doc in `matched` (one at a time, isolated):
   - Read the doc and the slices of the diff touching code it covers (`git diff BASE -- <the covers globs>`).
   - Update ONLY what the change made stale. If nothing is stale, leave it. Never invent behavior absent from the diff.
   - Edit that one file only.
5. If `uncovered` is non-empty, tell the user which changed code paths no doc covers — do not edit anything for them.
6. Summarize: which docs changed, which were left as-is, and the uncovered list. The user reviews and commits.
```

**Step 2: Verify (dogfood)** — On a branch with a real SDK change, run `/docs-sync` and confirm it edits only matched docs and reports uncovered paths. This is the manual proof the prompt works before automating it in CI.

**Step 3: Commit**

```bash
git add .claude/skills/docs-sync/SKILL.md
git commit -m "feat(docs-sync): add local /docs-sync skill"
```

---

## Phase D — Internal-only PR Action

Workflows can't be unit-tested; verification is `check-action-pins.mjs`, `actionlint` (if available), a CLI auth smoke, and a staged live PR. Do this phase last.

### Task D1: Resolve and pin the Claude runtime SHA

We run Claude **headless** in a deterministic step (not agentic PR manipulation), so the LLM only edits files. Install the CLI via `npm`/`npx` (npm packages are exempt from the action-pin check). If instead you use `anthropics/claude-code-action`, it MUST be SHA-pinned.

**Step 1:** Resolve the pin you'll use for `actions/checkout` etc. from existing workflows (copy the exact SHAs already in `ci.yml`, e.g. `actions/checkout@9c091bb...` v7.0.0, `pnpm/action-setup@0ebf471...`, `actions/setup-node@8207627...`). Reuse those.

**Step 2:** For the Claude CLI, pin the npm version explicitly (e.g. `npx --yes @anthropic-ai/claude-code@<version> ...`) so runs are reproducible.

---

### Task D2: The workflow file

**Files:**
- Create: `.github/workflows/docs-sync.yml`

**Content:**

```yaml
name: Docs sync
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write
  pull-requests: write
  id-token: write

concurrency:
  group: docs-sync-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  docs-sync:
    # Internal-only: forks get no secrets. Skip the companion branch (no self-trigger)
    # and docs-only PRs (nothing to sync from).
    if: >-
      github.event.pull_request.head.repo.fork == false &&
      !startsWith(github.event.pull_request.head.ref, 'claude/docs-sync-')
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: ${{ github.event.pull_request.head.sha }}   # pin the whole run to one SHA
          fetch-depth: 0
          persist-credentials: true

      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile

      - name: Compute changed paths and map to docs
        id: map
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          git diff --name-only "$BASE_SHA" "$HEAD_SHA" > /tmp/changed.txt
          # Docs-only PR => nothing to sync; exit success, do nothing.
          if ! grep -qvE '^docs/' /tmp/changed.txt; then
            echo "docs-only PR; skipping"; echo "skip=1" >> "$GITHUB_OUTPUT"; exit 0
          fi
          node scripts/docs-map.mjs < /tmp/changed.txt > /tmp/map.json
          cat /tmp/map.json

      - name: Auth smoke (fail fast if the token is bad)
        if: steps.map.outputs.skip != '1'
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: npx --yes @anthropic-ai/claude-code@<PINNED_VERSION> -p "reply with: ok" | grep -qi ok

      - name: Run per-doc reasoning (Read/Edit only)
        if: steps.map.outputs.skip != '1'
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: node scripts/docs-sync-run.mjs /tmp/map.json   # see Task D3

      - name: Validate the allowlist (reject stray edits)
        if: steps.map.outputs.skip != '1'
        run: node scripts/docs-sync-validate.mjs /tmp/map.json   # see Task D4

      - name: Post uncovered advisory
        if: steps.map.outputs.skip != '1'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR: ${{ github.event.pull_request.number }}
        run: node scripts/docs-sync-advisory.mjs /tmp/map.json   # comments only if uncovered non-empty

      - name: Open or update the companion docs PR
        if: steps.map.outputs.skip != '1'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR: ${{ github.event.pull_request.number }}
          HEAD_REF: ${{ github.event.pull_request.head.ref }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: node scripts/docs-sync-open-pr.mjs   # see Task D5
```

**Verify:**
Run: `node scripts/check-action-pins.mjs` → passes (all `uses:` SHA-pinned).
Run: `actionlint .github/workflows/docs-sync.yml` (if installed) → clean.

**Commit:** `git add .github/workflows/docs-sync.yml && git commit -m "feat(docs-sync): internal-only PR action"`

---

### Task D3: `scripts/docs-sync-run.mjs` — deterministic per-doc loop

Reads `map.json`, and for each `matched` doc invokes ONE headless Claude session restricted to that file:

```js
// For each matched doc: build the per-doc diff slice (git diff BASE_SHA -- <covers globs>),
// then: npx @anthropic-ai/claude-code@<ver> -p "<prompt with doc path + slice>" \
//   --allowed-tools "Read,Edit"
// The prompt forbids editing any file other than the target doc.
```

Keep the prompt identical to the `/docs-sync` skill's step-4 instruction so both paths behave the same. **Verify** with a local fixture repo (a throwaway branch) before trusting it in CI.

---

### Task D4: `scripts/docs-sync-validate.mjs` — allowlist enforcement (the security gate)

```js
// git status --porcelain => every changed path MUST be in map.matched.
// If any changed path is outside the allowlist: print them, `git checkout -- .`
// to discard, and exit 1 so no PR is opened. This is finding #2's hard stop.
```

**Verify (critical test):** craft a fixture where the model is coaxed (via a planted instruction in the diff) to edit an unlisted file; confirm this step aborts and opens no PR.

---

### Task D5: `scripts/docs-sync-open-pr.mjs` — companion PR lifecycle

```js
// If `git status --porcelain` is empty => no edits => exit 0 (no PR).
// Else: branch = claude/docs-sync-<PR>. Commit only the doc edits.
// Base of the branch = source head SHA; PR --base <HEAD_REF> (the code branch),
// so docs merge INTO the code branch. Force-update the branch to reflect the
// latest head.sha. If a companion PR for <PR> exists, push updates it; else
// `gh pr create --base <HEAD_REF> --head claude/docs-sync-<PR> --body "Docs for #<PR>"`.
```

**Verify:** on a staging repo, open a code PR touching `packages/sdk/src/react/**`; confirm a companion PR appears against the code branch, editing only `guides/react.md`.

---

### Task D6: Companion cleanup on source PR close

**Files:**
- Create: `.github/workflows/docs-sync-cleanup.yml`

```yaml
name: Docs sync cleanup
on:
  pull_request:
    types: [closed]
permissions:
  contents: write
  pull-requests: write
jobs:
  cleanup:
    if: startsWith(github.event.pull_request.head.ref, 'claude/docs-sync-') == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - name: Close and delete the companion PR/branch
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          gh pr close "claude/docs-sync-$PR" --delete-branch || true
```

**Verify:** `node scripts/check-action-pins.mjs` passes. On staging, merge/close the source PR and confirm the companion branch is removed.

**Commit:** `git add .github/workflows/docs-sync-cleanup.yml && git commit -m "feat(docs-sync): clean up companion PR on source close"`

---

## Final verification (whole feature)

1. `pnpm docs:map:test` — mapper unit tests pass (incl. malformed frontmatter, overlapping globs, deletes/renames, uncovered noise filtering).
2. `pnpm docs:check` — coverage lint passes; every prose doc declares `covers:`.
3. `pnpm test` — full root gate green.
4. `cd docs-site && pnpm build` — site still builds with frontmatter.
5. `node scripts/check-action-pins.mjs` — both new workflows fully SHA-pinned.
6. Staged live PR (internal): code change → companion docs PR against the code branch, editing only matched docs; allowlist violation aborts; docs-only PR and fork PR both skip; closing the source PR removes the companion branch.

## Notes / risks to watch

- **CLI OAuth in CI is the load-bearing assumption.** Task D2's auth-smoke step exists to fail fast if `CLAUDE_CODE_OAUTH_TOKEN` doesn't authenticate the headless CLI the way `claude-code-action` consumes it. Do not build D3–D5 until the smoke step is green in a real Actions run.
- **`covers:` globs will start rough.** Expect to tune them after the first few real PRs; too-broad globs cause noisy companion PRs, too-narrow miss updates. The lint guarantees presence, not correctness.
- Keep the `reference/` tier out of this system — it stays with `check-docs-drift.mjs`.
```
