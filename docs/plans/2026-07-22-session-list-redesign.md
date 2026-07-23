# Session list redesign

Status: reviewed (design)
Branch: `abhishekray07/session-list-ui`
Date: 2026-07-22

## Problem

`/sessions` shows how a recording was **stored**, not what happened **inside** it.
Five of seven columns carry no decision-changing signal:

| Column | Why it fails |
| --- | --- |
| Chunks `2/2` | Internal plumbing. Only `0/n` ("still processing") means anything to a user. |
| Size `2.4 KB` | Storage accounting. Belongs on billing, not on a triage screen. |
| Status `analyzed` | Identical on every row. Only `analyzing` / `analysis_failed` carry information. |
| Page `localhost:5174` | Identical on every row, and it is the first URL, not the journey. |
| User `—` | Empty whenever the SDK never called `identify()`, with no hint that that is why. |

The click target is the relative timestamp ("5 days ago"), which reads as metadata,
not as a link to a recording.

The filter bar asks for **End-user ID** and **Account ID** as raw UUIDs. Nobody knows
a UUID by heart, so those two inputs will never be used.

Opslane is an error-resolution engine. The list has to answer one question:
**which session should I watch?** Storage columns cannot answer it.

## What we already store and never show

- `friction_signals` — `rage_click`, `dead_click`, `form_abandon` per session, with
  `occurrence_count` (`packages/ingestion/db/migrations/004_friction.sql:35`)
- `error_events.session_id` — how many errors fired during the session
- `friction_signals.incident_id` — which session became evidence for an incident
- `sessions.sdk_release` — which release the user was running
  (`packages/ingestion/db/migrations/022_session_sdk_identity.sql`)

