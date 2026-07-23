# TODOS

Deferred work with enough context to pick up cold. Add items with What / Why / Pros / Cons / Context / Depends on.

---

## Replace full-list polling on the issue list with a count or since-timestamp endpoint

**What:** `ActivityFeed.vue` (renamed to `IssuesList.vue`) polls `listIncidents()` every 30 seconds and uses only `latest.length`. Replace it with a lightweight endpoint that returns a count, or a `since=<timestamp>` query that returns only what changed.

**Why:** Every open dashboard tab fetches the complete incident payload — titles, fingerprints, per-environment rollups, evidence records — twice a minute, then discards all of it except one integer. The comparison is also the wrong signal: it only fires when the list *grows*. If one issue resolves and one new one arrives inside the same 30-second window, the count is unchanged and the user is told nothing happened.

**Pros:**
- Cuts steady-state dashboard traffic to a fraction of current volume, per tab, per user.
- Fixes the missed-replacement case, so the "N new issues" banner becomes trustworthy.
- Makes it safe to shorten the poll interval later if we want fresher data.

**Cons:**
- Requires a new Go handler in `packages/ingestion`, so it is no longer a dashboard-only change.
- A `since` variant needs a stable ordering key and careful handling of the filter set, which the current naive length compare sidesteps.

**Context:** Found during `/plan-eng-review` of `docs/plans/2026-07-22-issue-list-polish.md` on 2026-07-22. The polling code is `ActivityFeed.vue:73-82`:

```ts
async function pollForNew() {
  const latest = await listIncidents(projectId.value, currentFilters.value);
  if (latest.length > incidents.value.length) {
    newIncidentCount.value = latest.length - incidents.value.length;
  }
}
```

It was deliberately left alone by the issue-list polish plan, which is scoped dashboard-only (no Go, no migrations). Start at that function and at the read API in `packages/ingestion/handler/read_api.go`. Note the poller must respect `currentFilters` — a count endpoint needs the same filter parameters `listIncidents` takes, or the banner will report issues the user has filtered out.

**Depends on / blocked by:** Nothing. Independent of the issue-list polish plan; can land before or after either PR.

---

## Plumb the worker's GitHub host to the dashboard so Enterprise PR links render

**What:** The dashboard's `safeUrl` host allowlist for `pr_url` accepts `github.com` and `www.github.com` only. Self-hosted GitHub Enterprise PR links therefore render as plain text instead of links. Expose the worker's configured GitHub host to the dashboard and add it to the allowlist.

**Why:** The worker already supports a custom host through `OPSLANE_GITHUB_URL` (`packages/worker/src/repo-clone.ts:27`), so an Enterprise install produces perfectly valid `pr_url` values that the dashboard then refuses to link. The user sees a status badge that looks clickable-adjacent and does nothing, with no explanation.

**Pros:**
- Enterprise installs get working PR links, which is the single most valuable click on the issue list.
- Removes a silent degradation that is very hard to diagnose from the UI.

**Cons:**
- Needs a config surface the dashboard can read (an API-served settings value or a build-time env var), which is a small new contract.
- A misconfigured or attacker-influenced host value would widen the allowlist, so the plumbing has to treat it as trusted config, not user input.

**Context:** Found during `/codex review` and confirmed in `/plan-eng-review` of the issue-list polish plan on 2026-07-22. The original plan used `hostname.startsWith('github.')` to try to cover Enterprise; that was rejected because it also accepts `github.evil.com`. Exact hosts were chosen instead, with Enterprise explicitly out of scope. Start at `safeUrl` in `packages/dashboard/src/utils.ts` and the allowlist constant beside it.

**Depends on / blocked by:** The issue-list polish PR 1, which introduces the allowlist parameter on `safeUrl`.

---

## Add tests for `safeUrl`'s four pre-existing call sites

**What:** `safeUrl` in `packages/dashboard/src/utils.ts` had zero tests despite guarding four render sites that bind untrusted values to `href`. The issue-list polish plan adds tests for the function itself; this item covers the call sites.

**Why:** `IncidentDetail.vue:406,422`, `AdminView.vue:324`, `IncidentConclusion.vue:20`, and `SetupWizard.vue:361` all bind a sanitized URL to an `href`. Nothing asserts that any of them actually calls the sanitizer. A future refactor could drop the call and no test would notice.

