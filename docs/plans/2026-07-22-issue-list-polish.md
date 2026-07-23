# Issue List Polish Implementation Plan

**Goal:** Turn the incident list screen into a scannable issue queue — fix the app-wide select chevron bug, cut redundant chrome, harden the one URL sanitizer, and surface two fields the API already returns but the UI throws away (`first_seen`, `pr_url`).

**Architecture:** Dashboard-only. No migrations, no Go changes, no API contract changes. Every field this plan renders is already on the `Incident` type in `packages/dashboard/src/types/api.ts:132`. Work proceeds bottom-up: pure helpers first, then the row and header together, then naming.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript strict, Tailwind CSS v4, Vitest + `@vue/test-utils` (jsdom), Playwright (test-e2e).

**Revision:** v5.
- v1 → v2 after `/codex review` found 11 blocking defects. Marked `[codex]`.
- v2 → v3 after `/plan-eng-review` found 5 more. Marked `[eng]`.
- v3 → v4 after human review found 4 blockers and 7 corrections. Marked `[review]`.
- v4 → v5 after `/plan-design-review` rated it 5/10 and made 8 design decisions. Marked `[design]`. **The Design decisions section supersedes any code block it conflicts with.**

**Every command in this plan has been executed, not assumed.** `[review]` v3 used `pnpm --filter @opslane/dashboard test -- <file>`, which silently runs the entire 46-file suite rather than one file — verified: 46 files / 221 tests versus 1 file / 4 tests for the corrected form. Every "Expected: FAIL with exactly N" step in v3 was therefore unusable. Use `pnpm --filter <pkg> exec vitest run <file>` throughout.

---

## Ships as two PRs

`[eng]` v2 was one 25-file change doing two unrelated jobs. Split so each reviewer holds one thing:

| PR | Tasks | Files | Job |
|---|---|---|---|
| **PR 1 — what the user reads** | 1-5 | ~20 | Chevron fix, sanitizer hardening, row/header rebuild, Age column, PR link, header and filter cleanup, **and every user-visible string on this screen** |
| **PR 2 — what the code reads** | 6 | ~11 | Route name, paths, filenames, test route strings. No user-visible text changes |

PR 2 depends on PR 1 (it renames files PR 1 rewrites). Do not start it until PR 1 merges.

**The split line is "does a user see it", not "is it a rename".** An earlier draft put the `<h1>` in PR 1 and the empty state, error text, loading label, and nav label in PR 2. That would have merged a screen titled **Issues** whose empty state said "No incidents yet" and whose sidebar entry said "Incidents" — visibly half-renamed on `main` for as long as PR 2 took. It also would have broken `test-e2e/dashboard-screenshots.test.ts:61`, which waits for `/Production incidents/i`, one PR before the plan said to update it.

So PR 1 owns every string a user reads, plus the e2e identity that asserts one. PR 2 is invisible from the UI: it moves files and changes a route name.

---

## Design decisions `[design]`

From `/plan-design-review`, which rated the plan 5/10 on design completeness. **Where these conflict with a code block later in this document, these win** — the code blocks are v4 and predate them. Each was a real gap, not a preference.

The approved visual reference is **variant C** at `~/.gstack/projects/opslane-opslane-oss/designs/issue-list-20260722/variant-C.png`.

### D1. The second line appears only when it says something

Variant C has no second line at all. The plan renders `JavaScript` under every title. Both are wrong at the extremes: repeating the platform on every row of a single-platform project is noise, but deleting the line loses the `Friction` / `Unchecked` label that `activity-feed-filters.test.ts:143` correctly asserts.

Render the marker line only when it carries information:
- `kind` marker: when `kind !== 'error'` (unchanged from v4).
- `platform` marker: only when the loaded list contains **more than one distinct platform**. Compute it in `IssuesList.vue` and pass it down as a prop — the row cannot know what the other rows contain.

```ts
// IssuesList.vue
const platformsVary = computed(
  () => new Set(incidents.value.map((i) => i.platform).filter(Boolean)).size > 1,
);
```

The existing friction test stays green because friction rows keep their kind marker. Add a test asserting the platform marker disappears when every row shares a platform.

### D2. Default sort is users affected, descending

`useTableSort(incidents, 'last_seen', ...)` at `ActivityFeed.vue:42` was inherited, never chosen. Sorted by recency, one noisy one-off outranks an outage hitting 3,000 people, and the most prominent row on the screen is the least important one. The product's claim is that it triages; the default order should reflect that.

Change the default key to `'users'`. `last_seen` remains a sortable column, so recency is one click away and is visible in its own column regardless.

Update the `age` sort test's expectations accordingly — the list no longer arrives `last_seen`-ordered.

### D3. Two empty states, not one

`ActivityFeed.vue:166` renders one empty state for `incidents.length === 0` regardless of filters, so an engineer with 400 issues who filters to "Merged" is told *"No incidents yet. Events will appear once your SDK starts reporting errors."* and handed a Setup guide button. `currentFilters` is already in scope at line 19 and unused by this branch.

```ts
const hasActiveFilters = computed(() => Object.keys(currentFilters.value).length > 0);
```

| Condition | Title | Description | Action |
|---|---|---|---|
| Empty, no filters | `No issues yet` | `Events will appear once your SDK starts reporting errors.` | `Setup guide` → `/setup` |
| Empty, filters active | `No issues match these filters` | `Try widening or clearing them.` | `Clear filters` — resets all filters and the URL query |

`Clear filters` must reset `FilterBar`'s selects and the URL query, not just refetch. Emit an event the bar listens for, or expose a `reset()` on it.

Test both branches. The v4 empty-state test asserts `Setup guide` is present; keep it for the unfiltered case and add the filtered case beside it.

### D4. A linked status pill must look linked

v4 wraps `StatusLabel` in an `<a>` whose only added classes are a focus ring, so a `Draft PR` that opens GitHub and an `Analyzing` that does nothing are pixel-identical. There is no hover on touch. This is the product's best moment and it is invisible.

When `prUrl` is non-null, the pill gains a trailing external-link arrow glyph and an underline on hover/focus:

```vue
<a
  v-if="prUrl" :href="prUrl" target="_blank" rel="noopener noreferrer"
  data-testid="pr-link"
  :aria-label="`${status.label}, opens pull request on GitHub`"
  class="inline-block rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
>
  <StatusLabel :tone="status.tone" :label="status.label">
    {{ status.label }}<span aria-hidden="true" class="ml-1">↗</span>
  </StatusLabel>
</a>
```

Shape, not colour, carries the signal — it survives a dense table and works without colour vision. `StatusLabel` already exposes a default slot (`ui/StatusLabel.vue:36`), so no component change is needed. Test that the arrow is absent when there is no valid `pr_url`.

### D5. Match the approved mockup

| Drift | v4 | Fix |
|---|---|---|
| Number formatting | `{{ incident.occurrence_count }}` → `12842` | `.toLocaleString()` on Events and Users |
| Table container | `border-y` full-bleed | Bordered rounded container, inset from the page edge, per variant C |
| Filter row | Plain text dropdowns | Small leading icon in each of the four dropdowns |

### D6. Below 640px the table becomes stacked rows

The v4 breakpoints leave Title and Status on a phone — a two-column table, which is a list wearing a table costume, and the numbers that tell you which issue matters are exactly the ones hidden. Nobody chose this; it fell out of the class list.

Under `sm:`, drop table semantics and render each issue as a stacked block:

```
┌─────────────────────────────────────┐
│ TypeError: Cannot destructure       │   title, up to 2 lines
│ property 'name' of 'props.user'     │
│ Draft PR ↗  ·  312 users  ·  2h     │   one meta line: status, users, age
└─────────────────────────────────────┘
```

Keep the `<table>` for `sm:` and up. The responsive e2e test from Task 5 Step 3e must cover both shapes, and assert the stacked layout appears below 640px rather than a two-column table.

### D7. Mobile needs its own sort control

D6 removes the column headers, which are the only sort control — so sorting would silently vanish on phones. Below `sm:`, render a compact `Sort:` dropdown beside the filters, bound to the same `toggleSort` keys the headers use. Same state, same comparators, different affordance.

### D8. Filter selects must meet the touch minimum

Applied without a decision — it is a WCAG minimum, not a preference. `FilterBar`'s selects are `py-1.5` with no min-height (~32px). The sanctioned `SelectField.vue:42` uses `min-h-10 max-md:min-h-11` (40px desktop, 44px touch). Add the same to all four filter selects and the mobile sort dropdown.

Combined with Task 1's chevron fix, each filter select is:
`min-h-10 max-md:min-h-11 text-sm rounded-md border border-border bg-surface pl-3 pr-8 py-1.5`

---

## Data flow

`[eng]` Two mechanisms on this screen are invisible from any single function. Both have already produced a bug.

```
  getProjectId()                    utils.ts:17 — query ?project_id, else localStorage
        │
        ▼
  IssuesList.onMounted ──────────► FilterBar (account│status│platform│environment)
        │                                  │
        │                                  │ @filter-change (also on every URL query sync)
        │◄─────────────────────────────────┘
        ▼
  fetchIncidents(filters)
        │
        │  const generation = ++fetchGeneration      ◄── STALE-RESPONSE GUARD
        ├──► listIncidents() ──► await ──┐               Change a filter twice quickly and
        │                                │               two requests are in flight. Only the
        │    if (generation !== fetchGeneration) return  newest generation may write state,
        │                                │               so a slow first response cannot
        ▼                                ▼               clobber a fast second one.
  incidents.value ◄──────────────────────┘               Covered by issues-list-filters.test.ts
        │
        ▼
  useTableSort(incidents, 'last_seen', comparators)
        │
        │   sorted = [...items].sort((a,b) => comparators[key](a,b) * dir)
        │   dir = sortDir === 'asc' ? 1 : -1        ◄── DIRECTION INVERSION
        │   a newly-selected key defaults to 'desc'     Every comparator is multiplied by -1
        │                                               on first click. A comparator that
        ▼                                               READS "newest first" RENDERS oldest
  sortedIncidents ──► v-for ──► IssueRow                first. This is what made the v2 age
                                    │                   comparator comment wrong.
                                    ├─ title ──────────► router-link → { name: 'incident' }
                                    ├─ kind/platform markers (inline, non-default only)
                                    ├─ status ─────────► safeUrl(pr_url, GITHUB) ? <a> : <span>
                                    ├─ events, users
                                    ├─ age ────────────► formatCompactAge(first_seen)
                                    └─ last seen ──────► formatDate(last_seen)

  Separately, every 30s: pollForNew() → full listIncidents() → compares .length only.
  Known waste, deliberately untouched. See TODOS.md.
```

Task 4 Step 0 adds a condensed version of the DIRECTION INVERSION box as an inline comment in `composables/useTableSort.ts`.

---

## Context for the engineer

You have not seen this codebase. Read these before starting:

- `packages/dashboard/src/views/ActivityFeed.vue` — the list screen (226 lines)
- `packages/dashboard/src/components/incidents/IncidentLedgerRow.vue` — one table row (45 lines)
- `packages/dashboard/src/components/FilterBar.vue` — the filter row (160 lines)
- `packages/dashboard/src/utils.ts` — `safeUrl`, `formatDate`, `getProjectId`

**Domain vocabulary.** An "incident" (backend name) is one grouped production error. Many raw events collapse into one by `fingerprint`. The product investigates each and tries to open a GitHub PR that fixes it. `status` tracks that lifecycle (`new` → `analyzing` → `pr_draft` → `merged`). `kind` is `'error'` (a thrown exception) or `'friction'` (a UX problem, no exception). This plan renames the *user-visible* word to "Issue" but leaves backend/type names alone — see Task 6 for the boundary.

