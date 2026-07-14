# Unified Incidents: Bugs + Session Replay + Friction

**Date:** 2026-07-13
**Status:** Approved — v2 after Codex adversarial review (2026-07-13); v3 after re-verification against opslane-oss (2026-07-14)
**Author:** Abhishek + Claude; adversarial review by Codex

## Problem

Opslane captures errors and fixes them. But most user pain never throws an exception: broken buttons that fail silently, forms people abandon, UI that makes users rage-click. Today that pain is invisible — the friction tables (in `001_baseline.sql`) exist but have never received a row, the SDK has no friction detection, replays are only reachable from inside an error incident, and replay capture defaults to off.

Competitors are converging from the other side: Lucent (AI session replay) records everything and has AI watch the recordings, producing bug reports. Their pitch validates our thesis — "don't make humans triage" — but they stop at filing a ticket. We go one step further: a verified fix.

## One-sentence design

Record every session cheaply (compressed, chunked), enrich the recording with a thin interaction-telemetry stream, detect friction server-side with versioned deterministic rules, promote repeated friction into the same incident pipeline errors use, and let customers climb an autonomy ladder from "ask me first" to "auto-fix" as the system earns trust.

## What changed in v3 (post-migration re-verification)

The design was written against the `defender` repo; the code now lives in `opslane-oss` with a consolidated `001_baseline.sql`. Every factual claim was re-verified against this codebase on 2026-07-14. The design holds; four things changed:

1. **Replay upload is already two-phase presigned**, not a bare one-shot POST: `POST /api/v1/replays/init` returns a presigned MinIO PUT URL; the browser PUTs the full JSON; `POST /api/v1/replays/{id}/complete` finalizes (`packages/ingestion/handler/replay.go:49,125`). Still one object per replay — chunking (manifest, sequencing, per-chunk retry, compression) remains real new work — but the init/finalize/presign pattern is a foundation to extend, not build from zero.
2. **The "existing Haiku triage stage" is not on the production path.** It exists (`packages/worker/src/agent-fix.ts:456-477`) but only fires when no precomputed investigation is passed; the normal pipeline runs the Sonnet investigation first and skips it. Batch 4's LLM adjudication is wiring work, not pure reuse.
3. **The SDK already reports upload failures to `/replays/{id}/fail`** (`packages/sdk/src/replay.ts:238-247`) — the *server* route is what's missing (#13). Chunk-upload failure reporting builds on fixing #13, not on an existing endpoint.
4. **New dependency: #25** (dead-lettered investigate jobs leave groups stuck in `analyzing` forever). The new `session_analysis` job type inherits the same failure mode; the dead-letter fix must cover it.

Dependency issues were re-filed in opslane-oss; all links below now point at this repo's tracker. Note also: migrations here are consolidated into `001_baseline.sql` and new schema changes are append-only starting at `002`.

## What changed in v2 (Codex review findings)

The concept survived review; three "reuse existing machinery" claims did not. Corrections baked in below:

1. rrweb alone cannot power the detectors (no network-start, no clickability) → the SDK adds a **thin interaction-telemetry stream**; it is a recorder-plus-annotations, not a dumb recorder.
2. The one-shot replay upload path is **not** a chunk protocol → chunked upload is designed explicitly (manifest, sequencing, finalization, compression, retry, its own rate budget).
3. Sessions today are in-memory per page load and carry no user identity → durable session IDs + user linkage are prerequisites for aggregation and the sessions browser.
4. Batch order fixed: the worker must understand friction **before** anything enqueues it (the current worker would auto-terminate friction jobs via the no-app-frames guard).
5. Cost model redone with mandatory compression; a schema section added; receipts corrected (they need two small schema additions, they don't exist for free); privacy/retention commitments made concrete.
6. Independent bug found during review, filed separately: ingestion parses the client event timestamp and then stores server time instead (#27) — correlation windows depend on fixing this.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Organizing primitive | One unified **incident** (kind: `error` \| `friction`) | One inbox, one status model, one pipeline, one bill. |
| Error+friction in same session | Fold friction into the error incident as evidence + impact boost | One moment of pain = one incident. Depends on the client-timestamp fix (#27). |
| Capture policy | **Always-on recording for everyone**: rrweb + interaction telemetry, gzipped chunks every ~30s | Storage is cheap once compressed; analysis, not storage, is the cost. |
| SDK role | Recorder + **thin interaction telemetry** (click annotations, network-start markers, form submits) injected as rrweb custom events | Server rules need signals rrweb doesn't carry. ~50–100 lines client-side; detection logic still lives server-side. |
| Friction detection location | **Server-side, on stored streams**, versioned rules | Detector iteration at deploy speed, not SDK-upgrade speed; retroactive re-analysis of stored sessions. |
| Detection method | Deterministic rules → threshold → LLM adjudication; screenshots only on visual suspicion | Precision-at-the-human is what matters; rules give stable fingerprints. |
| Incident threshold | Friction signal → incident only after **5+ distinct end users**, same fingerprint, within a rolling 7-day window | Errors surface at occurrence 1; friction must not. |
| Friction pipeline outcome | Code cause → fix-eligible; no code cause → **insight** (never a PR) | The agent never pretends an opinion is a fix. |
| Friction fix labeling | Friction-fix PRs ship labeled **Suggestion** until friction repro-tests exist | Codex is right: passing repo tests does not prove a dead click is fixed. "Verified" stays honest. Upgrades to Verified when repro-test-first lands. |
| Autonomy | Per-project ladder: **ask-first (default)** → auto-fix → auto-fix incl. UX suggestions (opt-in) | Trust earned per category. |
| Learning loop v1 | Implicit receipts, enabled by two schema additions: `triggered_by` on fix jobs + immutable `pr_outcomes` log | Merge/close webhook exists but currently clears state (`TransitionOnPRClose` wipes `pr_url`/`pr_number`); outcomes must be recorded immutably to be countable. |
| Retention | 14–30 day deletion for chunks/sessions, **including MinIO object deletion (new client op)**; incident-referenced windows retained but capped (90 days hard) | "Open incidents retained" must not silently mean forever. |
| Privacy | Masked inputs + a **strict mode** (mask all text); chunk-scrubber job shortly after upload; read-path re-scrub (existing pattern); runtime recording kill switch via config; consent-language snippet shipped with Batch 1 docs | Recording everything is the FullStory posture — commitments, not parking. |
| Deferred | Custom behavioral signals, VLM-on-everything, autonomy auto-promotion, model-level learning | YAGNI until the core loop proves out. |

## Dependencies (must land first or alongside)

- **#27 client-timestamp bug**: store the SDK's event timestamp, not server arrival time — the ±30s correlation rule is meaningless without it.
- **#28 fair scheduling + per-type concurrency caps**: session analysis must not starve fix jobs; friction incidents ride the same queue only with caps in place.
- **#29 retention**: extended to sessions/chunks; MinIO delete operation added (the MinIO client currently has no delete op at all).
- **#30 fingerprint normalization**: same deploy-survival thinking applies to friction selectors (below).
- **#13 replay `/fail` endpoint**: the SDK already posts upload failures there; the server route doesn't exist. Chunk upload error reporting builds on fixing it.
- **#25 dead-lettered jobs stuck in `analyzing`**: the fix must cover the new `session_analysis` job type, or dead-lettered analysis silently strands sessions.

## Design

### 1. Schema (new section — v2)

New tables (idempotent migrations, append-only starting at `002`):

- **`sessions`** — id (client-generated, durable), project_id, environment_id, end_user_id (nullable, set when `setUser` fires), started_at, last_chunk_at, chunk_count, status (`recording` | `closed` | `analyzed`), analyzer_rule_version.
- **`session_chunks`** — session_id, seq (unique per session), object_key, size_bytes, uploaded_at, scrubbed_at (nullable). Sequence gaps tolerated; late chunks accepted within a grace window, marked for re-analysis.
- **`friction_signals`** — pre-threshold signal store: session_id, project_id, end_user_id (nullable), rule_version, signal_type, fingerprint, element_selector, page_url_normalized, occurred_at, incident_id (nullable; set when attached/promoted). UNIQUE(session_id, fingerprint, rule_version) makes re-analysis idempotent: new rule version inserts new rows; aggregation reads only the latest version per session.
- **`error_groups`** gains `kind TEXT NOT NULL DEFAULT 'error' CHECK (kind IN ('error','friction'))` plus nullable `signal_type`, `element_selector`, `page_url_normalized`.
- **`error_group_jobs`** gains `triggered_by TEXT` (`auto` | `human`) — receipts prerequisite.
- **`pr_outcomes`** — immutable log: error_group_id, pr_number, outcome (`merged` | `closed`), occurred_at. Webhook writes here **before** any state clearing.
- **project settings** — autonomy level per category; per-account "record + deep-analyze" flags.

Old `friction_groups`/`friction_events`/`friction_group_affected_users` (in `001_baseline.sql:379-459`, never populated — verify in prod before dropping): superseded; removed in a cleanup migration during Batch 3.

Migration safety: additive columns with defaults; no rewrite of existing rows; `kind='error'` backfills by default; rollback = ignore new columns.

### 2. Capture: SDK = recorder + thin telemetry

- **Durable sessions**: session ID persisted in `sessionStorage`, rotated after 30 min idle; survives navigations within a tab. `setUser()` updates the session server-side (identity rides the session, not just error payloads). Today the session ID is an in-memory module variable (`packages/sdk/src/session.ts`) regenerated per page load, and `setUser` attaches only to error payloads — both change.
- **rrweb records continuously**; the SDK injects **custom events into the same stream**: click annotations (derived selector, computed `cursor` style at click time), network-request-start markers (the SDK already patches fetch/XHR — it knows when requests *begin*), form-submit events. All detection *logic* stays server-side; the client only annotates facts it alone can observe.
- **Chunk protocol (new endpoints, extending the existing presigned init/complete pattern)**: `POST /sessions/init` registers the session and returns a signing route; every ~30s (and on `visibilitychange`) the SDK gzips the buffer (`CompressionStream`, ~8–10x on rrweb JSON) and PUTs `chunk-{seq}.json.gz`. Upload failures retry with backoff and requeue the chunk (bounded in-memory buffer, oldest-dropped). No explicit "complete" call: the server closes a session after N minutes without chunks; late chunks within a grace window reopen analysis.
- **Rate limits**: chunks get their own per-project budget sized for concurrent sessions (the current 120/min replay limiter would cap out at ~30 concurrent sessions).
- Error capture unchanged and real-time. Recording has a runtime kill switch (config endpoint — new; no runtime config fetch exists in the SDK today) and respects `replay: { enabled: false }`.

### 3. Detection: the four-layer pyramid

1. **Session close** → analyzer job (new `session_analysis` job type in the existing jobs table, with a **per-type concurrency cap** so analysis never starves fix jobs). Deterministic rules over the stitched stream — plain code, no LLM. Rules are versioned; stored sessions re-analyzable. Session size capped (~20MB uncompressed; oversized sessions analyzed on the first 20MB, flagged). Exactly-once via the `friction_signals` unique key.
   - **Rage+dead click**: 3+ clicks, same element, ~1s, AND no DOM mutation *and* no network-start marker following each click.
   - **Dead click**: single click on a clickable-annotated element with no response within ~1s; text-selection clicks ignored.
   - **Form abandonment (qualified)**: 2+ fields touched, 10+ seconds engaged, exit without a submit event — or the strong variants (validation error then exit; same field retyped 3+).
2. **Aggregation**: 5+ distinct `end_user_id`s on one fingerprint in a rolling 7-day window → incident (or fold, per correlation below). Anonymous sessions (no user set) count by session as a fallback, flagged lower-confidence.
3. **LLM adjudication** before any human sees the incident. Note (v3): the Haiku triage stage exists in code (`agent-fix.ts`) but is skipped on the production path — this step is new wiring, not reuse.
4. **Flagged-account deep sweeps**: async LLM over full-session event narratives; **screenshot rendering is real new infra** (headless browser running the rrweb player — `visual-analysis.ts` only consumes screenshots, it does not produce them) and is scoped to the final batch, built only when a design partner asks.

**Selector fingerprinting spec** (the stability problem, stated honestly): derive selectors by priority — `data-testid`/`data-*` attrs → `id` (if not hash-like) → tag + normalized text content → DOM path with dynamic-looking classes stripped (same hash-detection family as #30). Page URLs normalized (IDs/UUIDs → placeholders). Fingerprints will still fragment on redesigns; re-analysis with new rule versions is the recovery tool. Iframes and shadow DOM: out of scope v1, signals suppressed there.

**Correlation**: a friction signal folds into an error incident when the same session contains a captured error within ±30s (client timestamps; requires #27). Multiple candidate errors: nearest wins. Folded signals are stored as `friction_signals` rows pointing at the incident (bounded, occurrence-linked) — not accumulated JSONB.

### 4. Pipeline: same queue, two verdicts, an autonomy ladder

Sequencing rule (v2): **the worker learns friction before anything enqueues it.** Concretely: `kind` awareness, a friction evidence path (skip the no-app-frames guard for friction; skip sourcemaps), an `insight` status in the shared enum, and TriggerFix accepting `insight` — all ship in Batch 3, and only Batch 4 turns detection on. (Verified: the guard at `packages/worker/src/index.ts:168-185` terminates any stackless job today; TriggerFix accepts only `investigated`.)

Friction investigation evidence: event-stream narrative, selector + page, replay links, repo code around the selector (grep by selector/text). Verdicts: **code cause** → fix-eligible via the autonomy ladder; **no code cause** → `insight` (terminal until a human acts).

Autonomy ladder per project (settings + receipts):
- **Ask first** (friction default): insight card with **Generate fix** → TriggerFix (now accepting `insight`).
- **Auto-fix**: code-caused friction routes straight through.
- **Auto-fix incl. UX suggestions**: explicit opt-in; suggestion-labeled PRs only.

Precision gate honesty (v2): friction fixes pass the same tests+judge gate but ship labeled **Suggestion**, because the gate proves "nothing broke," not "the dead click is gone." The judge prompt gains a friction-evidence section. The upgrade path to a true **Verified** label for friction is repro-test-first (agent writes a failing test reproducing the broken interaction) — already on the roadmap; this design raises its priority.

Lifecycle fixes that unified incidents require: silence-based auto-resolve checks `friction_signals` (not just `error_events` — `resolveSilentMergedGroups` keys solely on `error_events` today) for friction incidents; "impact ordering" (affected-users sort) is **new work** in the list API, not existing behavior; the dead-letter fix (#25) must cover `session_analysis` jobs.

### 5. Learning loop: receipts (with the two schema additions)

Per category: suggested → generated (`triggered_by='human'` fix jobs) → merged/closed (from `pr_outcomes`, immutable) → archived insights. One aggregation query; stats beside each toggle. Explicit 👍/👎 deferred to v2 of the loop.

### 6. Dashboard

One inbox with kind badges; incident page = narrative + inline player + affected users + PR-or-insight-card; **Sessions section** (browse by user/account/time — requires the session identity work in Batch 1; today `ReplayPlayer.vue` is reachable only from `IncidentDetail.vue`); autonomy settings with receipts; the label rule: **Verified** only ever means tests-passed + judge-passed.

## Cost model (v2 — compression mandatory)

- Raw rrweb for an active 10-min session: ~2–6MB uncompressed. Gzipped: ~200KB–800KB. 1,000 sessions/day ≈ 0.2–0.8GB/day ≈ single-digit dollars/month at S3 pricing, bounded by retention. PUT request costs at 30s chunking: ~20 PUTs/session ≈ $0.10/day per 1,000 sessions. Egress only on watch/analyze.
- Deterministic analysis: CPU, fractions of a cent per session; benchmark gate in Batch 3 (must prove ~O(seconds) on the 95th-percentile session before enabling by default).
- LLM: only post-threshold incidents + flagged accounts. Always-on tier adds ~zero LLM cost by design.
- Client cost: gzip on a worker-thread cadence; measure CPU/battery on low-end mobile in Batch 1 (open question below).

## Testing

- Chunk protocol: out-of-order upload, gap, late chunk after close, retry-after-failure, offline buffer overflow (oldest dropped), gzip round-trip.
- Session identity: survives navigation; rotates after idle; `setUser` mid-session links user; two tabs = two sessions.
- Analyzer golden files: fixtures → expected signals (rage+dead, stepper false-positive, text-selection, slow-async guard, all form-abandon variants); rule v2 re-analysis idempotency (unique key holds).
- Aggregation: 4 users no incident, 5th user incident; anonymous-session fallback flagged; window expiry.
- Correlation: ±30s fold (client timestamps), nearest-error rule, outside-window standalone.
- Worker: friction job skips no-app-frames guard and sourcemaps; insight status writes; TriggerFix accepts insight; ladder routing per setting; Suggestion label asserted on friction PRs; Verified never appears on them.
- Receipts: `triggered_by` recorded; `pr_outcomes` written before state clearing; stats query correctness.
- Retention: MinIO deletion works; incident-referenced sessions retained but hard-capped at 90 days.
- Privacy: masked-input fixture absent from stored chunks; strict mode masks text; chunk-scrubber runs; read-path re-scrub.

## Delivery batches (v2 order)

**Batch 1 — Record reliably ("the footage exists")** *(the big one — roughly 2x the original estimate)*
Durable sessions + identity, interaction telemetry, chunk protocol (endpoints, manifest, rate budget, retry), gzip, chunk-scrubber, retention incl. MinIO deletion, kill switch, consent-language snippet in docs, mobile CPU measurement. Gate: dogfood sessions visible, stitched, scrubbed, compressed; old chunks deleted; a mid-session tab close loses ≤30s.

**Batch 2 — See it ("Sessions in the dashboard")**
Sessions index by user/account/time; player over stitched chunks. Gate: watch any dogfood session end-to-end.

**Batch 3 — Teach the system friction exists ("no producers yet")**
Schema (kind, insight status, friction_signals, settings, receipts columns), worker friction path (guards, evidence, prompts, judge section), TriggerFix accepts insight, analyzer built + benchmarked against stored sessions **without enqueueing incidents**. Gate: replayed fixture sessions produce correct signals at target speed; a hand-created friction incident flows through worker to insight without being auto-terminated.

**Batch 4 — Turn detection on ("friction becomes incidents")**
Aggregation threshold, correlation (after #27), adjudication, one inbox with kind badges. Gate: seeded rage-click sessions on the dogfood app → exactly one friction incident, correct affected-user count; stepper fixture → none.

**Batch 5 — The ladder ("act on it")**
Insight cards + Generate fix, autonomy settings + receipts stats, Suggestion labeling. Gate: real dogfood friction incident goes insight → click → Suggestion PR (or writeup) with the gate intact.

**Batch 6 — Flagged-account deep tier (only on design-partner demand)**
Full-session LLM sweeps; headless rrweb renderer for screenshot analysis (real infra, scoped here, not "reused"). Gate: one flagged account yields a subtle-friction insight rules couldn't catch.

## Open questions (parked, with owners)

- Pricing: does a friction fix bill like an error fix? (Presumably yes; decide before Batch 5.)
- Consent tooling: snippet ships in Batch 1 docs; full consent-management is customer-side — confirm with design partners' counsel.
- Mobile chunk cadence vs battery: measure in Batch 1; fallback is 60s cadence + visibility-only flushes.
- Anonymous-session aggregation: is session-count fallback good enough, or should anonymous friction stay sub-threshold? Decide with Batch 4 data.