**Pros:**
- Locks the sanitizer into the render path so it cannot be silently removed.
- Cheap: each is a mount-and-assert-href test in an existing test style.

**Cons:**
- Four more component tests to maintain, in files otherwise unrelated to the issue list.

**Context:** Found during `/plan-eng-review` on 2026-07-22. PR 1 of the issue-list polish plan hardens `safeUrl` and adds unit tests for the function, plus a regression test proving `http:` trace URLs still pass (self-hosted Langfuse via `LANGFUSE_BASE_URL`, `docker-compose.yml:119`). The call-site tests were scoped out to keep PR 1 focused.

**Depends on / blocked by:** The issue-list polish PR 1.

---

## Write DESIGN.md and correct the stale decision claiming it exists

**What:** The design system exists only as CSS custom properties in `packages/dashboard/src/styles/tokens.css` ("Forensic Ledger": paper `#fbfaf7`, ink `#24211d`, ember accent `#b74420`, four status hues). There is no DESIGN.md. A stored gstack decision from 2026-07-20 states "DESIGN.md written at repo root" — that file does not exist.

**Why:** Every design review has to reverse-engineer the system from `tokens.css` before it can judge anything against it. `/plan-design-review` rated design-system alignment 6/10 partly because there is no document to align to. The stale decision is worse than the gap: it tells a future session the doc exists, so it will not go looking in the right place.

**Pros:**
- Design reviews calibrate against a stated system instead of inferring one.
- Gives status-hue contrast targets a home — a prior learning records that two status chips shipped failing WCAG AA because they were eyeballed against the page background rather than their own tint.
- `/design-consultation` can produce it in one pass.

**Cons:**
- A design doc that drifts from `tokens.css` is worse than none; it needs an owner.

**Context:** Found during `/plan-design-review` of `docs/plans/2026-07-22-issue-list-polish.md` on 2026-07-22. Start from `tokens.css` — it is already the source of truth and is enforced by `tailwind-token.test.ts`. Also supersede the stale decision so future sessions stop believing the file exists.

**Depends on / blocked by:** Nothing.

---

## Decide how long issue titles are clamped in the list

**What:** Error titles render with no line clamp. Variant C's mockup shows them wrapping to two lines. A 300-character error message would make a single row fill the viewport.

**Why:** Row height variance breaks vertical scan rhythm, which is the whole point of a dense triage list. It also interacts with the stacked mobile layout, where a long title plus a meta line could push a single issue past a phone screen.

**Pros:**
- Predictable row heights make the list scannable.
- A clamp with a `title` attribute keeps the full text reachable on hover.

**Cons:**
- Truncating an error message can hide the part that identifies it, since the distinguishing detail is often at the end.

**Context:** Surfaced in `/plan-design-review` Pass 7 on 2026-07-22 and deliberately left unresolved. The relevant code is the row's `<router-link>` title in `IncidentLedgerRow.vue`. Note the tension: clamping at 2 lines is good for rhythm, bad for a `TypeError: Cannot destructure property 'name' of 'props.user.profile' as it is null.` where the useful part is the tail.

**Depends on / blocked by:** The stacked mobile layout (Design decision D6), which should use the same clamp.

---

## Bring Settings and Admin selects up to the 44px touch minimum

**What:** Selects on `/settings` and `/admin` measure 30px tall. The sanctioned `ui/SelectField.vue:42` uses `min-h-10 max-md:min-h-11` (40px desktop, 44px touch), and the issue-list filters were brought to that in the polish work. These were not.

**Why:** 30px is below the 44px minimum touch target. On a phone these are hard to hit accurately, and the inconsistency means the same control renders two different sizes depending on which page you are on.

**Pros:**
- Consistent control sizing across the app.
- Removes a real accessibility gap on two pages.

**Cons:**
- Taller controls change the vertical rhythm of both pages, so the surrounding spacing may need a look.

**Context:** Measured during `/qa` on 2026-07-23 against a live build: `/settings` has one 30px select, `/admin` has 30px and 40px selects. These pages were in scope for the chevron padding fix (Task 1 of the issue-list plan) but not for the touch-target fix, which design decision D8 scoped to the issue-list filters only. Pre-existing, not a regression. The cleanest fix is probably migrating them to `SelectField` rather than hand-adding classes.

**Depends on / blocked by:** Nothing.