**Commands:**
```bash
pnpm --filter @opslane/dashboard test                 # unit tests
pnpm --filter @opslane/dashboard exec vitest run src/utils.test.ts   # one file
pnpm --filter @opslane/dashboard build                # vue-tsc + vite build
pnpm --filter @opslane/test-e2e test                  # e2e (NOT in root `pnpm test`)
```

**Commit after every task.** Do not batch commits.

---

## Scope decisions

1. **The Platform filter stays.** `platform` is a URL query contract exercised by `activity-feed-filters.test.ts:73`, and the repo ships both a JavaScript and a Python SDK (`packages/ingestion/db/migrations/016_platform.sql`, `packages/worker/src/harness/python-frames.ts`). The clutter is the `Platform:` prefix and the chevron bug, not the filter existing.

2. **`kind` and `platform` are demoted, not deleted.** A KIND column reading "Error / JavaScript" on every row is noise, but `kind: 'friction'` is meaningful and `activity-feed-filters.test.ts:143` asserts friction is visible. The KIND *column* dies; both values become inline markers, `kind` rendered only when it is not the default `'error'`.

3. **One URL sanitizer, not two.** `[eng]` v2 added `safePrUrl` in a new module while `safeUrl` (`utils.ts:34`) already guarded `pr_url` at four sites. Two implementations of a security check is two policies. Task 3 hardens `safeUrl` instead and deletes the second one.

4. **`safeUrl`'s permissive default stays permissive — with one stated exception.** `[eng]` Making it https-only by default would be a regression: `AdminView.vue:316` sanitizes `trace_url`, and `LANGFUSE_BASE_URL` is operator-configurable (`docker-compose.yml:119`), so a self-hosted `http://langfuse.internal:3000` is legitimate and would silently stop rendering. Protocol strictness and host allowlisting are opt-in per call site.

   Two things about the default **do** change, and calling them "no change" would be false: `[review]`
   - **Credentials are now rejected in every mode.** `https://user:pass@host/` previously passed. No legitimate `page_url`, `trace_url`, or `install_url` carries credentials, and an authority that reads as one host while resolving to another is the exact spoof this function exists to stop. Accepted deliberately.
   - **Normalization is opt-in, not default.** An earlier draft returned `parsed.toString()` unconditionally. That desynchronizes every caller that renders the raw value as visible link text — and there are five of those, not the one the draft found. Permissive mode now returns the input string unchanged; only a call that passes options gets the normalized form. See Task 3.

5. **Enterprise GitHub PR links are out of scope.** The allowlist is `github.com` / `www.github.com`. The worker supports a custom host via `OPSLANE_GITHUB_URL` (`packages/worker/src/repo-clone.ts:27`) but the dashboard cannot see it. A self-hosted install renders the badge as plain text — degraded, never unsafe. Tracked in `TODOS.md`.

---

## What already exists

| Existing | Plan's use | Verdict |
|---|---|---|
| `safeUrl` (`utils.ts:34`) | Hardened and reused at all 5 sites | Reuse — v2 wrongly rebuilt it |
| `SelectField.vue:42` | Not used; selects are hand-patched | Considered and rejected: its grid `<label>` wrapper would force a filter-row relayout plus 4 unrelated restyles. Padding classes are the smaller correct diff |
| `tailwind-token.test.ts` | New chevron test lands beside it | Reuse the convention (same folder, same source-scanning style) |
| `useTableSort` | Reused, gains an `age` comparator | Reuse |
| `kindBadge` / `platformBadge` | Reused for `.label` | Reuse; `platformBadge.class` becomes dead and is deleted |
| `formatDate` | Kept for Last Seen | Reuse; `formatCompactAge` is additive, different output shape |
| `test-e2e/dashboard-screenshots.test.ts` | Extended with breakpoint assertions | Reuse the harness |

---

# PR 1 — Polish

## Task 1: Fix the select chevron overlap (app-wide)

The bug: `Account: [All accounts⌄]` renders the chevron on top of the last character.

**Root cause.** `styles/base.css:85` sets `appearance: none` and paints a chevron at `right 0.75rem center`. Every `<select>` needs ~2rem of right padding to clear it. Only `SelectField.vue:42` has it (`pr-9`).

**Nine selects across six files.** `[codex]` v1 undercounted by scanning only two files. Verified list:

| File | Selects |
|---|---|
| `components/FilterBar.vue` | 4 |
| `components/InvitationsPanel.vue` | 1 |
| `components/OrgSwitcher.vue` | 1 |
| `components/ProjectSwitcher.vue` | 1 |
| `components/RepoSelector.vue` | 1 |
| `views/Settings.vue` | 1 |

**Why not fix it in `base.css`.** `[codex]` v1 claimed it "cannot be enforced in CSS". Too strong: a declaration inside `@layer base` does lose to a later `px-*` utility (`theme.css` orders utilities after base), but an **unlayered** rule would outrank layered utilities and would work. We still choose the per-element utility because it is explicit, greppable, and enforceable by a test. Use `pl-* pr-*` rather than `px-* pr-*` so no shorthand-vs-longhand question arises.

**Files:**
- Modify the six files above
- Create: `packages/dashboard/src/select-chevron-clearance.test.ts` `[eng]` — beside `tailwind-token.test.ts`, the established home for source-scanning design-system tests, not `components/__tests__/`

**Step 1: Write the failing test**

Create `packages/dashboard/src/select-chevron-clearance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = dirname(fileURLToPath(import.meta.url));

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return vueFiles(full);
    return full.endsWith('.vue') ? [full] : [];
  });
}

/**
 * base.css paints the select chevron at `right 0.75rem`, so every select needs
 * roughly 2rem of right padding to keep the arrow off the option text.
 * Tailwind v4 places utilities in a later layer than @layer base, so a base-layer
 * padding rule loses to any px-* utility — this has to be a class on each control.
 */
describe('select chevron clearance', () => {
  it('gives every <select> at least pr-8 of right padding', () => {
    const offenders: string[] = [];

    for (const file of vueFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const tag of source.matchAll(/<select\b[\s\S]*?>/g)) {
        const classAttr = /\bclass="([^"]*)"/.exec(tag[0])?.[1] ?? '';
        if (!/\bpr-(8|9|10|11|12)\b/.test(classAttr)) offenders.push(relative(SRC, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
```

Note `import.meta.url`, not `__dirname` — this package is ESM. `[codex]`

**Step 2: Run it to make sure it fails**

```bash
pnpm --filter @opslane/dashboard exec vitest run src/select-chevron-clearance.test.ts
```
Expected: FAIL with **exactly nine** entries. If the count differs, a select was added since this plan was written — fix that one too rather than editing the assertion.

**Step 3: Fix the padding in all six files**

`FilterBar.vue`, all four: `px-2` → `pl-2 pr-8`.
`InvitationsPanel.vue:78`: `px-3 py-2` → `pl-3 pr-9 py-2`.
`OrgSwitcher.vue`, `ProjectSwitcher.vue`, `RepoSelector.vue`, `Settings.vue`: split each `px-N` into `pl-N pr-8` (`pr-9` if the existing padding is `px-3` or larger). Padding only — do not otherwise restyle.

**Step 4: Verify**

```bash
pnpm --filter @opslane/dashboard test
```
Expected: all PASS.

**Step 5: Commit**

```bash
git add packages/dashboard/src
git commit -m "fix(dashboard): stop the select chevron overlapping option text"
```

---

## Task 2: Add a compact age formatter

The Age column needs `7d`, not `about 7 days ago`.

**Files:**
- Modify: `packages/dashboard/src/utils.ts`
- Create: `packages/dashboard/src/__tests__/format-compact-age.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { formatCompactAge } from '../utils';

const NOW = new Date('2026-07-22T12:00:00Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('formatCompactAge', () => {
  it('renders seconds under a minute', () => {
    expect(formatCompactAge('2026-07-22T11:59:30Z', NOW)).toBe('30s');
  });

  it('renders whole minutes under an hour', () => {
    expect(formatCompactAge('2026-07-22T11:05:00Z', NOW)).toBe('55m');
  });

  it('renders whole hours under a day', () => {
    expect(formatCompactAge('2026-07-22T02:00:00Z', NOW)).toBe('10h');
  });

  it('renders whole days under a month', () => {
    expect(formatCompactAge(daysBefore(5), NOW)).toBe('5d');
  });

  it('renders months beyond 30 days', () => {
    expect(formatCompactAge(daysBefore(90), NOW)).toBe('3mo');
  });

  // Regression: a naive `months < 12` cutoff returns "0y" for 360-364 days,
  // because Math.floor(362/30) is 12 but Math.floor(362/365) is 0.
  it('keeps rendering months across the 360-364 day gap', () => {
    expect(formatCompactAge(daysBefore(359), NOW)).toBe('11mo');
    expect(formatCompactAge(daysBefore(360), NOW)).toBe('12mo');
    expect(formatCompactAge(daysBefore(364), NOW)).toBe('12mo');
  });

  it('switches to years at exactly 365 days', () => {
    expect(formatCompactAge(daysBefore(365), NOW)).toBe('1y');
    expect(formatCompactAge(daysBefore(730), NOW)).toBe('2y');
  });

  it('returns an em dash for an unparseable timestamp', () => {
    expect(formatCompactAge('not-a-date', NOW)).toBe('—');
  });

  it('clamps a future timestamp to 0s rather than showing a negative age', () => {
    expect(formatCompactAge('2026-07-23T12:00:00Z', NOW)).toBe('0s');
  });
});
```

**Step 2: Run it to make sure it fails**

```bash
pnpm --filter @opslane/dashboard exec vitest run src/__tests__/format-compact-age.test.ts
```
Expected: FAIL, "does not provide an export named 'formatCompactAge'".

**Step 3: Implement**

Add to `utils.ts`, below `formatAbsolute`:

```ts
/**
 * Compact age for narrow numeric table columns: `30s`, `55m`, `10h`, `5d`,
 * `3mo`, `2y`. `formatDate` produces prose ("about 7 days ago") which wraps
 * and destroys column alignment.
 *
 * `now` is injectable so tests do not depend on wall-clock time.
 */
export function formatCompactAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (isNaN(then.getTime())) return '—';

  // Clock skew between browser and ingest can put a timestamp slightly in the
  // future. Show 0s rather than a negative age.
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  // Gate on days, not the derived month count: 360-364 days floor to 12 months
  // but to 0 years, so a `months < 12` cutoff would print "0y".
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
```

**Step 4: Verify and commit**

```bash
pnpm --filter @opslane/dashboard exec vitest run src/__tests__/format-compact-age.test.ts
git add packages/dashboard/src/utils.ts packages/dashboard/src/__tests__/format-compact-age.test.ts
git commit -m "feat(dashboard): add compact age formatter for table columns"
```
Expected: PASS, 9 tests.

---

## Task 3: Harden the existing `safeUrl` (do not add a second validator)

`[eng]` This replaces v2's Task 3, which created `components/incidents/pr-link.ts`. Do not create that file.

**Why.** `pr_url` comes from the worker, so the dashboard treats it as untrusted (`packages/dashboard/AGENTS.md`). Vue does not sanitize `href`, so an unvalidated value accepts `javascript:`. A sanitizer already exists and already guards `pr_url` at four sites:

```ts
// packages/dashboard/src/utils.ts:34 — current
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return url;
    return undefined;
  } catch { return undefined; }
}
```

**Full call-site inventory — 9 files, 15 calls, grep-verified.** `[review]` An earlier draft listed only the four `pr_url` sites and planned a change (unconditional normalization) that would have silently affected all fifteen.