No migration is needed. `idx_error_events_session` already exists
(`001_baseline.sql:189`), and `friction_signals`' `UNIQUE (session_id, fingerprint,
rule_version)` gives a session-prefixed btree.

## Decisions taken

- **Row layout:** three columns, two lines each — Session / Signals / Started.
  Approved visual direction is variant B (see Approved Mockups). The mockup labels the
  third column "Activity & Date"; ship it as **Started**, because the cell contains a
  start timestamp and a duration and "Activity" implies neither.
- **Scope:** backend and frontend together. Signal counts are the point of the change.
- **No session summary.** Counts only. The *detection* is a deterministic rule engine
  (`RULE_VERSION = 1`, `packages/worker/src/friction/analyzer.ts`). An earlier draft of
  this plan said "no model runs per session" — that was wrong: `worker/src/index.ts:625`
  runs `processFrictionOutcomes` with an LLM adjudicator inside the session-analysis job
  whenever `ANTHROPIC_API_KEY` is set. It judges whether a signal is real; it does not
  summarize the session. So a summary still needs new work, but the reason is scope, not
  the absence of a model. See "NOT in scope".

## Information architecture

The screen answers one question in this order: **who** → **what went wrong** →
**when**. Everything else is subordinate or removed.

```
+----------------------------------------------------------------------+
| SESSION LEDGER                                    (ember eyebrow, xs) |
| Recorded sessions                                     (h1, 2xl semi)  |
| Browse scrubbed recordings by user, account, and time.   (sm, muted)  |
|                                       50 loaded  (mono xs, right) [1] |
+----------------------------------------------------------------------+
| [ search email or user ID ] [ Last 24 hours v ] [ All envs v ]  Clear |
+======================================================================+
| SESSION (~45%)          | SIGNALS (~30%)     | STARTED (~25%)         |
+-------------------------+--------------------+------------------------+
| [>] jane@acme.com       | [3 errors]         | Jul 22, 8:02 PM        |
|     Acme Corp · v1.4.2  | [2 rage clicks]    | 7m 21s                 |
+-------------------------+--------------------+------------------------+
| [>] anonymous-8f3a2c1b  |                    | Jul 22, 7:31 PM        |
|     Acme Corp · v1.4.1  |                    | 2m 48s                 |
+======================================================================+
|                        [ Load more ]                                  |
+----------------------------------------------------------------------+
```

**[1] The header count says "loaded", not "records".** `SessionListResponse`
(`types/api.ts:230`) returns `sessions` and `next_cursor` — there is no total, and keyset
pagination cannot cheaply produce one. Rendering `sessions.length` as "50 records" when
the project has 205 is a lie. Either label it `50 loaded` or add an explicit total to the
contract; do not silently mislabel a page size as a corpus size.

Scan order by design: the eye lands on the h1, drops to the first row's display name,
then travels right along the row. Signals sits in the middle because a signal is only
meaningful once you know whose session it is.

**Constraint check — if only three things could be shown:** who (identity), what broke
(signals), when (time). That is exactly the three columns. Nothing else earns a column.

**One click target per row, plus one deliberate exception.** The play control and the
identity are a single link. The `<td>` contains one `<router-link>` wrapping the play
glyph and the display name; the second line is inside the same link. Krug's rule: do not
make the user choose between two ways to do the same thing.

The exception is the copy-session-id control that exact-match search requires. A `<button>`
nested inside an `<a>` is invalid HTML and breaks keyboard order, so it **must not** live
inside the link. Put the copy control outside the `<router-link>` as a sibling in the same
cell, revealed on row hover and on focus-within, with `aria-label="Copy session ID"`. It
is a second tab stop by construction — that is the accepted cost of the 4.29 query plan,
and it is why the control is visually recessive rather than a peer of the primary link.

## Interaction states

| Feature | Loading | Empty | Error | Success | Partial |
| --- | --- | --- | --- | --- | --- |
| Session table | 3× `SkeletonBlock` at `h-14` inside a `role="status" aria-busy="true"` wrapper, matching `ActivityFeed.vue` | See two empty variants below | `InlineAlert tone="danger" title="Unable to load sessions"` with the message in the default slot **and a Retry button** — an error with no way out is a dead end | Rows render; record count in the header updates | — |
| Row playback | — | — | — | Play glyph in ink, whole cell is one link | `playable_chunk_count === 0` → glyph greyed, row not a link. Label depends on status, because zero playable chunks is **not** always "processing": `recording`/`closed`/`analyzing` → `Processing`; `analysis_failed` or `chunk_count > 0` with no playable chunks → `Unavailable`; `chunk_count === 0` → `No recording`. Partial (`1/2`) **is** playable and links normally |
| Signals cell | — | Renders nothing **only when `status = 'analyzed'`** — that is the one state where silence truthfully means "we looked and found nothing" | — | Chips in severity order: errors first, then rage clicks, dead clicks, form abandons | Every non-`analyzed` status gets an explicit chip: `recording` → `Recording`; `closed` → `Queued`; `analyzing` → `Analyzing`; `analysis_failed` → `Analysis failed` |
| Identity | — | No `end_user` → `Anonymous` in ink plus the truncated session id in mono on line two | — | Email, else `external_user_id` | Email present but no account → omit the `·` separator entirely, never render a dangling dot |
| Filters | Submit disabled while a fetch is in flight; table keeps the previous rows rather than flashing to skeletons | `With signals` selected with zero matches → `EmptyState title="No sessions with signals"` and a `Show all sessions` action, distinct from both other empty states | — | Results replace the table | Any filter active → show a `Clear filters` link; clearing refetches |
| Load more | Button label becomes `Loading...` and disables | Button absent when `next_cursor` is null | Inline retry **below the existing rows** — already-loaded rows must never be discarded by a pagination failure | Appends rows | — |

**Two distinct empty states.** These are different situations and must not share copy:

- **No sessions at all** — `EmptyState title="No sessions recorded yet"
  description="Recordings appear after the SDK sends its first chunk."` with a
  `Setup guide` link in the default slot, mirroring `ActivityFeed.vue`.
- **Filters matched nothing** — `EmptyState title="No sessions match these filters"
  description="Try widening the date range or clearing the search."` with a
  `Clear filters` button in the default slot.

Shipping one empty state for both is the failure mode this table exists to prevent:
a first-run user is told to change filters they never set.

## User journey

| Step | User does | User feels | Plan specifies |
| --- | --- | --- | --- |
| 1 | Lands on `/sessions` | "Is there anything here for me?" | Record count in the header answers it in under a second |
| 2 | Scans down the Signals column | "Which of these is worth 7 minutes of my life?" | Chips appear only on rows with real friction, so problem rows pop |
| 3 | Searches for a customer who complained | "I have an email, not a UUID" | Single search box matches email or external id |
| 4 | Clicks a row | "I want the recording, now" | Whole identity cell is the link; no hunting for a play button |
| 5 | Finds a row still processing | "Is this broken?" | Explicit `Processing` label, not a dead link |

**Five seconds (visceral):** on a fresh install every row is `Anonymous` with an empty
Signals column. That reads as a broken product, not an idle one. The empty-state copy
and the `Anonymous` treatment carry the whole trust burden here — they must say *why*
identity is missing, not just render a dash.

**Five minutes (behavioural):** the user learns that chips mean trouble and blank means
clean. That convention only holds if blank never also means "not yet analyzed" — which
is why `analyzing` and `analysis_failed` get explicit chips.

**Five years (reflective):** this is the screen an engineer opens when a customer is
angry. It should feel like a ledger you can trust, not a storage report.

## Design system alignment

`SessionsList.vue` currently uses none of the shared components. `ActivityFeed.vue` is
the reference implementation and this screen must match it.

| Need | Use | Exact API |
| --- | --- | --- |
| Page header | Copy `ActivityFeed.vue` header block | eyebrow `text-xs font-semibold uppercase tracking-[0.18em] text-accent`, `h1 text-2xl font-semibold tracking-tight`, count in `font-mono text-xs text-muted` |
| Row | Mirror `components/incidents/IncidentLedgerRow.vue` | Bold link line + `mt-2 text-xs text-muted` metadata line with `·` separators; extract `SessionLedgerRow.vue` |
| Loading | `ui/SkeletonBlock.vue` | — |
| Error | `ui/InlineAlert.vue` | prop is **`tone`**, not `variant`; `title` prop; message in default slot |
| Empty | `ui/EmptyState.vue` | props `title`, `description`; slots are **`icon`** and **default** — there is no `action` slot |
| Chips | `ui/StatusLabel.vue` + new `frictionSignalRecipe` in `status-recipes.ts` | props `tone` (`StatusTone`), `label` |
| Filters | Follow `components/FilterBar.vue` shape | inline labelled controls, not a labelled form grid |

Tone mapping for the new `frictionSignalRecipe`: errors → `danger`, rage clicks →
`warning`, dead clicks → `warning`, form abandons → `neutral`, `Analyzing` → `progress`,
`Analysis failed` → `warning`.

**Prop and slot names are load-bearing.** Vue silently drops an unknown slot and lets an
unknown prop fall through to attrs, leaving the real prop at its default — and `vue-tsc`
catches neither. This repo has already shipped both bugs: `InlineAlert` was passed
`variant=danger` and rendered as info, and `EmptyState` was passed `#action` so the
Setup guide link vanished. Check every usage against the child's `defineProps` and slot
names by hand.

**Contrast is already solved — do not re-derive it.** Measured against each chip's own
tint, not the page background: danger 5.68:1, warning 5.28:1, success 5.84:1, progress
5.78:1, insight 5.55:1, muted-on-subtle 5.89:1, accent-on-paper 5.21:1. All pass WCAG AA
and cluster near an equal ~5.6:1 target. Any new chip colour must be solved to the same
contrast target, not the same HSL lightness — hue moves luminosity independently.

**No motion is specified anywhere in this screen, deliberately.** Row hover is a
background change only (`hover:bg-surface-subtle`). A ledger does not animate.

## Responsive

Progressive column hiding, matching `ActivityFeed.vue`. Never "stacked on mobile".

