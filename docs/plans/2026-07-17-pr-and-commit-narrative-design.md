# PR & Commit Narrative — Making Opslane's Output Read Like a Great Engineer Wrote It

**Date:** 2026-07-17
**Status:** v2 after design review (2026-07-17). Changes: inline replay media reframed as intentional publication (Camo caches beyond origin expiry — consent/redaction/retention model required); verification claims generated from individual check outcomes only (no invented counts, baseline-aware wording); typed `FixNarrative` contract defined BEFORE commit generation and rendered into both commit and PR from one object; friction semantics explicitly preserved (this plan scopes narrative changes to `kind === 'error'`); Tier A timing gated on structured fields that do not exist yet; two separate link policies (incident link ≠ GitHub-fetchable media) and the `DASHBOARD_ORIGIN` fallback removed; slot-specific validators instead of one normalizer; acceptance now inspects the pushed commit itself.
**Author:** Abhishek + Claude; grounded in a live `pr_created` run (opslane-vue-test PR #2), external research, and an independent design review
**Depends on:** evidence-tiered verification Phase 0/1 (landed)

## Why this matters

The PR is the product's face. A customer may never open the dashboard — their whole experience of Opslane is the PR that lands in their repo. Every defect below was observed on the first real `pr_created` (2026-07-17):

1. **Commit message is broken.** Subject: `fix: TypeError: Cannot destructure property 'name' of 'props.user.profile' as` — the raw error string, truncated mid-word, no body, no link. It fails every one of the classic "seven rules."
2. **"The fix" section mangles markdown.** `buildFixLine` renders `Addresses ${sanitizeInline(rootCause)}` — `sanitizeInline` (pr.ts:125) does not strip markdown headers, so the agent's `## Summary **Root Cause:** …` is inlined verbatim.
3. **Truncation cuts mid-code-fence.** The same helper collapses newlines and hard-slices at a length cap, ending the section with a dangling `` ```typescript if (!p ``.
4. **The dashboard deep link is unreliable and buried.** `buildReplayLink` (pr.ts:117) renders below the diff, and reads `DASHBOARD_URL ?? DASHBOARD_ORIGIN`. In the bundled Compose file the **worker receives neither variable** (only ingestion gets `DASHBOARD_ORIGIN`, docker-compose.yml:63; the worker env block starts at :90), so the shipped default behavior is *link silently omitted*. When `DASHBOARD_ORIGIN` is set on the worker it may also be a CORS origin (possibly internal), which is the wrong source for a reader-facing URL.
5. **No visual of the failure.** We record the user's session — the single most explanatory artifact we own — and the PR shows none of it.

## Research (what good looks like)

- **Commit messages** — the canonical seven rules ([cbea.ms/git-commit](https://cbea.ms/git-commit/)): subject ≤50 chars, capitalized, imperative, no period; blank line; body wrapped at 72 explaining **why, not what**.
- **PR descriptions** — reviewers need *what changed, why, and how it was verified* before the diff makes sense ([GitHub's guide](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/getting-started/helping-others-review-your-changes), [Graphite](https://graphite.com/guides/github-pr-description-best-practices)); lead with the problem, link context, keep the structure short ([gitrolysis](https://gitrolysis.com/posts/2026/01/how-to-write-better-pull-request-descriptions-templates-and-examples/), [Sopa](https://www.heysopa.com/post/pull-request-best-practices)).
- **Inline images on GitHub** — external images are proxied and cached through Camo; GitHub warns that anyone with the anonymized URL can view the media and recommends authenticated hosting for sensitive files ([Camo docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls)). Origin-side expiry does **not** guarantee removal from GitHub's cache. Repository-relative images can render to authorized readers of private repositories ([formatting docs](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)) — but committing session imagery into a customer's history is ruled out on its own merits.
- Implication: our PR is read by someone who did NOT ask for it. The description must carry the entire story — and every claim in it must be backed by recorded evidence, because unverifiable polish is worse than blunt machine output.

## Voice rules (technical, not jargon)

- Name real things: components, functions, the user action ("clicked Edit Profile"), the exact error. `null`, `destructure`, `TypeError` are the reader's vocabulary.
- Ban internal jargon in prose: "error group", "fingerprint", "investigation job", "precision gate", bare "E1". The Verification line may carry the tier, immediately glossed **baseline-aware**: "E1 — no new test failures compared with the pre-fix baseline."
- One idea per sentence. Lead with user impact.
- **Never claim beyond the evidence record.** Claims are generated per check outcome: "No new test failures compared with the pre-fix baseline" (suite check passed); "Build passed" only when the build check passed; nothing about counts — the evidence contract has no executed-test count today, and E1 can coexist with pre-existing baseline failures and a skipped build. If counts are ever wanted, extend `EvidenceRecord` with structured counts first; never parse them out of output tails.

## Design

### 0. The narrative contract comes first (`narrative.ts`, new)

Today's `AgentFixResult` carries only `rootCause?: string` and `humanSummary?: string` — unstructured prose, which is the root cause of the markdown-mangling class and cannot reliably populate a subject line. Define the typed contract at the model boundary:

```ts
export interface FixNarrative {
  /** Imperative, ≤50 chars target (72 hard), names the code unit, no trailing period. */
  subject: string;
  /** 1–3 sentences: what the end user experienced. */
  whatHappened: string;
  /** 1–3 sentences: the technical cause, plain terms. */
  whyItBroke: string;
  /** 1–2 sentences: what the change does and why it is safe. */
  fixApproach: string;
}
```

- Produced by the existing human-summary model call, switched to structured JSON output; parsed and validated at the boundary (`parseFixNarrative`): field presence, subject grammar (≤72 hard, no period, no error-string passthrough, imperative-ish heuristic), per-field length caps at sentence boundaries.
- On any validation failure → deterministic fallback narrative built from `errorType`, primary file, and the error message. Never ship a half-valid narrative.
- Carried through `AgentFixResult` → `PipelineResult` → `PRInput`. **Commit message, PR title, and PR body all render from this one object** — the mirrored subject is guaranteed by construction, not by prompt luck.
- `narrative.ts` owns the type, the parser/validator, and both renderers (`renderCommitMessage`, `renderPRSections`); `pr.ts` consumes them. Commit generation does not live in `pr.ts`.

### 1. The commit message (`renderCommitMessage(narrative, evidence, incidentUrl)`)

```
Fix null destructure in UserCard editProfile

Clicking "Edit Profile" on a user without a profile crashed with
"TypeError: Cannot destructure property 'name' of
'props.user.profile' as it is null." The profile field is typed
UserProfile | null, but editProfile() bypassed the check with a
non-null assertion.

Guard editProfile() so it returns early when no profile exists,
matching what the type already allows.

Verified: no new test failures compared with the pre-fix baseline;
build passed.

Full incident, session replay, and evidence:
<incident url — omitted entirely when not configured>
```

The `Verified:` line is assembled from the latest outcome of each evidence check, one clause per passing check, omitted entirely when nothing ran. 72-char body wrap; subject from `narrative.subject`.

### 2. The PR body (restructure `buildPRBody`, `kind === 'error'` only)

New order — context before code, link where an unfamiliar reader looks first:

1. **Title**: `🛡️ ${narrative.subject}` (mirrors the commit subject).
2. **What happened** — `narrative.whatHappened` (+ media per §3 when available).
3. **→ Full incident in Opslane** — the incident link, directly under the lede (policy in §4); plain "Watch the session replay" wording unless structured timing exists (§3).
4. **Why it broke** — `narrative.whyItBroke`.
5. **The fix** — `narrative.fixApproach` + the diff (diff rendering untouched — never prose-normalized).
6. **Verification** — the evidence section (Phase 1), tier lines glossed baseline-aware.
7. **Technical detail** (collapsed, unchanged).

**Friction is out of scope and explicitly preserved.** `kind === 'friction'` keeps its current contract: "💡 Opslane suggestion" title, no `Fix …` subject, and the disclosure that the friction itself was not re-verified (pr.ts:298). Guard tests pin all three (commit subject, PR title, disclosure) so this plan cannot regress them. A follow-up may add `Improve …`/`Suggest …` narrative variants for friction; not here.

### 3. The failure recording

- **Tier A (ship now): rich link, honest wording.** "▶ Watch the session replay" — with duration/offset ("the crash happens at 0:09") **only if** structured `durationMs` / `failureOffsetMs` fields are added first. Today `visualAnalysis.failureMoment` is prose (replay-evidence.ts:144), not time metadata; prose must not be dressed up as timestamps. Deriving the structured fields (replay event bounds + incident timestamp) is a small, separate task; until it lands, the link renders without timing.
- **Tier B (separate design, not this plan): inline media as intentional publication.** GitHub caches external images via Camo and origin expiry does not purge that cache — so an inline replay GIF must be treated as an *export/publication decision*, not temporary sharing. The follow-up design must cover: explicit per-project consent (`replay_media_in_prs`, default off), redaction guarantees beyond default masking, retention policy, revocation expectations (including that Camo purge is not under our control), and separate policy for public vs private repositories. Until that design exists, no inline media ships. Committing media into the customer's repo remains ruled out (permanent history pollution with user-session imagery).

### 4. Link policy — two different questions

- **Incident link (for the human reader):** rendered iff `DASHBOARD_URL` is explicitly configured and parses as HTTP(S). A private/VPN-only URL is fine — the reader may be inside that network even though GitHub isn't. Reject only obvious loopback. **The `DASHBOARD_ORIGIN` fallback is removed** — it's a CORS setting, not a reader-facing URL, and the silent fallback is how misconfigured links happen. Compose wiring: pass `DASHBOARD_URL` to the **worker** service (it currently receives neither variable) and document both in `docs/reference/environment-variables.md` (drift-checked).
- **Inline media (for GitHub's proxy):** entirely separate origin and policy — public HTTPS, signed, consent-gated — defined in the Tier B design. Never derived from the dashboard URL.

### 5. Slot-specific validators (not one normalizer)

Shared sanitization primitives (`scrubSecrets`, `scrubDevPaths`), distinct per-slot functions with their own grammar:

- `normalizeSubject` — single line, length rules, no markdown, no trailing period.
- `normalizeProse(text, max)` — strips headers/fences, truncates at sentence boundaries; when no sentence boundary exists within the limit (or the first sentence exceeds it), truncate at a **word boundary and append an ellipsis** — never mid-token.
- `escapeInlineCode`, `buildIncidentUrl` — their own rules.
- The diff is **never** normalized — it renders verbatim inside its fence (existing dynamic-fence logic stays).

Property tests feed each validator markdown headers, half-open fences, punctuation-free 10k-char strings, and secret-bearing text; fixtures include the exact mangled inputs observed in PR #2.

## Execution order (from review)

1. **Hotfix the malformed-markdown regression** with exact unit fixtures (defects #2/#3 — `normalizeProse` into `buildFixLine`). Ships alone.
2. Define `FixNarrative` + slot-specific validators in `narrative.ts` (pure, fully unit-tested).
3. Switch the human-summary model call to structured JSON with the deterministic fallback.
4. Render commit message, PR title, and PR body from the narrative object; error/friction variants pinned by tests.
5. Wire explicit `DASHBOARD_URL` config: worker Compose env, drop the `DASHBOARD_ORIGIN` fallback, env-var docs (drift check).
6. Verification: deterministic rendering assertions live in **worker unit tests** (they need no LLM); the eval harness is extended only if/when it renders `AgentFixResult` through commit/PR creation — today its path stops earlier, so don't pretend coverage. **Live smoke inspects the commit itself**: after a `pr_created` run, `git log -1 --pretty=%B` on the pushed branch must show subject + wrapped body + Verified line + link, and the GitHub PR title/body are asserted against the same narrative.
7. Inline GIF media: separate privacy/security design doc (Tier B above), after the draft-PR decision lands.

## Acceptance bar

A developer who has never heard of Opslane reads the **commit message alone** (`git log -1 --pretty=%B`) and understands the bug, the fix, and what was verified; the PR tells the same story with the diff and evidence; every stated claim traces to a recorded check outcome.