| File:line | Value | Renders raw as visible text? |
|---|---|---|
| `views/IncidentDetail.vue:406,422` | `pr_url` | **Yes** — `v-text="incident.pr_url"` at `:427` |
| `views/IncidentDetail.vue:689,693` | `trace_url` | No |
| `views/AdminView.vue:316,317,331` | `trace_url` | No |
| `views/AdminView.vue:324,325,331` | `pr_url` | No |
| `components/incidents/IncidentConclusion.vue:20` | `pr_url` | Check on read |
| `views/SetupWizard.vue:361` | `setupPr.pr_url` | No |
| `views/SetupWizard.vue:242` | `githubAppStatus.install_url` | No |
| `views/Settings.vue:587` | `githubAppStatus.install_url` | No |
| `views/SessionDetail.vue:89` | `session.page_url` | **Yes** — `v-text="session.page_url"` |
| `views/SessionsList.vue:197` | `item.page_url` | **Yes** — `v-text="item.page_url"` |

It has zero tests, allows any host, allows credentials in the authority, and returns the raw unparsed string.

Note `install_url` at two sites: those are GitHub App install URLs, not PR URLs. They stay on the permissive default — do not hand them `GITHUB_PR_URL_OPTIONS`.

**Allowlist design.** `[codex]` v1 used `hostname.startsWith('github.')`, broken both ways: it accepts `github.evil.com` and `github.com.evil.example`, and rejects real enterprise hosts. A hostname prefix is not an origin check. Use an exact host set.

**Default preserved.** `[eng]` `httpsOnly` defaults to `false` so `AdminView`'s `trace_url` keeps working against a self-hosted `http://` Langfuse. Strictness is opt-in.

**Files:**
- Modify: `packages/dashboard/src/utils.ts`
- Create: `packages/dashboard/src/__tests__/safe-url.test.ts`
- Modify: `IncidentDetail.vue`, `AdminView.vue`, `IncidentConclusion.vue`, `SetupWizard.vue` (pass the GitHub options for `pr_url`)

**Step 1: Write the failing test**

Create `packages/dashboard/src/__tests__/safe-url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { safeUrl, GITHUB_PR_URL_OPTIONS } from '../utils';

describe('safeUrl — default (permissive) mode', () => {
  it('accepts https', () => {
    expect(safeUrl('https://example.test/a')).toBe('https://example.test/a');
  });

  // REGRESSION GUARD: LANGFUSE_BASE_URL is operator-configurable
  // (docker-compose.yml:119). A self-hosted Langfuse over plain http is
  // legitimate, and AdminView renders trace_url through this function.
  // Tightening the default to https-only would silently kill every trace link.
  it('still accepts http, which AdminView trace links depend on', () => {
    expect(safeUrl('http://langfuse.internal:3000/trace/abc'))
      .toBe('http://langfuse.internal:3000/trace/abc');
  });

  it('rejects javascript:', () => expect(safeUrl('javascript:alert(1)')).toBeUndefined());
  it('rejects data:', () => expect(safeUrl('data:text/html,<script>')).toBeUndefined());
  it('rejects a malformed URL', () => expect(safeUrl('not a url')).toBeUndefined());
  it('returns undefined for undefined', () => expect(safeUrl(undefined)).toBeUndefined());
  it('returns undefined for empty string', () => expect(safeUrl('')).toBeUndefined());

  it('rejects credentials in the authority even in permissive mode', () => {
    expect(safeUrl('https://github.com@evil.example/a')).toBeUndefined();
  });
});

describe('safeUrl — GitHub PR mode', () => {
  const check = (u: string | undefined) => safeUrl(u, GITHUB_PR_URL_OPTIONS);

  it('accepts an https github.com pull request URL', () => {
    expect(check('https://github.com/acme/web/pull/42'))
      .toBe('https://github.com/acme/web/pull/42');
  });

  it('accepts the www host', () => {
    expect(check('https://www.github.com/acme/web/pull/42')).toBeDefined();
  });

  it('is case-insensitive about the host', () => {
    expect(check('https://GitHub.com/acme/web/pull/42')).toBeDefined();
  });

  // A hostname *prefix* check accepts both of these. An origin check must not.
  it('rejects an attacker domain starting with "github."', () => {
    expect(check('https://github.evil.com/acme/web/pull/42')).toBeUndefined();
  });

  it('rejects an attacker domain starting with "github.com."', () => {
    expect(check('https://github.com.evil.example/acme/web/pull/42')).toBeUndefined();
  });

  it('rejects a lookalike suffix host', () => {
    expect(check('https://notgithub.com/acme/web/pull/42')).toBeUndefined();
  });

  it('rejects a valid https URL on a non-allowlisted host', () => {
    expect(check('https://gitlab.com/acme/web/-/merge_requests/42')).toBeUndefined();
  });

  it('rejects plain http even on an allowlisted host', () => {
    expect(check('http://github.com/acme/web/pull/42')).toBeUndefined();
  });

  it('rejects javascript: on an allowlisted-looking string', () => {
    expect(check('javascript:alert(1)')).toBeUndefined();
  });
});
```

**Step 2: Run it to make sure it fails**

```bash
pnpm --filter @opslane/dashboard exec vitest run src/__tests__/safe-url.test.ts
```
Expected: FAIL — no export named `GITHUB_PR_URL_OPTIONS`, and the credential and allowlist cases fail against the current implementation.

**Step 3: Implement**

Replace `safeUrl` in `utils.ts`:

```ts
export interface SafeUrlOptions {
  /**
   * Reject `http:`. Defaults to false, preserving the historic behavior —
   * AdminView renders trace_url through this function and LANGFUSE_BASE_URL
   * may legitimately be a self-hosted http:// origin (docker-compose.yml:119).
   */
  httpsOnly?: boolean;
  /**
   * Exact hostname allowlist, lowercased. Omit to allow any host.
   * Exact matching is deliberate: a prefix test (startsWith('github.'))
   * accepts github.evil.com, and a suffix test (endsWith('github.com'))
   * accepts notgithub.com. Neither is an origin check.
   */
  hosts?: readonly string[];
}

/** PR links are GitHub-only. Enterprise hosts are unsupported — see TODOS.md. */
export const GITHUB_PR_URL_OPTIONS: SafeUrlOptions = {
  httpsOnly: true,
  hosts: ['github.com', 'www.github.com'],
};

/**
 * Sole URL sanitizer for the dashboard. Everything bound to an href passes
 * through here, because worker- and model-derived strings are untrusted
 * (packages/dashboard/AGENTS.md) and Vue does not sanitize href.
 *
 * Return value is deliberately mode-dependent:
 *   - permissive (no options): the ORIGINAL string, byte for byte. Five callers
 *     render the raw value as the visible link text next to this href
 *     (SessionDetail:89, SessionsList:197, IncidentDetail:427, and the two
 *     install_url sites). Normalizing here would make what a user reads differ
 *     from where the link goes.
 *   - strict (any option passed): the normalized URL, so a hardened href is
 *     exactly the string that was validated — no parser-differential gap.
 *     Callers opting in must bind their visible text to this return value too.
 */
export function safeUrl(
  url: string | undefined | null,
  options: SafeUrlOptions = {},
): string | undefined {
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  // Written as an explicit allowlist rather than a compound negation. The
  // equivalent one-liner (`protocol !== 'https:' && (httpsOnly || protocol !== 'http:')`)
  // is correct but takes a truth table to read.
  const allowedProtocols = options.httpsOnly ? ['https:'] : ['https:', 'http:'];
  if (!allowedProtocols.includes(parsed.protocol)) return undefined;

  // `https://github.com@evil.example/` parses with hostname evil.example.
  // Reject credentials outright so a rendered href can never read as one host
  // while resolving to another.
  if (parsed.username || parsed.password) return undefined;

  if (options.hosts && !options.hosts.includes(parsed.hostname.toLowerCase())) {
    return undefined;
  }

  // Only a caller that opted into strictness gets the normalized form.
  const strict = options.httpsOnly === true || options.hosts !== undefined;
  return strict ? parsed.toString() : url;
}
```

`[review]` The `strict` branch is the fix for an earlier draft that normalized unconditionally. That draft was audited against four call sites; there are nine, and three of them render the raw value as visible link text.

**Step 4: Pass the GitHub options at every `pr_url` site**

- `IncidentDetail.vue:406` and `:422` — `safeUrl(incident.pr_url, GITHUB_PR_URL_OPTIONS)`
- `AdminView.vue:324,325,331` — `safeUrl(job.pr_url ?? undefined, GITHUB_PR_URL_OPTIONS)`; leave `trace_url` calls on the permissive default
- `IncidentConclusion.vue:20` — `safeUrl(props.incident.pr_url, GITHUB_PR_URL_OPTIONS)`
- `SetupWizard.vue:361` — `safeUrl(setupPr.pr_url, GITHUB_PR_URL_OPTIONS)`

Import `GITHUB_PR_URL_OPTIONS` alongside the existing `safeUrl` import in each.

**Step 4b: Bind visible link text to the validated value at the strict sites**

Strict mode normalizes, so any site that opted in must not keep rendering the raw string beside it. Only one does — `IncidentDetail.vue:427`:

```vue
<a :href="safeUrl(incident.pr_url)" ... v-text="incident.pr_url"></a>
```

For any input where `new URL(x).toString() !== x` — a bare origin gaining a trailing slash, an uppercase host, a `..` path segment — the text a user reads and the address they navigate to would differ. On a link whose whole purpose is proving where it goes, that is backwards.

Compute once, bind both:

```ts
const prHref = computed(() => safeUrl(props.incident?.pr_url, GITHUB_PR_URL_OPTIONS));
```
```vue
<div v-if="prHref" ...>
  <a :href="prHref" target="_blank" rel="noopener noreferrer" ... v-text="prHref"></a>
</div>
```

`SessionDetail.vue:89` and `SessionsList.vue:197` also render raw text beside the href, but they stay on the **permissive** default, which now returns the input unchanged — so they are unaffected. Leave them alone.

**Step 4c: `AdminView`'s repeated calls need a computed array, not a single computed**

`[review]` `job` is the `v-for` variable at `AdminView.vue:297`, so it cannot be captured by one top-level computed. The template calls `safeUrl` five times per row (`:316,317,324,325,331`). Pick one:

```ts
// Preferred: derive the links once, per row, in script.
const jobsWithLinks = computed(() => jobs.value.map((job) => ({
  ...job,
  traceHref: safeUrl(job.trace_url ?? undefined),
  prHref: safeUrl(job.pr_url ?? undefined, GITHUB_PR_URL_OPTIONS),
})));
```
Then `v-for="job in jobsWithLinks"` and use `job.traceHref` / `job.prHref`, including in the `v-if="!job.traceHref && !job.prHref"` fallback at `:331`.

Alternative if you would rather not reshape the loop: accept the repeated calls. `safeUrl` is pure and cheap, and the admin table is small. What you must not do is write a single top-level computed — it has nothing to close over.

**Step 5: Verify and commit**

```bash
pnpm --filter @opslane/dashboard test
pnpm --filter @opslane/dashboard build
git add packages/dashboard/src
git commit -m "fix(dashboard): harden safeUrl with an exact host allowlist and tests"
```
Expected: 17 safe-url tests PASS, whole suite PASS, build clean.

---

## Task 4: Rebuild the row and header together (one atomic commit)

`[codex]` v1 split this across two tasks and committed a table whose `<tbody>` had six cells while `<thead>` still declared the old six-with-Kind — a broken screen between commits. Row and header change together.

Target columns: **Title, Status, Events, Users, Age, Last Seen.**

**Files:**
- Modify: `composables/useTableSort.ts` (inline diagram only)
- Modify: `components/incidents/IncidentLedgerRow.vue`
- Modify: `components/platform-badge.ts` `[eng]`
- Modify: `views/ActivityFeed.vue` (sort keys `:39-50`, `<thead>` `:177-213`)
- Create: `components/incidents/incident-row.test.ts`
- Modify: `views/__tests__/activity-feed-filters.test.ts`

**Step 0: Add `ariaSort` to `useTableSort`, and the inline sort-direction diagram** `[eng]` `[review]`

The current headers are `<th @click>` — mouse-only, unreachable by keyboard, and they announce nothing to a screen reader. This is a UI-polish pass, so fix it rather than reproduce it. Add to `composables/useTableSort.ts`, beside `sortIndicator`:

```ts
  /** For `<th aria-sort>`. Screen readers announce the active column and direction. */
  function ariaSort(key: K): 'ascending' | 'descending' | 'none' {
    if (sortKey.value !== key) return 'none';
    return sortDir.value === 'asc' ? 'ascending' : 'descending';
  }