| Viewport | Session | Signals | Started |
| --- | --- | --- | --- |
| `< 640px` | Visible. Identity, then a metadata line carrying account, then chips inline below | Hidden (`hidden sm:table-cell`) — chips move **into** the Session cell, never disappear. Signals are the reason this redesign exists; they must survive every breakpoint | Time only; duration drops to the Session metadata line |
| `≥ 640px` | Visible | Visible as its own column | Visible |
| `≥ 1024px` | Adds release (`v1.4.2`) and the page path to the metadata line | Visible | Visible |

Long emails, external ids, and session ids truncate with `truncate` on a `min-w-0` cell,
and carry the full value as accessible text — never truncate without a way to recover it.

Filter row wraps with `flex flex-wrap gap-3`; the search input goes full width below
`640px` and the date and environment controls sit side by side beneath it.

**Testing caveat.** In `@vue/test-utils` + jsdom, `findAll('td')` counts cells carrying
`hidden sm:table-cell` as present, because jsdom never applies Tailwind media queries.
A column-count assertion therefore passes regardless of which breakpoint classes the
cells carry and cannot detect header/row shear. Assert the visibility class matrix
element by element — filter classes to `hidden` plus `sm|md|lg|xl:table-cell` and compare
`th` against `td` — and put real width checks in `test-e2e`.

## Accessibility

- `<table aria-label="Recorded sessions">`; column headers are real `<th scope="col">`.
- Row link accessible name must not be the bare email. Use
  `aria-label="Play session for jane@acme.com, 7m 21s, Jul 22 8:02 PM"` so a screen
  reader user is not handed a naked address with no context.
- Processing rows are not links. Render a `<span aria-disabled="true">` with the
  explanatory `title`, never a disabled anchor.
- Play glyph tap target is at least 44×44px including padding. The approved mockup draws
  it near 28px, which fails on touch — pad the cell, do not grow the glyph.
- Focus ring is `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`,
  matching `IncidentLedgerRow.vue`. Every row link and every filter control gets one.
- Chip colour is never the only carrier of meaning — `StatusLabel` already prefixes a
  mono glyph (`!`, `→`, `◆`) and the chip text states the count in words.
- Search input keeps a visible `<label>`. Placeholder-as-label disappears the moment the
  user types.
- Timestamps render as `<time :datetime="session.started_at">`, so assistive tech and
  scrapers get the machine value while humans see the formatted one.
- **`page_url` does not move to a `title` attribute.** A native `title` never appears on
  touch and is unreliable under keyboard focus, so that would hide information the
  current screen shows outright. Render the URL's path (not the full URL) as visible text
  on the Session metadata line at `≥1024px`, still passed through `safeUrl()`. Below that
  breakpoint it is omitted — omitted is honest, hover-only is not.
- The dashboard has one URL sanitizer, `safeUrl()` at `packages/dashboard/src/utils.ts:34`.
  Do not add a second one.

## Backend — `packages/ingestion`

**One query, not three.** An earlier draft fanned out into a page query plus two
follow-up queries keyed by `session_id = ANY($2)`, on the theory that subqueries in
`sessionSummarySelect` would be too costly. That reasoning did not hold: the select
*already* runs a correlated subquery per row for `playable_chunk_count`
(`sessions_read.go:61`), 51 index-backed lookups is not a cost worth restructuring
around, and the `has_signals` filter forces friction and error predicates into the
paginating query anyway — leaving `friction_signals` read twice per request.

Two `LEFT JOIN LATERAL` blocks give the counts and the filter from a single read.
`count(*) FILTER (WHERE ...)` is already an idiom here (`db/admin.go:115`):

```sql
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(occurrence_count) FILTER (WHERE signal_type = 'rage_click'), 0)   AS rage,
         COALESCE(sum(occurrence_count) FILTER (WHERE signal_type = 'dead_click'), 0)   AS dead,
         COALESCE(sum(occurrence_count) FILTER (WHERE signal_type = 'form_abandon'), 0) AS abandon
    FROM friction_signals fs
   WHERE fs.session_id = s.id
     AND fs.project_id = $1
     AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
     AND fs.adjudication_status = 'accepted'
) f ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS errors
    FROM error_events ee
   WHERE ee.session_id = s.id AND ee.project_id = $1
) e ON true
```

Then `has_signals` is `AND ($10 = false OR (f.rage + f.dead + f.abandon + e.errors) > 0)`,
applied before `LIMIT`.

Four things in that SQL are load-bearing:

- **`sum(occurrence_count)`, not `count(*)`.** `friction_signals` stores repeats within a
  session in `occurrence_count` (`004_friction.sql:47`, *"Repeat occurrences within one
  session"*). `count(*)` would count distinct fingerprints and under-report every row —
  three rage clicks on one button would render as "1 rage click".
- **`adjudication_status = 'accepted'`.** Signals carry an adjudication verdict
  (`007_friction_adjudication.sql:9`). Keyless deployments skip adjudication entirely and
  *"signals stay pending and invisible"* (`worker/src/index.ts:628`). Counting every
  unretracted signal would surface pending and rejected detector noise that the rest of
  the product deliberately hides, so the session list would disagree with the incident
  ledger about the same session.

- **`fs.project_id = $1` and `ee.project_id = $1` are required, not redundant.**
  `packages/ingestion/AGENTS.md`: *"Scope every database helper to the required project
  or organization, and enforce that scope in its query."* Joining on `session_id` alone
  is transitively safe but leans on the outer query instead of enforcing scope.
- **`retracted_at IS NULL AND superseded_by IS NULL`** is the aggregation rule at
  `004_friction.sql:57`. Without it a re-analysis at a new `rule_version` double-counts
  every signal. This needs its own test.

Putting the counts in `sessionSummarySelect` also means `GetSessionSummary`
(`sessions_read.go:124`) inherits them for free — the fan-out version would have needed
those follow-up queries written twice.

**Known cost, accepted with a tripwire.** With `has_signals=true`, Postgres walks
sessions in `started_at DESC` order evaluating the LATERAL per row until it collects 51
matches. Because most sessions are clean by design, cost scales as `51 / selectivity`:
at 1M sessions with 1% carrying signals that is roughly 5,100 row visits per page. Fine
now; not fine forever. **Log query duration for this endpoint, and treat a p95 above
200ms as the trigger to denormalize `sessions.has_signals` with a partial index.** Do
not pre-build the column.

Add `HasSignals bool` and `Search string` to `db.SessionFilters`, and `has_signals` /
`search` to the query contract. The keyset cursor is unaffected: the filter narrows the
row set, it does not reorder it.

New fields on `db.SessionSummary` (`packages/ingestion/db/sessions_read.go:14`) and on
the JSON contract: `error_count`, `rage_click_count`, `dead_click_count`,
`form_abandon_count`, `sdk_release`. Same additions flow to `SessionDetail`.

**Search, with the index behaviour measured rather than assumed.** `end_user_id`
currently filters on `s.end_user_id::text` (`sessions_read.go:87`), a UUID equality
match. The single box must match user identifier, email trait, and session id. `EXPLAIN`
on the live database (Postgres 16, `enable_seqscan=off` to test index usability):

| Predicate | Plan | Cost |
| --- | --- | --- |
| `eu.email ILIKE 'jane%'` | `Index Cond: project_id` → `Filter: email ~~* ...` | 8.49 |
| `eu.email LIKE 'jane%'` | identical — still a Filter | 8.49 |
| `eu.email = 'jane@acme.com'` | `Index Cond: (project_id AND email)` | 8.40 |
| `s.id ILIKE 'abc%'` | `Index Only Scan` → `Filter: id ~~* ...` | **367.86** |
| `s.id = 'abc'` | `Index Cond: (id = 'abc')` | **4.29** |

`ILIKE` never gets an `Index Cond` on a plain btree — anchoring the pattern does not
change that, and `idx_end_users_email` (`001_baseline.sql:287`) is a plain btree. So:

- **Email and external_user_id: keep `ILIKE`.** The index still bounds the scan to one
  project's users, which is cheap. No new index, no migration.
- **Session id: exact match, `s.id = $n`.** `ILIKE` costs 86× more on the table that
  grows fastest. The row must therefore expose the **full** session id via a copy
  affordance, so what the user pastes is what matches. A hand-typed partial id will not
  match, and that is the accepted trade.

## Frontend — `packages/dashboard/src/views/SessionsList.vue`

- Extract `components/sessions/SessionLedgerRow.vue`, mirroring `IncidentLedgerRow.vue`.
  **Add `sessions` to `ownedRoots` in `test-e2e/dashboard-design-system.test.ts:41` and
  register the component in `docs/design/dashboard-v1/consumer-matrix.md`**, so it is
  policed by the orphan and consumer checks exactly like its incident sibling. A new
  directory under `components/` is otherwise an unpoliced corner.
- Three columns, two lines per row, per the IA diagram above.
- The identity cell is one link containing the play glyph, the display name, and the
  metadata line. Not two targets.

### Identity: identifier vs traits

PostHog and LogRocket draw the same distinction, and this plan follows it. The
**identifier** is required and stable (PostHog: *distinct ID*; LogRocket: *UID*). The
**email and account name are traits** — optional, and they change. LogRocket is explicit:
*"Names and email addresses can be added as user traits as they could change."*

The schema already models this: `setUser` returns early without `id` (`sdk/src/core.ts:38`)
while `email` is optional on `UserIdentity`. Only the labelling was wrong.

- Column header is **User**, never "Email".
- Search placeholder is **"Search by user, email, or session ID"**.
- The filter field is `search`, generic. Never name it `email`.
- Display name resolves in order: `email` → `external_user_id` → `Anonymous`.

```
▶  jane@acme.com                    ← email trait present
   Acme Corp · v1.4.2

▶  user-123                         ← identifier only, no email trait
   Acme Corp · v1.4.2

▶  Anonymous                        ← no end_user row at all
   @opslane/sdk 1.2.0 · a8f3c2b1
```

**The anonymous row is the common case, not the edge case.** Measured on the dev
database: **205 sessions, 7 identified, 198 anonymous — 3.4%**. Identity exists only
when the customer calls `setUser()`, which appears nowhere in `docs/install.md` or
`docs/quickstart/`. So render one dismissible line above the table: *"These sessions have
no user attached. Call `setUser()` to see who they are."* with a docs link.

**The trigger is project-level, not page-level.** "Every row on this page is anonymous"
is the wrong condition in both directions: identified sessions may simply be on page two,
and one identified row would suppress the hint for a project with 198 anonymous sessions.
The list response carries no identity-coverage figure, so this needs a project-scoped
`has_identified_sessions` boolean on the response (an `EXISTS` against `sessions` where
`end_user_id IS NOT NULL`, cheap and index-backed). Show the hint when that is false.

**The hint must state the privacy consequence.** `setUser` sends identifying fields
unmasked; `docs/guides/replay-privacy.md:44` is the contract. Prompting a customer to
turn on identity without saying what leaves their browser is not acceptable. The linked
doc must cover it, and E15 has to write that doc before E8 can link to it.
- Status badge only for `analyzing` / `analysis_failed`, rendered in the Signals cell.
- Drop Size and Page as columns. The page path becomes visible text on the metadata line
  at `≥1024px`, through `safeUrl()`.
- **Filters: five controls become three**, plus a `Clear filters` link:
  1. **Search** — matches email, `external_user_id`, **or session id**. Session id is
     non-negotiable: the row displays a truncated session id, so a user will paste one in.
     A search box that cannot find what the table just showed them is a broken promise.
  2. **Date preset** — `Last 24 hours` / `7 days` / `30 days` / `Custom`. Custom range
     input is interpreted in the browser's local timezone and sent as UTC ISO, matching
     the existing `isoDate()` behaviour.
  3. **Environment** — the existing select, unchanged.
  3b. **Account** — search must also match `eu.account_name` and
     `eu.external_account_id`. The old Account ID input goes away, but the *capability*
     must not: the page subtitle promises browsing "by user, account, and time", and a
     complaint from "Acme" has to be findable. `idx_end_users_account`
     (`001_baseline.sql:285`) already covers the project-scoped lookup.
  4. **`All` / `With signals`** — a two-state segmented toggle, defaulting to `All`.
     This is the control that turns the redesign from "nicer rows" into triage: without
     it, a session worth watching stays buried on page three beneath clean ones. It is a
     `WHERE` filter, not an `ORDER BY`, so newest-first ordering and the keyset cursor
     both survive untouched.
- Sort stays newest-first. Signals are display-only, not a sort key — sorting by friction
  would break the `(started_at, id)` keyset cursor.

### Code hygiene carried by this change

- **Wire the new params in `api.ts:613-618`.** `listSessions` serializes filters field by
  field. Adding `search` and `has_signals` to the `SessionFilters` type compiles clean,
  passes `vue-tsc`, and yields a UI where the filter silently does nothing. Same silent
  class as the `InlineAlert variant=` / `EmptyState #action` bugs already shipped here.
  `session-list-query.ts` needs no change — it spreads `{ ...filters }`.
- **Delete `formatBytes` (`SessionsList.vue:108`).** Its only caller is the Size column
  this change removes.
- **Fix `formatDuration` before consolidating onto it.** `admin-format.ts:19` uses
  `Math.round` on the remainder, so it carries past the base: 3599.6s renders `59m 60s`
  and 7199s renders `1h 60m` (verified by execution). Floor the remainder, or normalize
  the carry. Add boundary tests at 59.5s, 3599.5s, and 7199s. Only then make it canonical.
- **Consolidate the three duration formatters.** `admin-format.ts:19` is the best base:
  tested, handles sub-second through hours. `SessionsList.vue:96` reimplements it from
  milliseconds. `SessionDetail.vue:41` has no hour case and no sub-minute case, so it
  renders `120m 30s` where the list renders `2h 0m` for the same session. Move
  `formatDuration` to a shared module, feed it `(last_chunk_at - started_at) / 1000`,
  delete both local copies. This fixes a shipped bug and stops the row component becoming
  a fourth implementation.
- **Build the metadata line by filtering and joining**, not with nested `v-if`s around
  `·` separators. Account, release, and page path are each independently nullable; three
  optional segments joined by hand is where dangling-separator bugs live.

## NOT in scope

| Deferred | Why |
| --- | --- |
| LLM session summaries | Needs a `sessions.summary` column, a worker step, a prompt, and an eval, plus per-session token cost. Its own epic. |
| Composed/templated summary line | Rejected in review: keep the table and the basics for this pass. |
| Sorting by friction severity | Breaks the keyset cursor at `sessions_read.go:92`; would force an offset rewrite. |
| Severity sorting or a computed friction score | Sorting breaks the keyset cursor at `sessions_read.go:92`. The `With signals` filter delivers the triage benefit without that cost. |
| Surfacing `adjudication_reason` prose | Per-signal, not per-session, and only exists for adjudicated signals. |
| Geo and browser columns | Not stored on `sessions`. Would need an ingestion contract change. |
| Dark mode | Deliberately removed from `tokens.css`; reinstating it needs the `data-theme` switch and the hardcoded select chevron in `base.css` fixed together. |

## What already exists

- **Design tokens:** `packages/dashboard/src/styles/tokens.css` ("Forensic Ledger").
  There is no `DESIGN.md`; the tokens file plus the shared `ui/` components are the
  de facto system. Consider `/design-consultation` to write it down — the CI gate that
  enforced it (`test-e2e/dashboard-design-system.test.ts`) was deleted in `fb3862f`.
- **Reference page:** `ActivityFeed.vue` — header, filter bar, skeleton, alert, empty state.
- **Reference row:** `components/incidents/IncidentLedgerRow.vue`.
- **Shared components:** `EmptyState`, `InlineAlert`, `SkeletonBlock`, `StatusLabel`,
  `Button`, `TextInput`, `SelectField`.
- **Status tone mapping:** `status-recipes.ts`, including an existing `sessionStatusRecipe`.
- **Friction fixture:** `test-fixtures/vue-app/src/components/FrictionLab.vue` — a dead
  "Complete purchase" button that produces real `rage_click` signals, plus a five-user
  `setUser()` selector. Use it to populate the Signals column during verification.

## Failure modes

| New codepath | Realistic production failure | Test? | Error handling? | User sees |
| --- | --- | --- | --- | --- |
| LATERAL friction counts | Re-analysis at a new `rule_version` leaves both generations unretracted; counts double | **must add** (T2) | none possible — it is a correctness bug, not an error | Wrong numbers, silently. **Critical gap until T2 lands.** |
| LATERAL error counts | A render-loop error floods one session with 50k `error_events`; the per-row count walks them all | no | none | Slow page, no message. Watch item, confidence 5/10. |
| `has_signals` filter | Selective filter over a large mostly-clean corpus walks deep before filling a page | no | none | Spinner. Mitigated by the p95 tripwire, not eliminated. |
| Session id exact search | User pastes the truncated id shown in the row; exact match misses | must add | n/a | Zero results with no explanation. **Mitigated only by the copy-full-id affordance — if that ships late, this is a silent dead end.** |
| `search` / `has_signals` params | Field not added to `api.ts:613-618`; filter never reaches the server | must add | none | Filter appears to work and silently returns everything. **Critical gap — silent by construction.** |
| Row link on a processing session | `playable_chunk_count` is 0 but the row still renders as a link | must add | n/a | Navigates to an empty player. |
| Anonymous hint | Shown when identity exists but is sparse on one page | must add | n/a | Nagging about an already-solved problem. |

Three critical gaps, all in the same shape: **wrong or missing data that produces no
error**. Each needs a test, because no amount of error handling can surface them.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
| --- | --- | --- |
| A1 — LATERAL counts, search, `has_signals` | `packages/ingestion/db`, `packages/ingestion/handler` | — |
| B1 — `formatDuration` consolidation | `packages/dashboard/src` (admin-format, SessionsList, SessionDetail) | — |
| B2 — `ownedRoots` + consumer-matrix | `test-e2e`, `docs/design/dashboard-v1` | — |
| C1 — Row component, table, states, filters | `packages/dashboard/src/views`, `.../components/sessions` | A1 (contract), B1 (helper) |
| C2 — e2e identity regex + mock fixture | `test-e2e` | C1 (final copy) |

```
Lane A: A1                      (ingestion only, independent)
Lane B: B1 → B2                 (dashboard + test-e2e, independent of A)
Lane C: C1 → C2                 (waits on A1 and B1)
```

Launch **A and B in parallel worktrees**. Merge both, then run C sequentially.

**Conflict flag:** B2 and C2 both touch `test-e2e/`. Different files
(`dashboard-design-system.test.ts` vs `dashboard-screenshots.test.ts` +
`dashboard-mock-harness.ts`), so no textual conflict, but they are in the same package
and C2 cannot be written until C1 fixes the final copy. Keep them ordered.

## Outside voice — engineering review (Codex, gpt-5.6-sol)

Ran against this plan after all four review sections. Verdict: found defects the review
missed, including three the review itself introduced. Every load-bearing finding was
verified against the code before adoption.

**Adopted after verification:**

| Finding | Verification |
| --- | --- |
| `count(*)` counts fingerprints, not occurrences | `004_friction.sql:47` stores repeats in `occurrence_count`. Fixed to `sum(occurrence_count)`. |
| Counts ignore adjudication status | `worker/src/index.ts:628` — keyless deploys leave signals *"pending and invisible"*. Now filtered to `accepted`. |
| Blank cannot mean clean | `CloseIdleSessions` (`sessions.go:591`) sets `closed` **and** enqueues the analysis job in one statement, so `closed` means queued. Every non-`analyzed` status now gets a chip. |
| `formatDuration` is itself buggy | Executed: 3599.6s → `59m 60s`, 7199s → `1h 60m`. Must be fixed before consolidation. |
| The screenshot suite is not a CI gate | `ci.yml` allowlists it as a permitted skip — *"an opt-in generator, not a test... asserts nothing about product behaviour."* The review claimed twice that it would turn CI red. It would not. |
| "No model runs per session" was false | `worker/src/index.ts:625` runs the LLM adjudicator inside the session-analysis job. |
| Account lookup silently dropped | Confirmed against the plan's own subtitle. Search now covers account fields. |
| Header count has no contract | `types/api.ts:230` returns no total. Now labelled `N loaded`. |
| Hint heuristic invalid | Page-level anonymity ≠ project-level. Now gated on a project-scoped flag. |
| Copy control vs one-link-per-row | `<button>` inside `<a>` is invalid. Now an explicit sibling with a stated cost. |
| Mock proves nothing | One anonymous zero-signal unplayable session. Now expanded to four. |

**Rejected — cross-model tension, user decided:** Codex called the identity-led IA
P0-premature given 96.6% anonymous sessions, and argued signals should lead. **Kept
identity-led.** The 3.4% figure comes from a local fixture database, not customer
traffic, and account-and-user framing is why a B2B buyer wants session replay at all. The
anonymous hint plus `setUser` documentation closes the gap at its source. Revisit if real
customer identification rates stay low.

## Outside voice — design review dissent on record

An independent model review (Codex, gpt-5.6-sol, high reasoning) cleared every hard-rejection
criterion and confirmed the table direction, but disagreed with one decision taken here:

> "Most real sessions are clean, yet the plan only defines positive signal counts. Blank
> cells make the main new column look unpopulated or broken." It recommended an explicit
> muted `No detected signals` label on clean rows.

**Not adopted.** The call was made to keep the basics: chips appear only when something
happened. The substantive half of the objection — that zero, pending, and failed analysis
must be distinguishable — *is* addressed, via explicit `Analyzing` and `Analysis failed`
chips, so blank unambiguously means "analyzed, nothing found". If the empty column reads
as broken once real traffic lands, this is the first thing to revisit.

## Approved Mockups

| Screen | Mockup Path | Direction | Notes |
| --- | --- | --- | --- |
| Sessions list | `~/.gstack/projects/opslane-opslane-oss/designs/session-list-20260722/variant-B.png` | Three-column ledger table on Forensic Ledger tokens; eyebrow + h1 + mono record count; flat filter row; two-line rows; square outlined chips | Rated 5/5. Deviations to correct when building: row emails must be `text-text font-semibold` with `hover:text-accent hover:underline` per `IncidentLedgerRow`, not permanently underlined ember; play glyph needs a 44px tap target; play and email must be one link, not two |

## Verification

- `cd packages/ingestion && go build ./... && go test ./db ./handler`
- `pnpm --filter @opslane/dashboard build` and `pnpm --filter @opslane/dashboard test`
- `pnpm --filter @opslane/test-e2e test` — **required**, not optional. Root `pnpm test`
  is `test:repo && test:unit`, and `test:unit` filters out `@opslane/test-e2e`. This
  change alters user-visible copy and column structure, so the default gate would stay
  green while CI goes red.
- **The screenshot suite is NOT a CI gate — do not rely on it.** `ci.yml` allowlists it
  as a permitted skip: *"an opt-in generator, not a test... only runs when
  `CAPTURE_DASHBOARD_SCREENSHOTS=1`, which CI never sets... It asserts nothing about
  product behaviour."* Its anchored `identity: /^Sessions$/i`
  (`dashboard-screenshots.test.ts:65`) still needs updating for the new h1, but it will
  skip, not fail. The real gate is `dashboard-design-system.test.ts`, whose `/Sessions/i`
  is unanchored and survives the rename.
- **The browser mock proves almost nothing today.** `dashboard-mock-harness.ts:123`
  returns a single anonymous, zero-signal, unplayable session. Nothing in the e2e suite
  currently exercises identified rendering, occurrence counts, `With signals`, pagination,
  or the hint. **Extend the mock to cover: one identified session with multi-occurrence
  friction and errors, one anonymous clean session, one `closed` (queued) session, and one
  unplayable session** — otherwise the graded suite passes while every new behaviour is
  untested.
- **The 390×844 overflow gate is live.** `dashboard-design-system.test.ts:94` asserts
  `document.documentElement.scrollWidth <= clientWidth`, exactly one `<main>`, and that
  focus does not stay on `BODY`, for `/sessions`. Mirroring `ActivityFeed`'s
  `overflow-x-auto border-y` wrapper is what keeps it green.
- **`EXPLAIN ANALYZE` the new list query** with `has_signals` on and off. Confirm the
  planner uses `idx_error_events_session` and the `friction_signals` session-prefixed
  index inside both LATERAL blocks, and record the p95 baseline for the tripwire above.
- Grep the built `dist/assets/*.css` for each new Tailwind class. A v3→v4 token rename
  fails silently: a stale class emits no CSS and the build stays green.
- Live run: seed friction via the `test-fixtures/vue-app` Friction Lab, then confirm the
  Signals column renders real counts and that a clean session renders an empty cell.

## Implementation Tasks

Merged from the design review (T-series) and the engineering review (E-series). Where an
E task supersedes a T task, only the E task is listed. Lane letters map to the
parallelization table above.

**Lane A — ingestion (independent, start immediately)**

- [ ] **E1 (P1, human: ~4h / CC: ~30min)** — ingestion — Replace the three-query fan-out with two `LEFT JOIN LATERAL` blocks in `sessionSummarySelect`. *Supersedes T1.*
  - Surfaced by: Step 0 — the select already runs a correlated subquery per row at `sessions_read.go:61`, and `has_signals` forces friction predicates into the main query anyway, so the fan-out read `friction_signals` twice per request
  - Files: `packages/ingestion/db/sessions_read.go`
  - Verify: `go test ./db ./handler`; `EXPLAIN ANALYZE` shows index scans inside both LATERALs
- [ ] **E2 (P1, human: ~30min / CC: ~5min)** — ingestion — Add `fs.project_id = $1` and `ee.project_id = $1` inside both LATERAL blocks
  - Surfaced by: Architecture 2 — `packages/ingestion/AGENTS.md` requires every db helper to enforce project scope in its own query
  - Files: `packages/ingestion/db/sessions_read.go`
  - Verify: extend `TestSessionSummaryAndPlayableChunks_AreFailClosedAndScoped`
- [ ] **E3 (P1, human: ~1h / CC: ~10min)** — ingestion — Test that re-analysis at a new `rule_version` does not double-count. *Supersedes T2.*
  - Surfaced by: Failure modes — a silent correctness bug no error handling can surface
  - Files: `packages/ingestion/db/sessions_read_test.go`
  - Verify: `go test ./db`
- [ ] **E5 (P1, human: ~2h / CC: ~15min)** — ingestion — Session id search uses exact PK match; email and `external_user_id` keep `ILIKE`. *Supersedes T6.*
  - Surfaced by: Performance 6 — `EXPLAIN` on the live DB: `s.id ILIKE` costs 367.86, `s.id =` costs 4.29
  - Files: `packages/ingestion/db/sessions_read.go`
  - Verify: `go test ./db`; `EXPLAIN` shows `Index Cond: (id = ...)`
- [ ] **E13 (P2, human: ~1h / CC: ~10min)** — ingestion — Log list-query duration, record the p95 baseline as the denormalization tripwire
  - Surfaced by: Architecture 3 — `has_signals` scan cost is `51 / selectivity`
  - Files: `packages/ingestion/handler/session_read.go`
  - Verify: hit the endpoint, confirm the duration lands in logs

**Lane B — shared dashboard prep (independent, start immediately)**

- [ ] **E10 (P2, human: ~1h / CC: ~10min)** — dashboard — Consolidate the three duration formatters, fix the `SessionDetail` hour bug
  - Surfaced by: Code quality 4 — `SessionDetail.vue:41` renders `120m 30s` where the list renders `2h 0m`
  - Files: `admin-format.ts`, `views/SessionDetail.vue`, `views/SessionsList.vue`
  - Verify: `pnpm --filter @opslane/dashboard test`; open a >1h session on both screens
- [ ] **E11 (P2, human: ~30min / CC: ~5min)** — test-e2e — Add `sessions` to `ownedRoots`, register the row in `consumer-matrix.md`
  - Surfaced by: Test review 5 — a new `components/sessions/` dir escapes gates its sibling is subject to
  - Files: `test-e2e/dashboard-design-system.test.ts`, `docs/design/dashboard-v1/consumer-matrix.md`
  - Verify: `pnpm --filter @opslane/test-e2e test`

**Lane C — the screen (waits on A1 + B1)**
- [ ] **T3 (P1, human: ~4h / CC: ~30min)** — dashboard — Extract `SessionLedgerRow.vue` mirroring `IncidentLedgerRow` and rebuild the three-column table
  - Surfaced by: Pass 5 Design System — SessionsList uses none of the shared `ui/` components
  - Files: `packages/dashboard/src/views/SessionsList.vue`, `packages/dashboard/src/components/sessions/SessionLedgerRow.vue`
  - Verify: `pnpm --filter @opslane/dashboard test`
- [ ] **T4 (P1, human: ~1h / CC: ~10min)** — dashboard — Make each row one link containing play glyph and identity, 44px tap target
  - Surfaced by: Pass 1 IA + Codex finding 3 — two competing destinations for one task
  - Files: `packages/dashboard/src/components/sessions/SessionLedgerRow.vue`
  - Verify: keyboard-tab one row; exactly one stop
- [ ] **T5 (P1, human: ~2h / CC: ~15min)** — dashboard — Ship two distinct empty states plus SkeletonBlock loading and InlineAlert error with Retry
  - Surfaced by: Pass 2 Interaction States — a first-run user is told to change filters they never set
  - Files: `packages/dashboard/src/views/SessionsList.vue`
  - Verify: `pnpm --filter @opslane/dashboard test`
- [ ] **T7 (P2, human: ~1h / CC: ~10min)** — dashboard — Add `frictionSignalRecipe` and render chips via `StatusLabel`
  - Surfaced by: Pass 5 — SessionsList hand-rolls a `rounded-full` span
  - Files: `packages/dashboard/src/status-recipes.ts`, `.../SessionLedgerRow.vue`
  - Verify: `pnpm --filter @opslane/dashboard test`
- [ ] **T8 (P2, human: ~2h / CC: ~15min)** — dashboard — Implement the breakpoint matrix and assert it element-by-element
  - Surfaced by: Pass 6 Responsive — jsdom ignores Tailwind media queries, so column-count assertions cannot detect shear
  - Files: `.../SessionLedgerRow.vue`, `packages/dashboard/src/views/__tests__/SessionsList.test.ts`
  - Verify: `pnpm --filter @opslane/dashboard test` and `pnpm --filter @opslane/test-e2e test`
- [ ] **T9 (P2, human: ~1h / CC: ~10min)** — dashboard — Add table `aria-label`, `scope="col"`, `<time datetime>`, focus rings, non-link processing rows
  - Surfaced by: Pass 6 Accessibility — a disabled `router-link` is not a valid pattern
  - Files: `.../SessionLedgerRow.vue`, `packages/dashboard/src/views/SessionsList.vue`
  - Verify: keyboard pass + axe check
- [ ] **T10 (P2, human: ~30min / CC: ~5min)** — dashboard — Render page path as visible text at `≥1024px` instead of a `title` attribute
  - Surfaced by: Codex finding 6 — native `title` never appears on touch
  - Files: `.../SessionLedgerRow.vue`
  - Verify: manual check at 1024px and 375px
- [ ] **T11 (P3, human: ~30min / CC: ~5min)** — dashboard — Grep built `dist/assets/*.css` for every new Tailwind class
  - Surfaced by: Verification — a v3→v4 token rename fails silently and the build stays green
  - Files: `packages/dashboard/dist/assets`
  - Verify: `grep` each class in the built CSS
- [ ] **T12 (P1, human: ~2h / CC: ~15min)** — dashboard — Add the `All / With signals` segmented toggle. *Query side is E1; the `EXISTS` approach in the original T12 is superseded.*
  - Surfaced by: Design Pass 7 / Codex finding 2 — the screen claims to answer "which session should I watch?" but orders strictly newest-first
  - Files: `packages/dashboard/src/views/SessionsList.vue`
  - Verify: paging through a filtered set returns full pages, not short ones

**Added by the outside voice (Codex), verified before adoption**

- [ ] **E16 (P1, human: ~2h / CC: ~15min)** — ingestion + dashboard — Return a project-scoped `has_identified_sessions` boolean and gate the hint on it
  - Surfaced by: Codex — "every row on this page is anonymous" is invalid in both directions; identified sessions may be on page two, and one identified row suppresses the hint for a project with 198 anonymous sessions
  - Files: `packages/ingestion/db/sessions_read.go`, `.../handler/session_read.go`, `packages/dashboard/src/views/SessionsList.vue`
  - Verify: `go test ./db`; hint shows on a project with zero identified sessions and hides on one with any
- [ ] **E17 (P1, human: ~2h / CC: ~15min)** — test-e2e — Expand the sessions mock to four sessions covering identified+multi-occurrence, anonymous clean, `closed`, and unplayable
  - Surfaced by: Codex — the mock has one anonymous zero-signal unplayable session, so nothing proves identified rendering, occurrence counts, `With signals`, or the hint
  - Files: `test-e2e/dashboard-mock-harness.ts`
  - Verify: `pnpm --filter @opslane/test-e2e test`
- [ ] **E18 (P1, human: ~1h / CC: ~10min)** — dashboard — Copy-session-id control as a sibling of the row link, not nested inside it
  - Surfaced by: Codex — a `<button>` inside an `<a>` is invalid HTML and breaks keyboard order; exact-match search needs the full id copyable
  - Files: `packages/dashboard/src/components/sessions/SessionLedgerRow.vue`
  - Verify: validate markup; tab order gives link then copy, both reachable
- [ ] **E19 (P1, human: ~30min / CC: ~5min)** — dashboard — Fix `formatDuration` carry before consolidating onto it
  - Surfaced by: Codex, verified by execution — 3599.6s renders `59m 60s`, 7199s renders `1h 60m`
  - Files: `packages/dashboard/src/admin-format.ts`, `admin-format.test.ts`
  - Verify: boundary tests at 59.5s, 3599.5s, 7199s
- [ ] **E20 (P1, human: ~1h / CC: ~10min)** — ingestion — Search must also match `account_name` and `external_account_id`
  - Surfaced by: Codex — the plan removes the Account ID filter while the subtitle still promises browsing "by user, account, and time"
  - Files: `packages/ingestion/db/sessions_read.go`
  - Verify: `go test ./db`; searching "Acme" returns that account's sessions
- [ ] **E21 (P2, human: ~1h / CC: ~10min)** — dashboard — Label the header count `N loaded`, or add a real total to the contract
  - Surfaced by: Codex — `SessionListResponse` (`types/api.ts:230`) has no total, so `sessions.length` would render "50 records" for a 205-session project
  - Files: `packages/dashboard/src/views/SessionsList.vue`
  - Verify: load a project with more than one page; the header must not claim the page size is the corpus size

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 18 issues, 3 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | score: 4/10 → 10/10, 12 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** Outside voice ran twice (gpt-5.6-sol, high). Design pass cleared all 7 hard-rejection criteria, verdict REVISE, 4 findings adopted. Engineering pass found 14 defects, 11 adopted after verification against the code — including three the review itself introduced: `count(*)` instead of `sum(occurrence_count)`, adopting a `formatDuration` that renders `59m 60s`, and two wrong claims that the screenshot suite gates CI.

**CROSS-MODEL:** One unresolved tension, decided by the user. Codex rated the identity-led IA P0-premature given 96.6% anonymous sessions and argued signals should lead. Kept identity-led: the figure comes from a fixture database, not customer traffic, and the anonymous hint plus `setUser` docs address the cause rather than designing around it.

**VERDICT:** ENG + DESIGN CLEARED — ready to implement. 23 tasks across 3 lanes, 3 critical gaps all covered by tests (E3 double-counting, E4 silent filter drop, E6/E18 session-id copy).

NO UNRESOLVED DECISIONS
