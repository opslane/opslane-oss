# Unified Incidents: Bugs + Session Replay + Friction

**Date:** 2026-07-13
**Status:** Approved — v2 after Codex adversarial review (2026-07-13); v3 after re-verification against opslane-oss (2026-07-14); v4 after second Codex review (2026-07-14)
**Author:** Abhishek + Claude; adversarial review by Codex

## Problem

Opslane captures errors and fixes them. But most user pain never throws an exception: broken buttons that fail silently, forms people abandon, UI that makes users rage-click. Today that pain is invisible — the friction tables (in `001_baseline.sql`) exist but have never received a row, the SDK has no friction detection, replays are only reachable from inside an error incident, and replay capture defaults to off.

Competitors are converging from the other side: Lucent (AI session replay) records everything and has AI watch the recordings, producing bug reports. Their pitch validates our thesis — "don't make humans triage" — but they stop at filing a ticket. We go one step further: a verified fix.

## One-sentence design

Record every session cheaply (compressed, chunked), enrich the recording with a thin interaction-telemetry stream, detect friction server-side with versioned deterministic rules, promote repeated friction into the same incident pipeline errors use, and let customers climb an autonomy ladder from "ask me first" to "auto-fix" as the system earns trust.

## What changed in v4 (second Codex review)

The core concept held; a second adversarial pass found 20 issues in the *mechanisms*. 19 were accepted and are baked in below; 1 was deferred as a product decision. Two of the accepted findings describe live repository vulnerabilities and were filed as standalone security issues (#47, #48). Accepted corrections, by theme:

**Upload pipe (findings 1, 19, 11, 3)**
1. **Chunks need a commit signal.** A presigned PUT does not notify ingestion, so `uploaded_at`, `size_bytes`, `last_chunk_at`, scrub-queueing, session close, and re-analysis have no reliable trigger. Added an explicit per-chunk commit call (or storage bucket-event notification). Section 2.
2. **Every chunk carries a full rrweb snapshot** ("checkout" at each boundary). Without it, "sequence gaps tolerated" is false: rrweb diffs reference node ids from earlier chunks, so a lost chunk corrupts all following chunks until the next snapshot. Section 2.
3. **The ≤30s tab-close gate is loosened honestly.** `visibilitychange` cannot finish stringify + gzip + sign + PUT of a large chunk, and the in-memory retry buffer dies on navigation. Gate restated in terms of small keepalive-sized final flushes; the honest worst-case loss is documented, not hidden. Section 2 / Batch 1.
4. **Size-capped uploads (security, #48).** Public SDK key + presigned PUT with no byte cap = storage flood and gzip-bomb OOM. `content-length-range` policy, per-project byte budget, bounded streaming decompression. Section 2.

**Privacy fails open → fail closed (findings 2, 13, 16)**
5. **Fail-closed capture (security, #47).** Raw DOM lands before async scrubbing; the bundled bucket is anonymously downloadable, bypassing the authenticated re-scrub read path; the worker reads MinIO directly. Fix: private bucket, masking-at-capture as the primary defense, and **nothing may read or analyze a chunk until `scrubbed_at` is set.** Section 2 / 7.
6. **Selector + text fingerprints obey masking.** `data-*` values and normalized text can carry emails/IDs/secrets and are stored outside the masked recording and sent to the LLM. Allowlist stable attributes only; mask/hash the rest before storing. Section 3.
7. **Retention is mechanized.** Explicit evidence-pinning (which sessions an incident holds, until when), tombstones so re-uploads to deleted sessions are rejected, PII columns included in deletion sweeps, hard 90-day cap enforced. Section 7.

**Detection is causal, not proximal (findings 12, 5, 14)**
8. **Detectors attribute causality, not proximity.** Any unrelated poll/analytics/DOM tick — including Opslane's own chunk PUT — can suppress a dead-click verdict. Count only requests initiated from the click's own handler; filter the SDK's own traffic; **patch XHR `send()`, not just `open()`** (the v2/v3 "SDK already knows request-start" claim was wrong for XHR). Section 3.
9. **"Idempotent," not "exactly-once."** The `friction_signals` unique key makes duplicate inserts harmless but cannot retract a signal a late chunk disproves, nor count repeat occurrences within one session. Added an occurrence count and a supersede/retract path on re-analysis. Section 3.
10. **Correlation/aggregation order is fixed:** adjudicate → fold → aggregate the leftovers, and **both gates are scoped by environment** (staging friction never combines with prod). Section 3.

**Status and the pre-human check (findings 4, 10)**
11. **Two distinct states, not one overloaded `insight`.** `insight` = no code cause, terminal, never a PR. `awaiting_approval` = code cause, parked for a human. TriggerFix accepts only `awaiting_approval`, never `insight`. Section 4.
12. **Friction is gated out of auto-fix until Batch 5.** Detection turns on in Batch 4, but the existing worker auto-fixes high-confidence findings and stamps PRs "Opslane fixed"; without the gate, one batch of friction PRs would ship auto-generated and mislabeled. Section 4 / Batches.
13. **A real hidden candidate state before adjudication** (the list API currently shows every row immediately), plus a defined adjudicator-failure policy (retry, then surface flagged-unchecked — never silently publish or drop). Section 4.

**Two replay systems must connect (findings 6, 7, 8, 9, 18)**
14. **Bridge old and new replay models.** Dashboard + worker read `session_replays`; the new `sessions`/`session_chunks` tables must not orphan them. On error, record a *pointer* (session id + time range) into the chunk stream instead of a duplicate one-shot upload; migrate readers; retire the one-shot path. Section 1 / 6.
15. **Persist the chunk sequence counter** next to the session id (reload currently resets it and would overwrite `chunk-0`); add `analyzing` / `analysis_failed` / re-analysis-generation statuses; give `session_analysis` jobs a typed session FK (the dispatcher rejects jobs without `error_group_id` today). Section 1 / 3.
16. **Rotate the session on identity change.** One `end_user_id` per session mis-attributes shared-tab sessions (Alice's friction billed to Bob); friction-only sessions have no end-user-creation path today. Login/logout → new session. Section 2.
17. **Impact boost has explicit write paths.** Pointing `friction_signals.incident_id` at an error updates nothing the incident UI reads (affected-user count, account rollups, first/last seen, occurrence). Enumerate every impact read path and update it. Section 4.
18. **Schema ships its access paths.** Indexes for close sweeps (`last_chunk_at`), scrub queue (`scrubbed_at IS NULL`), sessions-by-user/account/time, and 7-day distinct-user-per-fingerprint aggregation. "Per-account flags" need an accounts entity — accounts are derived today, not a table. Section 1.

**Honest claims (findings 17, 20)**
19. **Receipts are idempotent + attributable.** GitHub redelivers webhooks; store the delivery id with a UNIQUE constraint; record the fix-job id on the PR at creation so outcomes are attributable. Section 5.
20. **Rollback story is per-change and honest.** "Ignore new columns" is true only for added columns. Dropped tables lose data; a Postgres enum value cannot be removed. Drops are deferred until the feature is stable; enum additions are permanent, so N−1 compatibility is designed, not assumed. Section 1.

**Deferred (finding 15) — product/legal decision, not resolved here:** always-on recording for everyone silently changes the meaning of an absent `replay` config and contradicts today's public opt-in promise (`docs/architecture/trust.md`). This is an explicit open decision (see Open Questions), owned outside this design. **Until it is decided, the design assumes opt-in remains the default** and always-on is gated behind an affirmative, versioned opt-in.

## What changed in v3 (post-migration re-verification)

The design was written against the `defender` repo; the code now lives in `opslane-oss` with a consolidated `001_baseline.sql`. Every factual claim was re-verified against this codebase on 2026-07-14:

1. **Replay upload is already two-phase presigned** (`POST /api/v1/replays/init` → browser PUT → `POST /api/v1/replays/{id}/complete`, `packages/ingestion/handler/replay.go:49,125`). Still one object per replay — chunking is real new work, but the init/finalize/presign pattern is a foundation to extend.
2. **The "existing Haiku triage stage" is not on the production path** (`packages/worker/src/agent-fix.ts:456-477` only fires when no precomputed investigation is passed). Batch 4 adjudication is new wiring, not reuse.
3. **The SDK already reports upload failures to `/replays/{id}/fail`** (`packages/sdk/src/replay.ts:238-247`) — the *server* route is missing (#13).
4. **New dependency: #25** — dead-lettered jobs stuck in `analyzing`; `session_analysis` inherits it.

## What changed in v2 (first Codex review)

1. rrweb alone cannot power the detectors → the SDK adds a **thin interaction-telemetry stream**.
2. The one-shot replay upload path is **not** a chunk protocol → chunked upload designed explicitly.
3. Sessions are in-memory per page load with no identity → durable session IDs + user linkage are prerequisites.
4. Batch order: the worker must understand friction **before** anything enqueues it.
5. Cost model redone with mandatory compression; schema section added; receipts need schema additions; privacy/retention made concrete.
6. Independent bug filed: client event timestamp dropped for server time (#27).

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Organizing primitive | One unified **incident** (kind: `error` \| `friction`) | One inbox, one status model, one pipeline, one bill. |
| Error+friction in same session | Fold friction into the error incident as evidence + impact boost, **with real write paths to every impact read** (v4-17) | One moment of pain = one incident. Depends on the client-timestamp fix (#27). |
| Capture policy | **Opt-in by default (unchanged from today) until the always-on decision is made** (v4-deferred); when enabled: rrweb + interaction telemetry, gzipped chunks every ~30s, each chunk self-contained (full snapshot) | Storage is cheap once compressed; analysis, not storage, is the cost. Always-on is a product/legal call, not assumed. |
| Chunk durability | **Server-acknowledged commit per chunk** (v4-1); **full rrweb snapshot at each chunk boundary** (v4-19); **size-capped presigned PUTs + per-project byte budget** (v4-3, #48) | A recording the server never hears about cannot be scrubbed, closed, or analyzed; a chunk that depends on a lost predecessor is unplayable; unbounded PUTs are a flood/OOM primitive. |
| SDK role | Recorder + **thin interaction telemetry** (click annotations, network-request-start markers via `send()`, form submits) as rrweb custom events | Server rules need signals rrweb doesn't carry. Detection logic stays server-side. |
| Friction detection location | **Server-side, on stored streams**, versioned rules | Detector iteration at deploy speed; retroactive re-analysis. |
| Detection method | Deterministic rules → threshold → LLM adjudication; **causal attribution, not temporal proximity** (v4-12); screenshots only on visual suspicion | Precision-at-the-human; rules give stable fingerprints; proximity gives false negatives on busy apps. |
| Signal semantics | **Idempotent inserts (not "exactly-once"), with occurrence count + retract-on-reanalysis** (v4-5) | The unique key dedupes; it cannot un-emit a disproven signal or count intensity. |
| Incident threshold | Friction → incident only after **5+ distinct end users, same fingerprint, same environment, rolling 7-day window** (v4-14 adds environment scoping) | Errors surface at occurrence 1; friction must not; staging must not mix with prod. |
| Correlation/aggregation order | **Adjudicate → fold → aggregate leftovers** (v4-14) | A folded false signal must not bypass the 5-user and LLM gates. |
| Friction pipeline outcome | Code cause → `awaiting_approval` (fix-eligible); no code cause → `insight` (terminal, **never a PR**) — two distinct states (v4-4) | The agent never pretends an opinion is a fix, and the "never" is enforceable. |
| Friction fix labeling | Friction-fix PRs ship labeled **Suggestion** until friction repro-tests exist; **friction is gated out of auto-fix until Batch 5** (v4-4) | Passing repo tests proves "nothing broke," not "the dead click is gone." No mislabeled auto-PRs in the Batch 4–5 gap. |
| Autonomy | Per-project ladder: **ask-first (default)** → auto-fix → auto-fix incl. UX suggestions (opt-in) | Trust earned per category. |
| Adjudication lifecycle | **Hidden `candidate` state the list API cannot see** + defined failure policy (retry → flag unchecked, never silent publish/drop) (v4-10) | "Checked before a human sees it" must be true on day one. |
| Learning loop v1 | Implicit receipts: `triggered_by` on fix jobs + immutable, **idempotent, attributable** `pr_outcomes` log (v4-17) | Merge/close webhook currently clears state and can redeliver; outcomes must be counted once and traced to a job. |
| Retention | 14–30 day deletion for chunks/sessions incl. **MinIO object deletion (new client op)**; **evidence-pinning + tombstones + PII-inclusive sweeps**; incident-referenced windows retained but hard-capped (90 days) (v4-16, #29) | "Open incidents retained" must not mean forever, and deletion must not orphan raw data or leave selector/text PII. |
| Privacy | **Fail-closed**: private bucket (#47), masking-at-capture primary + scrubber second pass, **read/analyze blocked until `scrubbed_at` set**, selector/text masked (v4-13), strict mode, runtime kill switch, consent snippet in Batch 1 docs | Recording is the FullStory posture — commitments, not parking. |
| Replay model migration | **Bridge `session_replays` ↔ `sessions`/`session_chunks`**: error replays become pointers into the chunk stream (v4-6) | Don't orphan the dashboard player/worker evidence; don't double-store every error moment. |
| Deferred | Custom behavioral signals, VLM-on-everything, autonomy auto-promotion, model-level learning; **always-on-by-default (v4-15, product decision)** | YAGNI until the core loop proves out. |

## Dependencies (must land first or alongside)

- **#27 client-timestamp bug**: store the SDK's event timestamp, not server arrival time — the ±30s correlation rule is meaningless without it.
- **#28 fair scheduling + per-type concurrency caps**: session analysis must not starve fix jobs.
- **#29 retention**: extended to sessions/chunks; MinIO delete op; now also evidence-pinning, tombstones, PII sweeps (v4-16).
- **#30 fingerprint normalization**: same deploy-survival thinking applies to friction selectors, and to masking selector/text (v4-13).
- **#13 replay `/fail` endpoint**: the SDK already posts upload failures there; the server route doesn't exist. Chunk error reporting builds on fixing it.
- **#25 dead-lettered jobs stuck in `analyzing`**: the fix must cover the new `session_analysis` job type.
- **#47 anonymous replay bucket** (security, live today): private bucket is a prerequisite for fail-closed privacy.
- **#48 unbounded presigned uploads** (security, live today): size-capped PUTs + byte budgets are a prerequisite for always-on chunk upload.

## Design

### 1. Schema (v4)

New tables (idempotent, append-only from `002`):

- **`sessions`** — id (client-generated, durable), project_id, environment_id, end_user_id (nullable), **next_chunk_seq (persisted, v4-15)**, started_at, last_chunk_at, chunk_count, status (`recording` | `closed` | `analyzing` | `analyzed` | `analysis_failed`, v4-15), analyzer_rule_version, **retain_until (nullable, v4-16)**.
- **`session_chunks`** — session_id, seq (unique per session), object_key, size_bytes (**set by the commit call, v4-1**), uploaded_at, scrubbed_at (nullable), **has_full_snapshot bool (v4-19)**. A chunk is invisible to analysis until `scrubbed_at` is set (v4-5 fail-closed).
- **`session_chunk_commits`** *(or a bucket-event ingest path)* — the server-side acknowledgement that object `object_key` for (session, seq) exists, its byte size, and content type. Nothing downstream trusts a chunk without a commit row.
- **`friction_signals`** — session_id, project_id, environment_id (v4-14), end_user_id (nullable), rule_version, signal_type, fingerprint, element_selector (**masked/allowlisted, v4-13**), page_url_normalized, occurred_at, **occurrence_count (v4-5)**, **superseded_by (nullable, v4-5)**, incident_id (nullable). UNIQUE(session_id, fingerprint, rule_version) for idempotent inserts; re-analysis writes a new row and sets `superseded_by` on the old one.
- **`error_groups`** gains `kind TEXT NOT NULL DEFAULT 'error' CHECK (kind IN ('error','friction'))`, nullable `signal_type` / `element_selector` / `page_url_normalized`, and status values `candidate` (hidden, v4-10), `awaiting_approval` and `insight` (v4-4).
- **`error_group_jobs`** gains `triggered_by TEXT` (`auto` | `human`) and a nullable typed **`session_id` FK** for `session_analysis` jobs (v4-15).
- **`pr_outcomes`** — immutable log: error_group_id, pr_number, outcome, occurred_at, **github_delivery_id (UNIQUE, v4-17)**, **fix_job_id (v4-17)**. Webhook writes here before any state clearing.
- **`accounts`** *(new entity, v4-18)* — accounts are derived today; per-account record/deep-analyze flags need a real row. Introduce the table or key flags by the derived account string and accept the coupling (decision in Batch 3).
- **project settings** — autonomy level per category; per-account flags.

**Indexes shipped with the schema (v4-18):** `session_chunks(scrubbed_at) WHERE scrubbed_at IS NULL`; `sessions(last_chunk_at) WHERE status='recording'`; `sessions(end_user_id, started_at)` and an account/time variant; `friction_signals(project_id, environment_id, fingerprint, occurred_at)` for the 7-day distinct-user aggregation.

**Replay bridge (v4-6):** on error, write a pointer (session_id + time range) rather than a duplicate one-shot upload; migrate `session_replays` readers (dashboard player, `replay-evidence.ts`) to resolve pointers; retire the one-shot path once readers are migrated.

Old `friction_groups`/`friction_events`/`friction_group_affected_users` (never populated — verify in prod before dropping): superseded; dropped in a Batch 3 cleanup.

**Migration safety (v4-20, honest per change):** added columns are reversible (old code ignores them). Dropping the old friction tables is **not** reversible — deferred until the feature is stable and prod-verified empty. Adding enum values (`candidate`, `awaiting_approval`, `insight`) is **permanent** — Postgres cannot remove an enum value — so N−1 compatibility (old workers meeting a new status) is designed explicitly, not assumed.

### 2. Capture: SDK = recorder + thin telemetry

- **Opt-in unchanged until the always-on decision (v4-15).** When recording is enabled:
- **Durable sessions**: session ID persisted in `sessionStorage`; **`next_chunk_seq` persisted alongside it (v4-15)** so a reload doesn't reset to `chunk-0`; rotated after 30 min idle **and on identity change — login/logout starts a new session (v4-16)**. `setUser()` updates the session server-side.
- **rrweb records continuously**; the SDK injects custom events: click annotations (derived selector, computed `cursor`), **network-request-start markers via patched XHR `send()` and fetch (v4-12)**, form-submit events. Detection logic stays server-side.
- **Chunk protocol (v4-1, v4-19, v4-3)**: `POST /sessions/init` registers the session; every ~30s (and on `visibilitychange`) the SDK gzips the buffer (`CompressionStream`) and PUTs `chunk-{seq}.json.gz` to a **size-capped presigned URL** (`content-length-range`, #48). **Each chunk begins with a full rrweb snapshot** so it is independently playable (v4-19). After each PUT the SDK **calls a commit endpoint** (or the server consumes a bucket notification) recording existence + size (v4-1). Failures retry with backoff into a bounded buffer.
- **Tab-close honesty (v4-11)**: the ≤30s gate is restated. On `visibilitychange` the SDK flushes only a **small keepalive-sized final segment** (the retry buffer does not survive navigation); large chunks are not guaranteed on abrupt close. Documented worst-case loss is stated plainly in Batch 1's gate rather than promised away.
- **Rate limits**: chunks get their own per-project **byte** budget (v4-3), not just a request-count limiter.
- **Fail-closed (v4-2 / #47)**: uploads go to a **private** bucket; masking-at-capture is the primary defense; a chunk is never read or analyzed until the scrubber sets `scrubbed_at`.
- Error capture unchanged and real-time. Runtime kill switch (config endpoint — new) and `replay: { enabled: false }` respected.

### 3. Detection: the four-layer pyramid

1. **Session close** → `session_analysis` job (new type, per-type concurrency cap, #28; typed session FK, v4-15). Deterministic rules over the stitched stream; versioned; re-analyzable. Size cap ~20MB **measured with a bounded streaming decompressor** (v4-3). Idempotent via the `friction_signals` unique key; occurrence counts and retraction handled by `occurrence_count` / `superseded_by` (v4-5).
   - **Rage+dead click**: 3+ clicks, same element, ~1s, no DOM mutation *and* no **causally-attributed** network-start (v4-12: only requests initiated from the click's handler count; SDK's own traffic and known pollers filtered).
   - **Dead click**: single click on a clickable-annotated element with no *causally-linked* response within ~1s; text-selection clicks ignored.
   - **Form abandonment (qualified)**: 2+ fields touched, 10+ seconds engaged, exit without submit — or strong variants.
   - **Retraction (v4-5)**: a late chunk that shows a response/mutation the first pass missed supersedes the earlier signal; if it was already folded/aggregated, the retraction propagates.
2. **Adjudicate → fold → aggregate (v4-14, fixed order):**
   - **LLM adjudication** first, into a hidden `candidate` state (v4-10).
   - **Fold** an adjudicated signal into an error incident when the same session had a captured error within ±30s (client timestamps, #27); nearest error wins.
   - **Aggregate** the leftovers: 5+ distinct `end_user_id`s on one fingerprint **in the same environment** in a rolling 7-day window → incident. Anonymous sessions count by session, flagged lower-confidence.
3. **Adjudicator lifecycle (v4-10)**: `candidate` rows are invisible to the list API; on adjudicator failure, retry, then surface flagged-unchecked — never silently publish or drop. Verdict, model id, and prompt version are logged.
4. **Flagged-account deep sweeps**: async LLM over full-session narratives; **screenshot rendering is real new infra** (headless rrweb player) scoped to the final batch.

**Selector fingerprinting (v4-13, privacy-safe):** derive selectors by priority — `data-testid`/allowlisted `data-*` → `id` (if not hash-like) → tag + **masked** normalized text → DOM path with dynamic classes stripped (hash-detection family of #30). Non-allowlisted attribute values and free text are masked/hashed before storage and never sent raw to the LLM. Page URLs normalized. Iframes/shadow DOM out of scope v1.

### 4. Pipeline: same queue, two verdicts, an autonomy ladder

Sequencing (v2, reaffirmed): the worker learns friction before anything enqueues it — `kind` awareness, friction evidence path (skip the no-app-frames guard and sourcemaps), the new statuses, and TriggerFix changes ship in Batch 3; detection turns on in Batch 4.

**Two terminal-ish states (v4-4):**
- **`insight`** — no code cause. Terminal. **Never becomes a PR.** TriggerFix rejects it.
- **`awaiting_approval`** — code cause, parked for a human. TriggerFix accepts *only* this.

**Auto-fix gate (v4-4):** the existing worker auto-fixes high-confidence findings (`index.ts:317`) and stamps PRs "Opslane fixed" (`pr.ts:266`). Friction is **hard-gated out of auto-fix until Batch 5** ships ask-first routing + Suggestion labels, so no friction PR ever goes out auto-generated or mislabeled in the Batch 4–5 gap.

Autonomy ladder per project: **Ask first** (friction default) → **Auto-fix** (code-caused friction, only after the gate lifts) → **Auto-fix incl. UX suggestions** (opt-in, Suggestion-labeled only).

Precision gate honesty (v2): friction fixes pass the same tests+judge gate but ship **Suggestion**, because the gate proves "nothing broke," not "the dead click is gone." Upgrade to **Verified** is repro-test-first.

**Impact write paths (v4-17):** folding a signal into an incident updates every read the incident UI shows — `error_group_affected_users`, `affected_users_count`, account rollups, first/last seen, occurrence count — not just `friction_signals.incident_id`.

Lifecycle: silence-based auto-resolve checks `friction_signals` (not just `error_events`) for friction incidents; affected-user impact ordering is new list-API work; the #25 dead-letter fix covers `session_analysis`.

### 5. Learning loop: receipts (idempotent + attributable)

Per category: suggested → generated (`triggered_by='human'`) → merged/closed (from `pr_outcomes`). **Idempotent (v4-17):** store GitHub's `github_delivery_id` with a UNIQUE constraint so redelivered webhooks don't double-count. **Attributable (v4-17):** record `fix_job_id` on the PR at creation. One aggregation query; stats beside each toggle.

### 6. Dashboard

One inbox with kind badges; `candidate` rows hidden (v4-10). Incident page = narrative + inline player (**resolving replay pointers, v4-6**) + affected users + PR-or-insight card. **Sessions section** (browse by user/account/time). Autonomy settings with receipts. **Verified** only ever means tests-passed + judge-passed.

### 7. Retention & privacy (v4-16, v4-2)

- **Deletion mechanism**: a retention job deletes session/chunk rows *and* MinIO objects (new client delete op, #29) past 14–30 days.
- **Evidence pinning**: incident-referenced sessions set `retain_until`; the sweep skips pinned sessions but enforces a hard 90-day cap even when pinned.
- **Tombstones**: a deleted session id is tombstoned so a still-valid presigned URL cannot recreate orphaned raw data.
- **PII in the sweep**: `friction_signals` selector/text columns are included in deletion, not left behind.
- **Fail-closed read path**: private bucket (#47), no analysis before `scrubbed_at`, worker re-scrub on read.

## Cost model (v2 — compression mandatory)

Unchanged from v3. Raw rrweb 10-min session ~2–6MB → gzipped ~200–800KB; ~$ single digits/month per 1,000 sessions/day, bounded by retention. **Full-snapshot-per-chunk (v4-19) adds bytes** — budget for it; still cheap. Deterministic analysis: CPU, benchmark gate in Batch 3. LLM: only post-threshold + flagged accounts. Client cost: gzip on worker-thread cadence; measure mobile CPU/battery in Batch 1.

## Testing

- Chunk protocol: out-of-order, gap, late-chunk-after-close, retry-after-failure, offline overflow, gzip round-trip, **commit-call correctness (v4-1)**, **each chunk independently playable (v4-19)**, **oversized/gzip-bomb rejected (v4-3)**.
- Session identity: survives navigation; **seq counter survives reload (v4-15)**; rotates after idle; **rotates on login/logout (v4-16)**; `setUser` mid-session; two tabs = two sessions.
- Analyzer golden files: rage+dead, stepper false-positive, text-selection, slow-async guard, form-abandon variants; **causal-attribution: unrelated poll does not suppress a dead click (v4-12)**; **retraction on late chunk (v4-5)**; rule-v2 re-analysis idempotency.
- Aggregation: 4 users no incident, 5th incident; **staging+prod not mixed (v4-14)**; anonymous fallback flagged; window expiry.
- Correlation: **adjudicate→fold→aggregate order (v4-14)**; ±30s fold; nearest-error; outside-window standalone; **folded false signal cannot bypass gates**.
- Pipeline: friction skips no-app-frames guard + sourcemaps; **`insight` rejected by TriggerFix, `awaiting_approval` accepted (v4-4)**; **friction never auto-fixes before Batch 5 (v4-4)**; Suggestion asserted, Verified never; **`candidate` hidden from list API (v4-10)**; **impact numbers update on fold (v4-17)**.
- Receipts: `triggered_by` recorded; **redelivered webhook counted once (v4-17)**; `pr_outcomes` written before state clearing; stats query correctness.
- Retention: MinIO deletion; **pinned session retained then hard-capped at 90 days; tombstone rejects re-upload; PII columns deleted (v4-16)**.
- Privacy: masked-input fixture absent from chunks; **selector/text masked (v4-13)**; **no analysis before `scrubbed_at` (v4-2)**; strict mode; chunk-scrubber runs; read-path re-scrub; **anonymous GET returns 403 (#47)**.

## Delivery batches (v4 order)

**Batch 1 — Record reliably ("the footage exists")** *(the big one)*
Durable sessions + **persisted seq counter** + identity + **rotate-on-identity-change**, interaction telemetry (**`send()` patch**), chunk protocol (endpoints, **commit call**, **full-snapshot-per-chunk**, **size-capped PUTs + byte budget**, retry), gzip, **fail-closed private bucket + chunk-scrubber + no-read-before-scrub**, retention incl. MinIO deletion + **evidence-pinning + tombstones**, kill switch, consent snippet, mobile CPU. **Prereqs: #47, #48.** Gate: dogfood sessions visible, stitched, scrubbed, compressed; each chunk independently playable; old chunks deleted; abrupt tab close loses at most the documented worst-case (honest number, not ≤30s by fiat).

**Batch 2 — See it ("Sessions in the dashboard")**
Sessions index by user/account/time; player over stitched chunks (**pointer resolution for error replays, v4-6**). Gate: watch any dogfood session end-to-end.

**Batch 3 — Teach the system friction exists ("no producers yet")**
Schema (kind, `candidate`/`awaiting_approval`/`insight`, friction_signals with occurrence/supersede, settings, receipts columns, **accounts entity decision**, indexes), worker friction path (guards, evidence, prompts, judge section), TriggerFix accepts `awaiting_approval` only, analyzer built + benchmarked without enqueueing. Gate: replayed fixture sessions produce correct signals at target speed; a hand-created friction incident flows to `insight`/`awaiting_approval` without auto-termination.

**Batch 4 — Turn detection on ("friction becomes incidents")**
Adjudicate→fold→aggregate (after #27), environment-scoped thresholds, **hidden `candidate` state + adjudicator-failure policy**, **friction hard-gated out of auto-fix**, one inbox with kind badges. Gate: seeded rage-click sessions → exactly one friction incident, correct env-scoped affected-user count, **impact numbers updated**; stepper fixture → none; no auto-PR emitted.

**Batch 5 — The ladder ("act on it")**
Insight cards + Generate fix (from `awaiting_approval` only), autonomy settings + **idempotent/attributable receipts**, Suggestion labeling, auto-fix gate lifted. Gate: real dogfood friction incident goes `awaiting_approval` → click → Suggestion PR with the gate intact.

**Batch 6 — Flagged-account deep tier (only on design-partner demand)**
Full-session LLM sweeps; headless rrweb renderer for screenshots (real infra). Gate: one flagged account yields a subtle-friction insight rules couldn't catch.

## Open questions (parked, with owners)

- **Always-on vs. opt-in (v4-15, product/legal):** does recording default on for everyone, silently changing an absent `replay` config and today's public opt-in promise? **Owned outside this design; until decided, opt-in stays the default.** Blocks Batch 1's capture-policy shape.
- Pricing: does a friction fix bill like an error fix? Decide before Batch 5.
- Consent tooling: snippet ships in Batch 1 docs; full consent-management is customer-side.
- Mobile chunk cadence vs battery: measure in Batch 1; fallback 60s cadence + visibility-only flushes.
- Anonymous-session aggregation: session-count fallback good enough, or keep anonymous friction sub-threshold? Decide with Batch 4 data.
- Accounts entity (v4-18): real table vs. keying flags by derived account string — decide in Batch 3.