```

Return it alongside the rest: `return { sortKey, sortDir, sorted, toggleSort, sortIndicator, ariaSort };`

Then the diagram.

Above the `sorted` computed in `composables/useTableSort.ts`:

```ts
  /*
   * DIRECTION INVERSION — read before writing a comparator.
   *
   *   toggleSort(newKey) ──► sortDir = 'desc'   (default for any newly-picked key)
   *                              │
   *   sorted = [...items].sort((a,b) => comparators[key](a,b) * dir)
   *                                                              │
   *                                        dir = 'asc' ? 1 : -1 ─┘
   *
   * So the FIRST click on a column renders your comparator NEGATED.
   * Write each comparator in its natural ascending sense and let the default
   * 'desc' invert it; do not pre-invert inside the comparator.
   */
```

**Step 1: Write the failing row test**

Create `components/incidents/incident-row.test.ts`:

```ts
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Incident } from '../../types/api';
import IncidentLedgerRow from './IncidentLedgerRow.vue';

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'i1', project_id: 'p1', kind: 'error', platform: 'javascript',
    fingerprint: 'f37814ba355f3df260ec891e3e343433',
    title: "TypeError: Cannot destructure property 'name'",
    status: 'new',
    first_seen: '2026-07-15T12:00:00Z',
    last_seen: '2026-07-17T12:00:00Z',
    occurrence_count: 1, affected_users_count: 0,
    ...overrides,
  };
}

function mountRow(over: Partial<Incident> = {}) {
  return mount(IncidentLedgerRow, {
    props: { incident: incident(over), projectId: 'p1' },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
}

describe('IncidentLedgerRow', () => {
  it('does not render the fingerprint hash', () => {
    expect(mountRow().text()).not.toContain('f37814ba355f3df260ec891e3e343433');
  });

  // Asserted via testid, NOT via .text(). The fixture title is "TypeError: ...",
  // which contains "Error", so a text-level not.toContain('Error') can never pass.
  it('hides the kind marker when the kind is the default error', () => {
    expect(mountRow().find('[data-testid="kind-marker"]').exists()).toBe(false);
  });

  it('shows the kind marker for friction', () => {
    expect(mountRow({ kind: 'friction', platform: null })
      .get('[data-testid="kind-marker"]').text()).toBe('Friction');
  });

  it('shows the unchecked adjudication marker', () => {
    expect(mountRow({ kind: 'friction', adjudication_status: 'unchecked', platform: null })
      .get('[data-testid="kind-marker"]').text()).toBe('Unchecked');
  });

  it('renders the platform inline rather than in its own column', () => {
    const row = mountRow();
    expect(row.get('[data-testid="platform-marker"]').text()).toBe('JavaScript');
    expect(row.findAll('td')).toHaveLength(6);
  });

  it('omits the platform marker when the incident has none', () => {
    expect(mountRow({ kind: 'friction', platform: null })
      .find('[data-testid="platform-marker"]').exists()).toBe(false);
  });

  it('renders a status link to a valid pr_url', () => {
    const link = mountRow({ status: 'pr_draft', pr_url: 'https://github.com/acme/web/pull/42' })
      .get('a[data-testid="pr-link"]');
    expect(link.attributes('href')).toBe('https://github.com/acme/web/pull/42');
    expect(link.attributes('rel')).toContain('noopener');
    expect(link.attributes('target')).toBe('_blank');
  });

  it('renders status as plain text when pr_url is hostile', () => {
    const row = mountRow({ status: 'pr_draft', pr_url: 'javascript:alert(1)' });
    expect(row.find('a[data-testid="pr-link"]').exists()).toBe(false);
    expect(row.text()).toContain('Draft PR');
  });

  // Allowlist rejection is a different branch from protocol rejection.
  it('renders status as plain text for a valid non-github https pr_url', () => {
    const row = mountRow({ status: 'pr_draft', pr_url: 'https://gitlab.com/a/b/-/merge_requests/1' });
    expect(row.find('a[data-testid="pr-link"]').exists()).toBe(false);
    expect(row.text()).toContain('Draft PR');
  });

  it('derives the age cell from first_seen, not last_seen', () => {
    const age = mountRow({
      first_seen: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      last_seen: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    }).get('[data-testid="age"]').text();
    expect(age).toBe('1y');
  });

  it('renders a relative last-seen exactly once', () => {
    expect(mountRow().findAll('[data-testid="last-seen"]')).toHaveLength(1);
    expect(mountRow().text()).not.toContain('Last seen');
  });
});
```

`[codex]` fixes three v1 defects here: the impossible `not.toContain('Error')`, four assertions that already passed pre-implementation, and a wall-clock-dependent `/days ago/` count. `[eng]` adds the non-github allowlist case.

**Step 2: Run it to make sure it fails**

```bash
pnpm --filter @opslane/dashboard exec vitest run src/components/incidents/incident-row.test.ts
```
Expected: FAIL on every `data-testid` assertion (none exist yet), plus fingerprint and td-count.

**Step 3: Delete the dead `class` from `platformBadge`** `[eng]`

`platformBadge` has exactly one consumer (`IncidentLedgerRow.vue:16`) and the new row reads only `.label`, so `.class` drops to zero consumers. Its comment describes two adjacent pills that this task deletes. Replace `components/platform-badge.ts` with:

```ts
import { knownPlatformRecipe, type KnownPlatform } from '../status-recipes';

export interface PlatformBadge {
  label: string;
}

function isKnownPlatform(platform: string): platform is KnownPlatform {
  return platform === 'javascript' || platform === 'python';
}

export function platformBadge(platform: string | null | undefined): PlatformBadge | null {
  if (!platform) return null;
  return { label: isKnownPlatform(platform) ? knownPlatformRecipe(platform).label : platform };
}
```

Leave `kindBadge().class` alone — `IncidentDetail.vue:265` still uses it.

**Step 4: Rewrite the row component**

Replace `components/incidents/IncidentLedgerRow.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { Incident } from '../../types/api';
import { formatCompactAge, formatDate, safeUrl, GITHUB_PR_URL_OPTIONS } from '../../utils';
import { kindBadge } from '../incident-kind';
import { platformBadge } from '../platform-badge';
import StatusLabel from '../ui/StatusLabel.vue';
import { incidentStatusRecipe } from '../../status-recipes';

const props = defineProps<{
  incident: Incident;
  projectId: string;
}>();

// 'error' is the default kind and describes almost every row, so rendering it
// costs a column and says nothing. Only a deviation earns ink. Friction rows
// keep their marker, including the 'Unchecked' adjudication diagnostic, which
// kindBadge derives from adjudication_status (friction-only per api.ts:139).
const kind = computed(() =>
  props.incident.kind === 'error'
    ? null
    : kindBadge(props.incident.kind, props.incident.adjudication_status),
);
const platform = computed(() => platformBadge(props.incident.platform));
const status = computed(() => incidentStatusRecipe(props.incident.status));
const prUrl = computed(() => safeUrl(props.incident.pr_url, GITHUB_PR_URL_OPTIONS));
</script>

<template>
  <tr class="group border-b border-border last:border-b-0 hover:bg-surface-subtle">
    <td class="min-w-0 px-4 py-4 sm:px-5">
      <router-link
        :to="{ name: 'incident', params: { id: incident.id }, query: { project_id: projectId } }"
        class="block max-w-xl text-sm font-semibold leading-5 text-text decoration-accent underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        v-text="incident.title"
      />
      <div
        v-if="kind || platform"
        class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint"
      >
        <span v-if="kind" data-testid="kind-marker" v-text="kind.label"></span>
        <span v-if="kind && platform" aria-hidden="true">·</span>
        <span v-if="platform" data-testid="platform-marker" v-text="platform.label"></span>
      </div>
    </td>
    <td class="px-4 py-4">
      <a
        v-if="prUrl"
        :href="prUrl"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="pr-link"
        class="inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <StatusLabel :tone="status.tone" :label="status.label" />
      </a>
      <StatusLabel v-else :tone="status.tone" :label="status.label" />
    </td>
    <td class="hidden px-4 py-4 text-right text-sm tabular-nums text-muted sm:table-cell">{{ incident.occurrence_count }}</td>
    <td class="hidden px-4 py-4 text-right text-sm tabular-nums text-muted lg:table-cell">{{ incident.affected_users_count }}</td>
    <td class="hidden px-4 py-4 text-right text-sm tabular-nums text-muted lg:table-cell" data-testid="age">{{ formatCompactAge(incident.first_seen) }}</td>
    <td class="hidden px-4 py-4 text-right text-sm text-muted xl:table-cell" data-testid="last-seen">{{ formatDate(incident.last_seen) }}</td>
  </tr>
</template>
```

`[eng]` The `&& !props.incident.adjudication_status` clause from v2 is gone — `api.ts:139` documents that field as friction-only, so it is unreachable when `kind === 'error'`. The comment now carries the reasoning instead.

`[eng]` `StatusLabel` takes `tone` and `label` and defines only a default slot (`ui/StatusLabel.vue:6-12,36`) — verified, because this repo has shipped a silently-dropped slot in this exact view before.

**Step 5: Write the failing header tests**

Append inside the existing `describe` in `views/__tests__/activity-feed-filters.test.ts`:

```ts
  it('renders header cells matching the row cells, with no Kind column', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    const headers = wrapper.findAll('thead th').map((th) => th.text().replace(/[↑↓]/g, '').trim());
    expect(headers).toEqual(['Title', 'Status', 'Events', 'Users', 'Age', 'Last Seen']);
    expect(wrapper.findAll('tbody tr')[0]?.findAll('td')).toHaveLength(headers.length);

    wrapper.unmount();
  });

  // jsdom does not apply Tailwind media queries, so a plain findAll() count
  // passes regardless of breakpoint classes. Compare the visibility classes
  // column by column instead. Real-width checks live in test-e2e.
  it('keeps header and row breakpoints aligned column by column', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    const visibility = (el: { classes: () => string[] }) =>
      el.classes().filter((c) => c === 'hidden' || /^(sm|md|lg|xl):table-cell$/.test(c)).sort();

    const headers = wrapper.findAll('thead th').map(visibility);
    const cells = wrapper.findAll('tbody tr')[0]!.findAll('td').map(visibility);

    expect(headers).toEqual(cells);
    expect(headers).toEqual([
      [], [],
      ['hidden', 'sm:table-cell'],
      ['hidden', 'lg:table-cell'],
      ['hidden', 'lg:table-cell'],
      ['hidden', 'xl:table-cell'],
    ]);

    wrapper.unmount();
  });

  it('sorts by age when the Age header is clicked', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    const older = incident('old', 'Older issue', 'javascript');
    older.first_seen = '2026-01-01T00:00:00Z';
    const newer = incident('new', 'Newer issue', 'javascript');
    newer.first_seen = '2026-07-01T00:00:00Z';
    mocks.listIncidents.mockResolvedValue([newer, older]);

    const wrapper = mountFeed();
    await flushPromises();

    // Click the button inside the header, not the <th> — sorting is keyboard
    // reachable, so the handler lives on a real control.
    const ageHeader = wrapper.findAll('thead th').find((th) => th.text().includes('Age'))!;
    expect(ageHeader.attributes('aria-sort')).toBe('none');
    await ageHeader.get('button').trigger('click');

    expect(wrapper.findAll('tbody tr')[0]?.text()).toContain('Older issue');
    expect(ageHeader.attributes('aria-sort')).toBe('descending');

    wrapper.unmount();
  });

  // [review] Sorting must not be mouse-only.
  it('exposes each sortable column as a keyboard-reachable button with aria-sort', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    const headers = wrapper.findAll('thead th');
    const sortable = headers.filter((th) => th.find('button').exists());
    expect(sortable).toHaveLength(5); // every column except Title

    for (const th of sortable) {
      expect(th.attributes('aria-sort')).toBeDefined();
      expect(th.get('button').attributes('type')).toBe('button');
    }
    // Exactly one column is the active sort at rest (last_seen, the default).
    expect(headers.filter((th) => th.attributes('aria-sort') === 'descending')).toHaveLength(1);

    wrapper.unmount();
  });
```

**Step 6: Add the `age` sort key**

`ActivityFeed.vue:39`:
```ts
type SortKey = 'last_seen' | 'occurrences' | 'users' | 'status' | 'age';
```

After the `last_seen` comparator (line 48):
```ts
    // Natural ascending sense: older first_seen = larger age = sorts later here.
    // useTableSort negates this on first click (see its DIRECTION INVERSION note),
    // so clicking Age puts the oldest issue on top.
    age: (a, b) => new Date(b.first_seen).getTime() - new Date(a.first_seen).getTime(),
```

`[codex]` v1's comment claimed "oldest-first is ascending age", which is backwards.

**Step 7: Replace the `<thead>` block**

Replace lines 177-213 of `ActivityFeed.vue`:

`[review]` Sortable headers become real `<button>`s inside the `<th>`, and the `<th>` carries `aria-sort`. Keep the `hidden`/`*:table-cell` classes **on the `<th>`** — the breakpoint-matrix test compares those against the row's `<td>`, and moving them to the button would break both the test and the layout.

```vue
        <thead>
          <tr class="border-b border-border bg-surface-subtle">
            <th scope="col" class="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:px-5">
              Title
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('status')"
              class="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted"
            >
              <button type="button" class="inline-flex items-center gap-1 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('status')">
                Status<span aria-hidden="true">{{ sortIndicator('status') }}</span>
              </button>
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('occurrences')"
              class="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:table-cell"
            >
              <button type="button" class="inline-flex items-center gap-1 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('occurrences')">
                Events<span aria-hidden="true">{{ sortIndicator('occurrences') }}</span>
              </button>
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('users')"
              :title="currentFilters.environment_id ? 'users across all environments' : undefined"
              class="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted lg:table-cell"
            >
              <button type="button" class="inline-flex items-center gap-1 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('users')">
                Users<span aria-hidden="true">{{ sortIndicator('users') }}</span>
              </button>
              <span v-if="currentFilters.environment_id" class="block text-[10px] normal-case tracking-normal">
                across all environments
              </span>
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('age')"
              title="Time since this issue was first seen"
              class="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted lg:table-cell"
            >
              <button type="button" class="inline-flex items-center gap-1 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('age')">
                Age<span aria-hidden="true">{{ sortIndicator('age') }}</span>
              </button>
            </th>
            <th
              scope="col"
              :aria-sort="ariaSort('last_seen')"
              class="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-muted xl:table-cell"
            >
              <button type="button" class="inline-flex items-center gap-1 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" @click="toggleSort('last_seen')">
                Last Seen<span aria-hidden="true">{{ sortIndicator('last_seen') }}</span>
              </button>
            </th>
          </tr>
        </thead>
```

Destructure `ariaSort` from `useTableSort` at `ActivityFeed.vue:41`. The `↑`/`↓` glyph is `aria-hidden` because `aria-sort` already conveys direction — otherwise a screen reader reads it twice.

**Step 8: Verify and commit**

```bash
pnpm --filter @opslane/dashboard test
```
Expected: all PASS, including the pre-existing friction test at `activity-feed-filters.test.ts:143` (asserts `'Friction'` present, `'Python'`/`'JavaScript'` absent for a friction row — inline markers preserve both). If it fails, **stop and re-read it** rather than editing the assertion.

```bash
git add packages/dashboard/src
git commit -m "refactor(dashboard): replace the Kind column with a sortable Age column"
```

---

## Task 5: Strip the header chrome, compact the filter bar, cover the non-happy states

**Files:**
- Modify: `views/ActivityFeed.vue:121-130` and the count
- Modify: `components/FilterBar.vue:93-159`
- Modify: `views/__tests__/activity-feed-filters.test.ts`

**Step 1: Write the failing tests**

Append to `views/__tests__/activity-feed-filters.test.ts`:

```ts
  it('renders a single-line header with no eyebrow, subtitle, or record count', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'Boom', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.get('h1').text()).toBe('Issues');
    const header = wrapper.get('header').text();
    expect(header).not.toContain('Incident ledger');
    expect(header).not.toContain('Review current outcomes');
    expect(header).not.toContain('record');

    wrapper.unmount();
  });

  it('labels filters with accessible names rather than visible prefix text', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.text()).not.toContain('Account:');
    expect(wrapper.text()).not.toContain('Status:');
    expect(wrapper.text()).not.toContain('Platform:');
    expect(wrapper.find('select[aria-label="Account"]').exists()).toBe(true);
    expect(wrapper.find('select[aria-label="Status"]').exists()).toBe(true);
    expect(wrapper.find('select[aria-label="Platform"]').exists()).toBe(true);

    wrapper.unmount();
  });

  // [eng] The Environment filter is conditional on rollupReady. Nothing covered it.
  it('hides the Environment filter until the environment rollup is ready', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    // Default fixture has no environments, so rollupReady is false.
    expect(wrapper.find('select[aria-label="Environment"]').exists()).toBe(false);

    wrapper.unmount();
  });

  // [eng] Singular/plural on the relocated count line.
  it('renders the count line in singular for one issue and plural otherwise', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([incident('a', 'One', 'javascript')]);

    let wrapper = mountFeed();
    await flushPromises();
    expect(wrapper.text()).toContain('1 issue');
    expect(wrapper.text()).not.toContain('1 issues');
    wrapper.unmount();

    mocks.listIncidents.mockResolvedValue([
      incident('a', 'One', 'javascript'),
      incident('b', 'Two', 'javascript'),
    ]);
    wrapper = mountFeed();
    await flushPromises();
    expect(wrapper.text()).toContain('2 issues');
    wrapper.unmount();
  });

  // [eng] Non-happy states were entirely untested. This view has shipped a
  // silently-dropped EmptyState slot before, with the whole suite green.
  it('renders the empty state, including its Setup guide action, when there are no issues', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.text()).toContain('No issues yet');
    expect(wrapper.text()).toContain('Setup guide');
    expect(wrapper.find('table').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders an error alert when the fetch fails', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockRejectedValue(new Error('boom'));

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.text()).toContain('Unable to load issues');
    expect(wrapper.text()).toContain('boom');
    expect(wrapper.find('table').exists()).toBe(false);

    wrapper.unmount();
  });

  it('renders skeleton rows while loading', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockImplementation(() => new Promise(() => {}));

    const wrapper = mountFeed();
    await flushPromises();

    expect(wrapper.get('[role="status"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.find('table').exists()).toBe(false);

    wrapper.unmount();
  });
```

All assertions use the final strings. Step 3b in this same task changes them, so there is no intermediate state where the header and the empty state disagree.

**Step 2: Run to confirm they fail**

```bash
pnpm --filter @opslane/dashboard exec vitest run src/views/__tests__/activity-feed-filters.test.ts
```
Expected: FAIL on `h1`, `Account:`, the count line, and the Environment filter.

**Step 3: Replace the header**

Lines 121-130 of `ActivityFeed.vue`:

```vue
    <header class="mb-6 border-b border-border pb-4">
      <h1 class="text-2xl font-semibold tracking-tight text-text">Issues</h1>
    </header>
```

**Step 3b: Change every other user-visible string on this screen**

The `<h1>` cannot say "Issues" while the rest of the screen says "incidents". All of these move together, in this task:

| File | Line | Current | New |
|---|---|---|---|
| `ActivityFeed.vue` | 67 | `Failed to load incidents: ${msg}` | `Failed to load issues: ${msg}` |
| `ActivityFeed.vue` | 143 | `new incident{{ … }} — click to refresh` | `new issue{{ … }} — click to refresh` |
| `ActivityFeed.vue` | 150 | `aria-label="Loading incident ledger"` | `aria-label="Loading issues"` |
| `ActivityFeed.vue` | 161 | `title="Unable to load incidents"` | `title="Unable to load issues"` |
| `ActivityFeed.vue` | 166 | `title="No incidents yet"` | `title="No issues yet"` |
| `ActivityFeed.vue` | 176 | `aria-label="Production incidents"` | `aria-label="Issues"` |
| `layout/navigation.ts` | 9 | `label: 'Incidents'` | `label: 'Issues'` |
| `layout/AppRail.vue` | 29-31 | "Incident ledger" subtitle | delete — the nav below already says "Issues" |
| `IncidentDetail.vue` | 237, 255 | `Back to incidents` | `Back to issues` |

`IncidentDetail.vue` is a different screen, but those two links *name this list*, so they go stale the moment the nav says "Issues". Change **only** `label` in `navigation.ts`. Leave `routeName: 'activity'` alone; that is PR 2's job and touching it here breaks four tests.

**Step 3c: Update all three e2e screenshot identities**

`[review]` `test-e2e/dashboard-screenshots.test.ts` waits on **three** strings this task deletes, not one. All three break in this PR, not the next:

| Line | Fixture | Current identity | New |
|---|---|---|---|
| 61 | `activity-success-mock` | `/Production incidents/i` | `/^Issues$/i` |
| ~71 | `activity-empty-mock` | `/No incidents yet/i` | `/No issues yet/i` |
| ~72 | `activity-error-mock` | `/Unable to load incidents/i` | `/Unable to load issues/i` |

Read the file and confirm the line numbers before editing — the last two sit under a comment about the zero-incident and failed-load branches.

`/^Issues$/i` is anchored on purpose: an unanchored `/Issues/i` would also match the sidebar nav entry, so the assertion would pass even if the heading never rendered.

**Step 3d: Run the screenshot suite the way it actually runs**

`[review]` The suite is gated: `dashboard-screenshots.test.ts:14` reads `CAPTURE_DASHBOARD_SCREENSHOTS`, and `:17` is `describe.skipIf(!browserAvailable || !captureEnabled)`. `pnpm --filter @opslane/test-e2e test` **skips all 46 screenshot tests silently** while running unrelated live suites that fail without infrastructure. Verified.

```bash
CAPTURE_DASHBOARD_SCREENSHOTS=1 \
  pnpm --filter @opslane/test-e2e exec vitest run dashboard-screenshots.test.ts
```

Confirm the run reports passing tests, not skipped ones. A skipped suite is not a green suite.

**Step 3e: Add the responsive alignment assertions — in their own non-capture test file** `[eng]` `[review]`

jsdom counts `hidden lg:table-cell` cells as present, so column alignment is the one thing unit tests cannot prove — and the columns being asserted are the ones Task 4 just built, so this belongs here rather than in PR 2.

**Do not put these assertions in `dashboard-screenshots.test.ts`.** That file is gated on `CAPTURE_DASHBOARD_SCREENSHOTS=1` (`:14,17`), so a correctness check living there silently does not run in any normal test invocation. Screenshot *generation* is a debugging aid; column alignment is a correctness property, and the two should not share a kill switch.

Create `test-e2e/issue-list-columns.test.ts`, gated only on browser availability, reusing the same harness and `activity-success-mock` fixture that `dashboard-screenshots.test.ts` already builds. At 640, 1024, and 1280 px: set the viewport, then assert the number of visible `thead th` equals the number of visible `tbody tr:first-child td`, and that each visible header sits at the same column index as its cell.

Use real visibility (`getBoundingClientRect().width > 0` or the framework's visibility check), not a class-name test — a class test here would just duplicate the jsdom test and prove nothing new.

**Do not trust a hardcoded expected count from this plan.** Observe the rendered page on first run and encode what you see. The breakpoint that applies at exactly 640px is the kind of off-by-one a plan-supplied number gets wrong.

**Step 4: Move the count below the table**

After the closing `</table>` and its wrapping `</div>`, as a sibling inside the root `<div>`:

```vue
    <p v-if="!loading && !error && incidents.length > 0" class="mt-3 text-xs text-muted">
      {{ incidents.length }} issue{{ incidents.length === 1 ? '' : 's' }}
    </p>
```

**Step 5: Rewrite the FilterBar template**

Replace lines 93-159 of `FilterBar.vue`:

```vue
<template>
  <div class="flex flex-wrap items-center gap-2 py-3">
    <select
      v-model="selectedAccountId"
      aria-label="Account"
      class="text-sm rounded-md border border-border bg-surface pl-3 pr-8 py-1.5"
    >
      <option value="">All accounts</option>
      <option
        v-for="account in accounts"
        :key="account.external_account_id"
        :value="account.external_account_id"
        v-text="account.account_name || account.external_account_id"
      ></option>
    </select>

    <select
      v-model="selectedStatus"
      aria-label="Status"
      class="text-sm rounded-md border border-border bg-surface pl-3 pr-8 py-1.5"
    >
      <option value="">All statuses</option>
      <option value="new">New</option>
      <option value="queued">Queued</option>
      <option value="analyzing">Analyzing</option>
      <option value="pr_draft">Draft PR</option>
      <option value="pr_created">PR Created</option>
      <option value="merged">Merged</option>
      <option value="needs_human">Needs Human</option>
      <option value="resolved">Resolved</option>
      <option value="archived">Archived</option>
    </select>

    <select
      v-model="selectedPlatform"
      aria-label="Platform"
      class="text-sm rounded-md border border-border bg-surface pl-3 pr-8 py-1.5"
    >
      <option value="">All platforms</option>
      <option value="javascript">JavaScript</option>
      <option value="python">Python</option>
    </select>

    <select
      v-if="rollupReady"
      v-model="selectedEnvironmentId"
      aria-label="Environment"
      class="text-sm rounded-md border border-border bg-surface pl-3 pr-8 py-1.5"
    >
      <option value="">All environments</option>
      <option
        v-for="environment in environments"
        :key="environment.id"
        :value="environment.id"
        v-text="environment.name"
      ></option>
    </select>
  </div>
</template>
```

Every select carries an `aria-label` — that is what replaces the deleted visible `<label>` for screen-reader users. Do not skip them.

**Step 6: Verify and commit**

```bash
pnpm --filter @opslane/dashboard test
pnpm --filter @opslane/dashboard build
CAPTURE_DASHBOARD_SCREENSHOTS=1 \
  pnpm --filter @opslane/test-e2e exec vitest run dashboard-screenshots.test.ts
pnpm --filter @opslane/test-e2e exec vitest run issue-list-columns.test.ts

git add packages/dashboard/src test-e2e
git commit -m "refactor(dashboard): cut header chrome, compact filters, cover non-happy states"
```

`[review]` `git add` must include `test-e2e` — this task edits three identities there and adds a file. Staging only `packages/dashboard/src` would leave the screenshot suite broken and uncommitted.

Expected: all PASS, and the screenshot run must report **passing**, not skipped. The stale-response test at `:102` already selects by `select[aria-label="Platform"]` and keeps working. Task 1's chevron test still passes (`pr-8` retained).

**PR 1 ends here. Open it, get it reviewed, merge it, then start PR 2.**

---

# PR 2 — Rename to "Issues"

## Task 6: Rename the user-visible noun

One screen currently has seven names: file `ActivityFeed.vue`, route `activity`, nav "Incidents", rail subtitle "Incident ledger", eyebrow "INCIDENT LEDGER", title "Production incidents", count "1 record".

**Scope boundary.** Rename user-visible strings, the list route, and the list view/row filenames. **Do not** rename the `Incident` TypeScript type, `listIncidents()`, `IncidentDetail.vue`, `/api/v1/` paths, or the `incident` route name.

**`vue-tsc` will not catch this rename.** `[codex]` Route names are plain strings, so a stale `{ name: 'activity' }` typechecks and fails at runtime. Work from the tables below, not from the compiler.

**Every `'activity'` reference — 10 hits, 7 files, grep-verified:**

| File | Line | What |
|---|---|---|
| `src/router.ts` | 23 | route definition |
| `src/router.ts` | 49 | post-login redirect target |
| `src/App.vue` | 140 | **mobile header logo link** — missed in v1; would target a nonexistent route |
| `src/components/layout/AppRail.vue` | 24 | desktop logo link |
| `src/components/layout/navigation.ts` | 9 | nav item `routeName` |
| `src/components/layout/navigation.test.ts` | 6 | test lookup by `routeName` |
| `src/components/layout/__tests__/app-navigation.test.ts` | 15, 65, 70 | router stub paths + a comment |
| `src/route-project.test.ts` | 11 | `routeNeedsProject('activity')` |

**No user-visible text changes in this PR.** `[eng]` Every string a person reads — the heading, empty state, error, loading label, refresh banner, nav label, rail subtitle, and the detail page's "Back to issues" — already changed in PR 1 Task 5 Step 3b. This task is invisible from the UI. If you find yourself editing a string a user can see, it belongs in the other PR.

**Files:**
- Rename: `views/ActivityFeed.vue` → `views/IssuesList.vue`
- Rename: `components/incidents/IncidentLedgerRow.vue` → `components/incidents/IssueRow.vue`
- Rename: `views/__tests__/activity-feed-filters.test.ts` → `views/__tests__/issues-list-filters.test.ts`
- Rename: `components/incidents/incident-row.test.ts` → `components/incidents/issue-row.test.ts`
- Modify: every file in the `'activity'` reference table above
- Create: `src/components/layout/__tests__/issues-route.test.ts`
- Create: `src/router.test.ts` `[eng]`

**Step 1: Write the failing tests**

Create `src/components/layout/__tests__/issues-route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { APP_NAVIGATION, isNavigationItemActive } from '../navigation';

describe('issues navigation', () => {
  it('labels the primary list "Issues" and routes it to "issues"', () => {
    expect(APP_NAVIGATION[0]).toMatchObject({ label: 'Issues', routeName: 'issues' });
  });

  // Regression guard, not a red-first test: this already passes today.
  it('keeps the detail route highlighted under the Issues nav item', () => {
    expect(isNavigationItemActive(APP_NAVIGATION[0]!, 'incident')).toBe(true);
  });
});
```

`[eng]` Create `src/router.test.ts` — nothing covered the redirect shim, and a bookmark that loses `?project_id` silently resolves against `localStorage` and can show the wrong project (`utils.ts:17-24`).

**It must test the production route table, not a copy of it.** `[review]` An earlier draft rebuilt the routes inside the test, including the exact redirect under test. That test stays green if `router.ts` never gets the redirect at all — it asserts that vue-router works, not that this app is configured correctly.

First extract the route table in `router.ts` so a test can import it. `router.ts:15-33` currently inlines it into `createRouter`:

```ts
export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: Login, meta: { public: true } },
  // ... every existing entry, unchanged ...
  { path: '/', name: 'issues', component: IssuesList },
  { path: '/issues/:id', name: 'incident', component: IncidentDetail },
  // Pre-rename links still resolve. vue-router 4 carries the query across a
  // params-only function redirect (see src/router.test.ts).
  { path: '/incidents/:id', redirect: (to) => ({ name: 'incident', params: to.params }) },
  // ...
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({ history: createWebHistory(), routes });
```

Import `type { RouteRecordRaw }` from `vue-router`. Nothing else about `router.ts` changes — `beforeEach` and the rest stay put.

Then the test builds a memory-history router over **those** routes:

```ts
import { describe, expect, it } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import { routes } from './router';

// Same route table the app ships; only the history mode differs, because
// createWebHistory needs a real browser location. Rebuilding the routes here
// would make this test assert that vue-router works, not that we wired it up.
function testRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

describe('pre-rename detail links', () => {
  it('redirects /incidents/:id to /issues/:id', async () => {
    const router = testRouter();
    await router.push('/incidents/abc');
    expect(router.currentRoute.value.name).toBe('incident');
    expect(router.currentRoute.value.path).toBe('/issues/abc');
    expect(router.currentRoute.value.params['id']).toBe('abc');
  });

  // getProjectId() reads ?project_id first and falls back to localStorage, so
  // dropping the query on redirect would silently scope a shared link to
  // whatever project the viewer last had open.
  it('preserves the project_id query across the redirect', async () => {
    const router = testRouter();
    await router.push('/incidents/abc?project_id=proj-42');
    expect(router.currentRoute.value.fullPath).toBe('/issues/abc?project_id=proj-42');
    expect(router.currentRoute.value.query['project_id']).toBe('proj-42');
  });

  it('routes / to the issues list', async () => {
    const router = testRouter();
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('issues');
  });
});
```

Importing `routes` pulls in the view components, so this test needs `// @vitest-environment jsdom` at the top. If the lazy `import()` routes make that awkward, the fallback is to assert against `router.resolve()` on the real table rather than pushing — still the production routes, no copy.

**Step 2: Run to confirm they fail**

```bash
pnpm --filter @opslane/dashboard exec vitest run src/components/layout/__tests__/issues-route.test.ts
```
Expected: FAIL — label is `'Incidents'`, routeName is `'activity'`. (`router.test.ts` passes immediately; it is a guard against a redirect shim written without query forwarding.)

**Step 3: Rename files with git so history follows**

```bash
git mv packages/dashboard/src/views/ActivityFeed.vue \
       packages/dashboard/src/views/IssuesList.vue
git mv packages/dashboard/src/components/incidents/IncidentLedgerRow.vue \
       packages/dashboard/src/components/incidents/IssueRow.vue
git mv packages/dashboard/src/views/__tests__/activity-feed-filters.test.ts \
       packages/dashboard/src/views/__tests__/issues-list-filters.test.ts
git mv packages/dashboard/src/components/incidents/incident-row.test.ts \
       packages/dashboard/src/components/incidents/issue-row.test.ts
```

**Step 4: Update the route and every reference**

`navigation.ts:9` — `label` is already `'Issues'` from PR 1; change only `routeName`:
```ts
  { label: 'Issues', routeName: 'issues', relatedRoutes: ['incident'] },
```

`router.ts` — import, route table, login redirect:
```ts
import IssuesList from './views/IssuesList.vue';
```
```ts
    { path: '/', name: 'issues', component: IssuesList },
    { path: '/issues/:id', name: 'incident', component: IncidentDetail },
    // Pre-rename links still resolve. vue-router 4 carries the query across a
    // params-only function redirect (verified; see src/router.test.ts).
    // Remove once no bookmarks point here.
    { path: '/incidents/:id', redirect: (to) => ({ name: 'incident', params: to.params }) },
```
and line 49: `{ name: 'activity' }` → `{ name: 'issues' }`.

`App.vue:140` and `AppRail.vue:24`: `:to="{ name: 'activity' }"` → `:to="{ name: 'issues' }"`.

`navigation.test.ts:6`, `app-navigation.test.ts:15,65,70`, `route-project.test.ts:11`: `'activity'` → `'issues'`.

`IssuesList.vue`: update the row import to `import IssueRow from '../components/incidents/IssueRow.vue';` and the template tag to `<IssueRow`. No string changes — those all landed in PR 1.

Test files: update imports, `mount()` calls, and `describe` titles only.

**Step 5: Verify no reference survives**

```bash
grep -rn "'activity'" packages/dashboard/src
```
Expected: zero output.

Also confirm PR 1 left nothing behind, which should already be clean:

```bash
grep -rni "incident ledger\|production incidents\|no incidents yet\|back to incidents" packages/dashboard/src test-e2e
```
Expected: zero output. If this one is *not* clean, PR 1 was incomplete — fix it there rather than absorbing it here, or the two PRs stop meaning what they say.

**Step 6: Typecheck, test, commit**

```bash
pnpm --filter @opslane/dashboard build
pnpm --filter @opslane/dashboard test
CAPTURE_DASHBOARD_SCREENSHOTS=1 \
  pnpm --filter @opslane/test-e2e exec vitest run dashboard-screenshots.test.ts
pnpm --filter @opslane/test-e2e exec vitest run issue-list-columns.test.ts

git add -A packages/dashboard/src test-e2e
git commit -m "refactor(dashboard): rename the incident list to Issues"
```
`vue-tsc` catches stale *imports*; the grep in Step 5 catches stale *route-name strings*. Both are required.

PR 2 changes the `/incidents/incident-1` screenshot route to `/issues/incident-1`, so `dashboard-screenshots.test.ts:62` needs updating here even though no user-visible string changes. Check it.

---

## NOT in scope

| Deferred | Rationale |
|---|---|
| **Culprit / file path on the row** | `error_groups` (`packages/ingestion/db/migrations/001_baseline.sql:74`) stores none. Raw material exists (`sample_event_id` → `error_events.stack_trace_raw`, parser at `worker/src/source-map.ts:29`) but needs a migration, a top-in-app-frame heuristic, and an API field |
| **Enterprise GitHub PR links** | Dashboard cannot see the worker's `OPSLANE_GITHUB_URL`. Degrades to plain text, never unsafe. `TODOS.md` |
| **Replacing the 30s full-list poller** | Needs a Go count endpoint; this plan is dashboard-only. `TODOS.md` |
| **Tests for `safeUrl`'s 4 pre-existing call sites** | PR 1 tests the function and hardens it; asserting each view calls it is a separate pass. `TODOS.md` |
| **Migrating filters to `SelectField`** | Its grid `<label>` wrapper forces a filter-row relayout plus 4 unrelated restyles — scope growth on a bug fix |
| **Renaming `Incident` type / `listIncidents()` / `/api/v1/`** | Backend-facing; turns a reviewable diff into a sprawling one |
| **Pagination, search, saved views, sparklines, assignees** | Not required to make the current screen scannable |
| **rrweb bundle split** | Real (194KB on every route incl. `/login`) but unrelated to this change |

---

## Failure modes

| New codepath | Realistic production failure | Test? | Error handling? | User sees |
|---|---|---|---|---|
| `safeUrl(pr_url, GITHUB)` | Enterprise host → link suppressed | Yes (non-github case) | By design | Plain badge, no error. **Silent but intended** |
| `safeUrl(trace_url)` default | https-only tightening kills http Langfuse | **Yes — mandatory regression test** | N/A | Would be a silent dead link. Guarded |
| `formatCompactAge` | Clock skew → negative age | Yes | Clamps to `0s` | `0s` |
| `formatCompactAge` | Malformed `first_seen` | Yes | Returns `—` | `—` |
| Age comparator | Direction inverted by `useTableSort` | Yes | N/A | Wrong sort order. Guarded by test + inline diagram |
| Header/row breakpoint drift | Columns shear at 1024px | Yes (class matrix + e2e widths) | N/A | Misaligned table |
| Redirect shim | Query dropped → wrong project shown | **Yes** (`router.test.ts`) | N/A | Would be silent and wrong. Guarded |
| Stale `{ name: 'activity' }` | Mobile logo targets dead route | Yes (`app-navigation.test.ts`) + grep gate | vue-router warns | Dead link |
| EmptyState slot drop | Setup guide button vanishes | **Yes** (new empty-state test) | N/A | Would be silent. Guarded |

**Critical gaps (no test AND no error handling AND silent): 0.** The two that would have been silent — the http trace regression and the redirect query drop — now have tests.

---

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| T1 chevron padding | `components/`, `views/Settings.vue`, `src/` (test) | — |
| T2 `formatCompactAge` | `src/utils.ts`, `src/__tests__/` | — |
| T3 `safeUrl` hardening | `src/utils.ts`, `views/`, `components/` | — |
| T4 row + header | `components/incidents/`, `views/`, `composables/` | T2, T3 |
| T5 header, filters, all user-visible strings | `views/`, `components/FilterBar.vue`, `components/layout/`, `test-e2e/` | T4 |
| T6 route and file rename | `router.ts`, `views/`, `components/layout/`, test route strings | T1-T5 (separate PR) |

**Lanes:**
- **Lane A:** T2 → T3 (sequential, both own `src/utils.ts`)
- **Lane B:** T1 (independent — padding only, no logic)
- **Lane C:** T4 → T5 → T6 (sequential, shared `views/`)

**Execution order:** Launch A and B in parallel worktrees. Merge both. Then run C.

**Conflict flag:** Lane B (T1) and Lane C (T5) both touch `components/FilterBar.vue` — T1 edits the `class` attributes, T5 replaces the whole template. Land T1 first and have T5 rebase onto it, or simply run T1 → T5 sequentially and skip the parallelism, which is the safer call for a two-hour change.

---

## Final verification

**The repository gate, from `AGENTS.md:24`:** `[codex]` v1 omitted the Go and Compose checks and invented a `packages/ingestion/cmd/migrate` that does not exist.

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

**Plus the e2e suites, which `pnpm test` deliberately excludes and which are themselves gated:**

```bash
CAPTURE_DASHBOARD_SCREENSHOTS=1 \
  pnpm --filter @opslane/test-e2e exec vitest run dashboard-screenshots.test.ts
pnpm --filter @opslane/test-e2e exec vitest run issue-list-columns.test.ts
```

`[review]` Two separate gates hide these. `pnpm test` is `test:repo && test:unit`, and `test:unit` is `pnpm -r --filter '!@opslane/test-e2e' test` — the package is excluded. Then within the package, `dashboard-screenshots.test.ts:17` is `describe.skipIf(!browserAvailable || !captureEnabled)`, so even `pnpm --filter @opslane/test-e2e test` skips all 46 of its tests silently while running unrelated live suites that fail without infrastructure. **Confirm these runs report passing tests, not skipped ones.**

**Live check.** Migrations run through the Compose `migrate` service (`docker-compose.yml:140`), not a Go binary:

```bash
docker compose up -d postgres migrate ingestion
docker compose logs migrate
docker compose exec -T postgres psql -U opslane -d opslane -f /dev/stdin < scripts/seed-e2e.sql
pnpm --filter @opslane/dashboard dev
```

The dashboard requires authentication before the list renders. Either sign in, or reuse the `activity-success-mock` fixture harness from `test-e2e/dashboard-screenshots.test.ts`.

Confirm by eye:

1. No select chevron sits on its own text — all four filters, plus Settings and the org/project/repo pickers, at a narrow window
2. Header is one line: "Issues"
3. No 32-character hash on any row
4. Relative time appears once per row
5. A `pr_draft` row's status badge opens the GitHub PR in a new tab
6. Columns line up at 640px, 1024px, 1280px
7. A friction issue still shows its "Friction" marker
8. `/admin` trace links still work (the `safeUrl` regression surface)
9. The mobile header logo (under 768px) navigates to the list
10. Empty state shows its **Setup guide** button

Capture a screenshot at 1280px for the PR description.

---

## Implementation Tasks

Synthesized from this review's findings. Each derives from a specific finding above.

- [ ] **T1 (P1, human: ~3h / CC: ~25min)** — `utils.ts` — Harden `safeUrl` with an exact host allowlist and delete the planned `safePrUrl`
  - Surfaced by: Architecture review — a second URL validator on a boundary that already has one (`utils.ts:34`, 15 calls across 9 files, zero tests)
  - Files: `src/utils.ts`, `src/__tests__/safe-url.test.ts`, `views/IncidentDetail.vue`, `views/AdminView.vue`, `components/incidents/IncidentConclusion.vue`, `views/SetupWizard.vue`
  - Verify: `pnpm --filter @opslane/dashboard exec vitest run src/__tests__/safe-url.test.ts`
- [ ] **T2 (P1, human: ~30min / CC: ~5min)** — `utils.ts` — Regression test proving `http:` trace URLs still pass
  - Surfaced by: Test review — IRON RULE; `LANGFUSE_BASE_URL` is operator-configurable (`docker-compose.yml:119`)
  - Files: `src/__tests__/safe-url.test.ts`
  - Verify: same command; the http case must pass
- [ ] **T3 (P1, human: ~1h / CC: ~10min)** — `router.ts` — Test the `/incidents/:id` redirect preserves `?project_id`
  - Surfaced by: Test review — `getProjectId()` falls back to localStorage, so a dropped query silently scopes to the wrong project
  - Files: `src/router.test.ts`
  - Verify: `pnpm --filter @opslane/dashboard exec vitest run src/router.test.ts`
- [ ] **T4 (P1, human: ~2h / CC: ~15min)** — `views/` — Merge the row and header rewrites into one commit
  - Surfaced by: Codex review — v2 committed a table whose header and body disagreed
  - Files: `components/incidents/IncidentLedgerRow.vue`, `views/ActivityFeed.vue`
  - Verify: `pnpm --filter @opslane/dashboard test`
- [ ] **T5 (P2, human: ~2h / CC: ~15min)** — `views/` — Cover empty, loading, and error states plus the count line
  - Surfaced by: Test review — user-flow coverage was 30%; this view has shipped a silently-dropped slot before
  - Files: `views/__tests__/activity-feed-filters.test.ts`
  - Verify: `pnpm --filter @opslane/dashboard test`
- [ ] **T6 (P2, human: ~2h / CC: ~15min)** — `test-e2e/` — Assert column alignment at 640/1024/1280, and move the screenshot identity to PR 1
  - Surfaced by: Test review — jsdom counts hidden cells as visible, so alignment is unprovable in unit tests. Outside-voice pass then caught that the identity regex breaks in PR 1, not PR 2, because PR 1 is what deletes "Production incidents"
  - Files: `test-e2e/dashboard-screenshots.test.ts`
  - Verify: `pnpm --filter @opslane/test-e2e test`
- [ ] **T11 (P1, human: ~1h / CC: ~10min)** — PR boundary — Move every user-visible string into PR 1 so `main` is never half-renamed
  - Surfaced by: Outside-voice pass — an `<h1>` reading "Issues" over an empty state reading "No incidents yet" and a sidebar reading "Incidents"
  - Files: `views/ActivityFeed.vue`, `components/layout/navigation.ts`, `components/layout/AppRail.vue`, `views/IncidentDetail.vue`, `test-e2e/dashboard-screenshots.test.ts`
  - Verify: after PR 1, `grep -rni "incident ledger\|production incidents\|no incidents yet\|back to incidents" packages/dashboard/src test-e2e` returns nothing
- [ ] **T12 (P2, human: ~30min / CC: ~8min)** — `views/` — Bind PR link text to the validated URL, not the raw one
  - Surfaced by: Outside-voice pass — `safeUrl` now returns a normalized URL while `IncidentDetail.vue:427` still renders `v-text="incident.pr_url"`, so the visible text and the href can disagree
  - Files: `views/IncidentDetail.vue`, `views/AdminView.vue`, `views/SetupWizard.vue`
  - Verify: `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build`
- [ ] **T13 (P1, human: ~3h / CC: ~15min)** — `views/` — Split the empty state into unfiltered and filtered variants
  - Surfaced by: Design review Pass 2 — one empty state serves two situations, so a filtered customer is told their SDK is not reporting and sent to the setup guide
  - Files: `views/ActivityFeed.vue`, `views/__tests__/activity-feed-filters.test.ts`, `components/FilterBar.vue` (reset)
  - Verify: `pnpm --filter @opslane/dashboard exec vitest run src/views/__tests__/activity-feed-filters.test.ts`
- [ ] **T14 (P1, human: ~1 day / CC: ~30min)** — `components/`, `test-e2e/` — Stacked mobile layout below 640px plus a mobile sort control
  - Surfaced by: Design review Pass 6 and 7 — the phone view is an unchosen two-column table, and the stacked layout that replaces it removes the only sort affordance
  - Files: `components/incidents/IncidentLedgerRow.vue`, `views/ActivityFeed.vue`, `components/FilterBar.vue`, `test-e2e/issue-list-columns.test.ts`
  - Verify: `pnpm --filter @opslane/test-e2e exec vitest run issue-list-columns.test.ts`
- [ ] **T15 (P2, human: ~2h / CC: ~10min)** — `components/` — Make a linked status pill look linked
  - Surfaced by: Design review Pass 3 — a clickable Draft PR badge and an inert Analyzing badge are pixel-identical, hiding the product's best moment
  - Files: `components/incidents/IncidentLedgerRow.vue`, `components/incidents/incident-row.test.ts`
  - Verify: `pnpm --filter @opslane/dashboard exec vitest run src/components/incidents/incident-row.test.ts`
- [ ] **T16 (P2, human: ~2h / CC: ~10min)** — `views/`, `components/` — Default sort to users affected; show the platform marker only when platforms vary
  - Surfaced by: Design review Pass 1 — the default order was inherited, and the second line repeats the same word on every row of a single-platform project
  - Files: `views/ActivityFeed.vue`, `components/incidents/IncidentLedgerRow.vue`
  - Verify: `pnpm --filter @opslane/dashboard test`
- [ ] **T17 (P2, human: ~3h / CC: ~15min)** — `views/`, `components/` — Align to approved mockup: thousands separators, bordered container, filter icons, 44px touch targets
  - Surfaced by: Design review Pass 5 and 6 — the plan contradicts the mockup it approved, and the filter selects are ~32px against a 44px touch minimum
  - Files: `components/incidents/IncidentLedgerRow.vue`, `views/ActivityFeed.vue`, `components/FilterBar.vue`
  - Verify: `pnpm --filter @opslane/dashboard test`

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| Issue list | `~/.gstack/projects/opslane-opslane-oss/designs/issue-list-20260722/variant-C.png` | Bordered rounded table container inset from the page edge, row-end chevron, titles wrapping to 2 lines, filter dropdowns with leading icons, right-aligned numbers with thousands separators | Rated 5/5 (A=3, B=4). Its title-only rows are superseded by Design decision D1 — the marker line survives where it carries meaning. Its invented statuses (Investigating, Monitoring, Ignored) and purple Draft PR pill are **not** our vocabulary; use `status-recipes.ts` and the Forensic Ledger tones |
- [ ] **T7 (P2, human: ~45min / CC: ~10min)** — `composables/`, `docs/` — Add the data-flow and sort-inversion diagrams
  - Surfaced by: Architecture review — the direction inversion already produced one bug in this plan
  - Files: `composables/useTableSort.ts`, this plan
  - Verify: read it back; confirm the comparator comment matches observed sort order
- [ ] **T8 (P2, human: ~30min / CC: ~8min)** — `components/` — Delete `platformBadge().class`, its stale comment, and the unreachable kind guard; move the chevron test beside `tailwind-token.test.ts`
  - Surfaced by: Code quality review — `.class` drops to zero consumers; its comment describes a deleted layout
  - Files: `components/platform-badge.ts`, `components/incidents/IncidentLedgerRow.vue`, `src/select-chevron-clearance.test.ts`
  - Verify: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`
- [ ] **T9 (P2, human: ~1h / CC: ~10min)** — `views/`, `components/` — Add the Environment-filter and non-github-URL branch tests
  - Surfaced by: Test review — both branches were uncovered
  - Files: `views/__tests__/activity-feed-filters.test.ts`, `components/incidents/incident-row.test.ts`
  - Verify: `pnpm --filter @opslane/dashboard test`
- [ ] **T10 (P3, human: ~15min / CC: ~5min)** — repo root — Record the poller, Enterprise-host, and call-site-test follow-ups
  - Surfaced by: Performance review + scope decisions
  - Files: `TODOS.md`
  - Verify: file exists with three entries

---

## Risks

| Risk | Mitigation |
|---|---|
| Header/row breakpoints drift, shearing columns | Class-matrix unit test compares element by element; e2e asserts three real widths |
| Hardening `safeUrl` breaks http trace links | Default left permissive; mandatory regression test |
| `/` route rename breaks a deep link | Redirect shim + `router.test.ts` proving query survives; `router.ts:31` already catch-alls |
| A stale `'activity'` route string ships | `vue-tsc` cannot see it — the Task 6 Step 5 grep and `app-navigation.test.ts` are the real gates |
| Enterprise PR links stop rendering as links | Known, accepted, tracked in `TODOS.md`; degrades to plain text, never unsafe |
| e2e suite is outside the default gate | Called out as a separate command; Task 6 Steps 5-6 both touch it |
| Chevron test greps source and could miss a dynamic select | Accepted: none exist today; `SelectField.vue` is the sanctioned path for new ones |
| Lane B (T1) and Lane C (T5) both touch `FilterBar.vue` | T1 edits its `class` attributes, T5 replaces its template. Land T1 first, or run them sequentially — the safer call for a change this size. PR 2 does not touch this file |

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 14 findings, 14/14 fixed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 5 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean (FULL) | score: 5/10 → 9/10, 8 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**CODEX:** All 11 P1 and 3 P2 findings verified against the codebase and fixed in v2 — select-scan undercount (9 not 5), `formatCompactAge` returning `0y` for 360-364 days, a `startsWith('github.')` allowlist accepting `github.evil.com`, a `not.toContain('Error')` assertion that could never pass against a `TypeError` fixture, five tests green before implementation, a Task 4/5 split that committed a broken table, four missed `'activity'` route references including the mobile logo link, six unrenamed user-visible strings, a stale e2e screenshot identity outside the default test gate, an invented `packages/ingestion/cmd/migrate`, an overstated Tailwind cascade claim, a jsdom breakpoint test that could not fail, and a backwards age-sort comment.

**ENG:** 5 findings, all folded into v3 — the plan was adding a second URL validator beside the existing `safeUrl` (now consolidated, hardened, and tested across all 5 call sites); no data-flow diagram despite a stale-response guard and a sort-direction inversion that had already caused one bug (both now drawn, plus an inline note in `useTableSort`); dead `platformBadge().class` and a comment describing a deleted layout (removed); user-flow test coverage at 30% (10 gaps closed, including empty/loading/error states and real-browser column alignment); and a 30s full-list poller (deferred to `TODOS.md` with context). One regression was caught and guarded under the IRON RULE without a decision: making `safeUrl` https-only by default would have silently killed `AdminView` trace links for self-hosted Langfuse over http.

**OUTSIDE VOICE:** Codex timed out twice on the v3 plan (330s and a tighter retry still buffering at review close), so the three questions posed to it were verified directly instead. Two were real and are fixed in v3:
1. **The PR split left `main` half-renamed.** PR 1 changed the `<h1>` to "Issues" while the empty state said "No incidents yet" and the sidebar said "Incidents". It also broke `test-e2e/dashboard-screenshots.test.ts:61` one PR earlier than the plan said to update it. The split line is now "does a user see it", not "is it a rename" — PR 1 owns every user-visible string, PR 2 is invisible from the UI.
2. **Normalizing `safeUrl`'s return desyncs the PR link.** `IncidentDetail.vue:427` renders `v-text="incident.pr_url"` (raw) while the href comes from `safeUrl` (now normalized). On a link whose purpose is proving where it goes, text and destination must not disagree. Both now bind the validated value.
3. **The protocol condition was correct but unreadable.** Truth table verified by execution: `https` always passes, `http` only when `httpsOnly` is false, everything else always rejected. Rewritten as an explicit allowlist anyway.

**CROSS-MODEL:** No tension. The three passes found disjoint problem classes. Codex caught arithmetic, assertion, and reference errors inside the plan as written. The eng review caught what the plan never asked about — an existing validator, an existing regression surface, untested user flows. The outside-voice questions caught what both missed: the seam between the two PRs. Notably Codex reviewed the `safePrUrl` allowlist logic in detail and never asked whether a sanitizer already existed.

**HUMAN REVIEW (v3 → v4):** 4 blockers and 7 corrections, all verified by execution before applying:
1. **The redirect test did not test the production router** — it rebuilt the routes inside the test, including the redirect under test, so it stayed green with `router.ts` misconfigured. `routes` is now exported and the test imports it.
2. **PR 1's e2e changes would not have been committed, and only 1 of 3 identities was updated.** `dashboard-screenshots.test.ts` waits on `/Production incidents/i`, `/No incidents yet/i`, and `/Unable to load incidents/i` — all three die in PR 1. The commit staged only `packages/dashboard/src`.
3. **The stated e2e command runs nothing.** The suite is gated on `CAPTURE_DASHBOARD_SCREENSHOTS=1` (`:14,17`); the plan's command skipped all 46 screenshot tests while unrelated live suites failed on missing infrastructure. Alignment assertions moved to their own non-capture file so a correctness check does not share a kill switch with screenshot generation.
4. **The `safeUrl` normalization audit covered 4 call sites; there are 15 across 9 files.** `SessionDetail.vue:89`, `SessionsList.vue:197`, `Settings.vue:587`, `SetupWizard.vue:242`, and two `trace_url` sites were all missing, and three of them render the raw value as visible link text. Normalization is now opt-in with strictness rather than unconditional, and the "default behavior does not change" claim is corrected — credential rejection is an observable default change.

Corrections: focused vitest commands throughout; `AdminView`'s `job` is a `v-for` variable so a single top-level computed is impossible (concrete `jobsWithLinks` alternative given); sortable headers were mouse-only with no `aria-sort` (now real buttons plus an `ariaSort` helper and a test); 17 safe-url tests not 19; migration paths corrected to `packages/ingestion/db/migrations/`; the FilterBar conflict was between two lanes in PR 1, not between PRs; the foreign `superpowers:executing-plans` directive removed.

**DESIGN (v4 → v5):** Rated 5/10 initially — strong on specification, weak on state design, affordances, and mobile. 8 decisions, all folded in. Passes: Info Architecture 6→9, States 4→10, Journey 5→9, AI Slop 9 (no findings; APP UI classifier, 0 hard rejections, 7/7 litmus), Design System 6→9, Responsive/A11y 5→9, Decisions 7 resolved / 1 deferred. The three that mattered: one empty state served two situations, so a customer who filtered to zero was told their SDK was not reporting and handed a setup guide; a clickable Draft PR badge and an inert Analyzing badge were pixel-identical, hiding the product's best moment; and the phone view was an unchosen two-column table that hid every number worth triaging on. Three mockups generated, **variant C approved** (5/5 vs A=3, B=4) and recorded under Approved Mockups. Design outside voices skipped — Codex had already timed out twice this session.

**VERDICT:** CODEX + ENG + HUMAN + DESIGN CLEARED — ready to implement. Start with PR 1 (Tasks 1-5 plus T13-T17); open PR 2 only after PR 1 merges. Note the design review roughly doubled PR 1's UI work — the stacked mobile layout (T14) is the largest single item and is a reasonable candidate to split into its own PR if PR 1 gets unwieldy.

**UNRESOLVED DECISIONS:**
- How long issue titles are clamped in the list. Deliberately deferred in design Pass 7 and captured in `TODOS.md` — clamping at 2 lines protects scan rhythm, but the distinguishing detail of an error message is often at the tail, so truncation can hide the part that identifies it. Applies to both the desktop row and the stacked mobile layout.
- Task 5 Step 3e gives no expected visible-column count per breakpoint on purpose — the implementer must observe the rendered page or built CSS on first run and encode what they see, since a plan-supplied number here is exactly the kind of off-by-one that ships wrong.
- The outside voice never returned on v3 or v5. If cross-model coverage matters before implementation, re-run `/codex review`; the structural findings attributed to it came from direct verification, not from a second model.
