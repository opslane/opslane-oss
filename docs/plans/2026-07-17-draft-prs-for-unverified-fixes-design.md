# Draft PRs for Unverified Fixes

**Date:** 2026-07-17 (v2 — revised after design review)
**Status:** Draft — decision proposal (changes a documented core contract; do not implement without explicit sign-off)
**Author:** Abhishek + Claude
**Depends on:** `2026-07-17-evidence-tiered-verification-design.md` (Phase 0/1 landed: evidence records, candidate-diff persistence, honest reason messages)

**v2 changes:** the review found the v1 proposal conflicted with the executable
reliability contract (`docs/contracts/reliability.md`, `packages/test-reliability`).
v2 resolves that with one central decision — a new `pr_draft` incident status —
plus a durable delivery model, a precise green-CI definition, and staged defaults.

## Problem

When the worker produces a judge-approved fix it cannot verify — today, any repo without a root test runner — the outcome is a `needs_human` incident with a candidate diff rendered in the dashboard. That is a dead end for the user:

- The diff can be read but not acted on: no branch, no review thread, no merge button, no CI.
- Applying it means copy/paste or hand-reapplying the change — worse DX than any competitor's "here's a PR" flow.
- Live onboarding on 2026-07-17 hit this wall three times: correct root cause, clean null-guard diff, judge score 2/2/2, and the journey ended at a read-only dashboard card.

The reason the PR is withheld is the product's core trust contract: *"The worker never opens an unverified PR."* That contract is right — but the current interpretation conflates two different things: **presenting a fix as ready** and **making a fix actionable**.

## Key insight

**Opening a PR runs the customer's own CI.** Our runner detection is deliberately narrow (Phase 1: root-package Vitest only) and will never cover every test setup. But the customer's CI already knows how to build and test their code. A draft PR converts "we could not verify this" into "your own infrastructure is verifying it right now" — the verification we couldn't start gets finished by the systems the customer already trusts.

## Core decision: a `pr_draft` incident status

v1 kept the incident in `needs_human` and hung a PR URL on it. That is not
implementable: the invariant scanner flags `needs_human` with delivery fields
(`invariant-scanner.ts` `TERMINAL_FIELDS_INCOMPATIBLE_QUERY`), the PR webhook
lookup filters `status = 'pr_created'` only, the inactivity sweep auto-resolves
`needs_human`, and a CI-watcher job on a terminal incident would trip the
terminal-groups-with-live-jobs invariant.

Instead, add one status to `ErrorGroupStatus`:

- **`pr_draft`** — a judge-approved but unverified fix has been published as a
  GitHub draft PR. Owns `pr_url` / `pr_number` like `pr_created`.
- **Nonterminal**, modeled on `investigated`: it may wait without a live job
  (webhook-driven) or carry a live `ci_watch` job (below). Both are legal.
- **Excluded from the inactivity auto-resolve sweep**, same as `pr_created`,
  because the PR webhook owns its closure.
- The PR webhook status filter widens to `status IN ('pr_created', 'pr_draft')`.
  Merge → `merged`; close-unmerged → back to `needs_human` (original reason
  restored) with branch cleanup.
- Green CI (below) promotes `pr_draft` → `pr_created`, converging on the
  existing terminal machinery.

This one decision resolves the scanner conflict, the webhook mismatch, the
sweep conflict, and gives CI follow-through a legal home.

### Reliability contract changes (shipped together, phase 1)

- `docs/contracts/reliability.md`: add `pr_draft` to the incident invariants —
  nonterminal, may own delivery fields, requires nonblank HTTPS `pr_url` and
  positive `pr_number`, may wait without a live job.
- `invariant-scanner.ts`: update `TERMINAL_FIELDS_INCOMPATIBLE_QUERY`,
  `TERMINAL_GROUPS_WITH_LIVE_JOBS_QUERY`, and the active-groups query for the
  new status.
- Delivery-policy note: promotion via CI means `pr_created` can now carry
  **medium** confidence with an `external_ci` evidence check. The canonical
  delivery policy ("current worker only delivers a high-confidence fix")
  is extended accordingly.

## Behavior

For a fix that is **judge-approved but below the ready-for-review evidence bar** (today: no test runner; post-Phase-2: no successful repro):

1. Push the fix branch and open a **GitHub draft PR**; incident → `pr_draft`.
2. The PR body's Verification section states the evidence honestly, e.g.:
   > **Verification: E0 — build only.** No test runner was detected in this repository, so Opslane could NOT verify this fix. The CI results on this PR are the verification — review them before marking ready.
3. The dashboard card links to the draft instead of dead-ending at the diff.
4. Merging or closing the draft flows through the `pull_request` webhook once
   its status filter includes `pr_draft` (a required code change, not current
   behavior).

### Eligibility decision table

| Evidence state | Judge | Outcome |
| --- | --- | --- |
| E2 full (red→green→reversal) | pass | Ready PR, `pr_created` high (unchanged) |
| E2 without `asserts_behavior` | pass | Draft PR (error elimination shown; behavior not asserted) |
| E1 only (`repro_not_achievable`, suite green vs baseline) | pass | Draft PR — positive but incomplete evidence |
| E0 only (`skipped_no_runner`) | pass | Draft PR |
| Any tier | reject (`low`) | `needs_human`, no draft — a human sees the writeup first |
| Build failed or new suite regressions (negative evidence) | any | `needs_human`, no draft |
| `verification_infra_error` | any | Retry, never published |
| Stackless / `unfixable_*` | — | No diff exists; unchanged |

The rule in one line: **a draft PR requires positive quality evidence (judge
pass + build pass) and no negative execution evidence; it exists exactly when
the fix falls short of the ready bar without evidence against it.** (v1's
"merely absent evidence" wording was wrong: `repro_not_achievable` can carry
positive E1 evidence and is still draft-eligible.)

Pre-Phase-2 the ready bar is today's suite verification; post-Phase-2 it is E2,
and drafts become the fallback for `repro_not_achievable` — consistent with the
verification design's decision matrix.

### Contract rewording

- Old: "The worker never opens an unverified PR."
- New: "The worker never opens a **ready-for-review** PR without executed verification evidence. Unverified but judge-approved fixes may be published as clearly-labeled **draft** PRs, subject to project settings."

Files that state the old contract and must change together: `README.md` (three
terminal outcomes), `docs/architecture/precision.md`,
`docs/quickstart/self-host.md` ("The worker never opens an unverified PR"),
`docs/contracts/reliability.md` + the invariant scanner, and the precision-gate
comments in `pipeline.ts` / `agent-fix.ts`. Before implementation, run a
repo-wide grep for "unverified PR" / "never opens" to catch drift — v1's
inventory cited a `packages/worker/AGENTS.md` note that does not exist.

## Durable delivery (prerequisite, and existing debt)

The current PR path names branches with `Date.now()` and performs GitHub writes
before any durable record — a crash or lease retry can create a second branch
and PR. `docs/contracts/reliability.md` already requires a stable operation key
and reconcile-before-create; this design makes that debt blocking:

- **Stable branch key:** `opslane/fix-<errorGroupId8>` — no timestamp. One
  logical delivery per error group.
- **Write-ahead reservation:** persist the delivery intent (group id, branch,
  operation key, posture) *before* pushing. On retry, reconcile: check the
  reservation, then GitHub, for an existing branch/open PR before any create.
- **One open draft per group** falls out of the reservation + the `pr_draft`
  status check: a recurrence on a group already in `pr_draft` never redelivers.
- **Per-project cap (new — no such limit exists today):** max open Opslane
  draft PRs per project, default 10. At the cap, the fix lands as `needs_human`
  with reason `draft_cap_reached` and the diff attached, as today.

## CI-as-evidence (Phase 4)

### Execution model: a durable `ci_watch` job

Add `ci_watch` to `JobType`, scheduled on the existing Postgres job queue (no
new infrastructure; honors the no-new-queue guardrail):

- Enqueued when the draft PR is created; carries group id, PR number, and the
  head SHA the worker pushed.
- Polls the Checks API + commit statuses with backoff under the existing lease
  / `lease_generation` fencing; retries are the queue's normal retry budget.
- **Timeout:** no completed check within 24h → record `no_ci_observed`, stop
  watching, incident stays `pr_draft`. Zero checks is never green.
- Legal under the contract because `pr_draft` is nonterminal.

Polling is chosen over `check_run` webhooks for v1: both require the Checks
read permission anyway, polling works identically in PAT mode, and it avoids a
webhook inbox. Webhook delivery is a later optimization.

### Green definition

Evaluated **only at the head SHA the worker pushed**:

- Green = at least one check run completed with conclusion `success` (or one
  successful commit status), **and** no check run concluded `failure`,
  `timed_out`, `cancelled`, `action_required`, or `stale`, **and** no commit
  status in `failure`/`error`.
- `pending`/`queued`/`in_progress` → keep waiting until timeout. `skipped` and
  `neutral` conclusions neither pass nor block.
- A new commit on the branch (human pushed) → stop watching, leave draft,
  record `head_moved` in evidence. The fix is no longer solely ours.

### On green

1. Record an `external_ci` evidence check — `passed`, keyed to `pr_number` +
   `head_sha`, listing the check-run names — on the evidence record. The
   record gets a `version: 2` bump and a new `external_ci` field; the E0/E1/E2
   tier ladder itself is unchanged (external CI is an orthogonal evidence
   source, not a local tier).
2. Flip the draft to **ready for review** and update the PR body's
   Verification section.
3. Transition `pr_draft` → `pr_created` (confidence `medium`, allowed by the
   extended delivery policy). Lifecycle converges on existing machinery.

On red: leave draft, append the failure to the evidence record, name the
failing check in the incident's remediation.

### Permissions

- GitHub App: add **Checks: read** to `docs/guides/github-app.md`. Existing
  installations must approve the permission upgrade — the setup doc and the
  dashboard GitHub settings page must say so; until approved, `ci_watch` records
  `no_ci_observed` (permission-denied variant) rather than failing silently.
- PAT mode: `repo` scope already covers checks; no change.

## Controls

- Per-project setting `pr_posture`: `verified_only` (today's behavior) |
  `draft_when_unverified`. Stored on `projects`; dashboard toggle.
- **Staged defaults** (v1's split default was not implementable in one step —
  `CreateProject` relies on DB column defaults):
  - Phase 3 ships with column default `verified_only` for **all** projects.
    Opt-in only; zero surprise on upgrade.
  - After CI-as-evidence proves out, a separate follow-up sets
    `draft_when_unverified` **explicitly at creation time** for new projects
    (onboarding/CLI passes the value; the column default stays
    `verified_only`). That flip is its own reviewed change.
- One open draft per error group (via delivery reservation, above).
- Per-project open-draft cap, default 10 (above).

## Sequencing

1. **ADR + contract changes** (this doc, approved): `pr_draft` status, contract
   rewording across the full inventory, reliability contract + invariant
   scanner updates, delivery-policy extension. Nothing ships before this lands,
   because the wording is load-bearing and tests assert the gate.
2. **Durable delivery**: stable branch key, write-ahead reservation,
   reconcile-before-create. Fixes existing verified-path debt; prerequisite for
   one-draft-per-group.
3. **Draft-PR publishing** behind `pr_posture` (opt-in, default
   `verified_only`): worker branch push + `draft: true` on the existing PR
   path; ingestion stores the setting; dashboard toggle + draft badge; webhook
   filter widened; caps enforced.
4. **CI-as-evidence**: `ci_watch` job, green definition, evidence `version: 2`,
   draft→ready flip, `pr_draft` → `pr_created` promotion, Checks permission
   docs.
5. **Default flip for new projects** — separate decision after observing 3+4.

Phase 2 of the verification design (the repro gate) is unaffected: once E2 exists, repos where the repro succeeds get real PRs regardless of their own test suites, and drafts become the fallback for `repro_not_achievable` (with E1 evidence attached — see the decision table).

## Risks

- **Trust dilution.** A user who merges a draft without reading the label ships an unverified change. Mitigations: GitHub's draft state blocks merge until explicitly marked ready; the Verification section leads with "NOT verified"; `verified_only` remains the default everywhere until the staged flip.
- **PR noise in monorepos / high-error projects.** Mitigated by one-draft-per-group, the per-project open-draft cap, and the posture setting; if that proves insufficient, add a per-day draft cap before widening defaults.
- **Branch litter.** Closed-unmerged drafts delete their branches (explicit cleanup on the `closed` webhook transition).
- **Promotion trust.** Green CI on a repo with a trivial workflow (lint-only) promotes a weakly-verified fix to `pr_created`. Accepted for v1: the evidence record names the exact checks that passed, and the PR body preserves the history. A minimum-check-quality heuristic is out of scope.

## Decision requested

Approve: (a) the `pr_draft` status and its reliability-contract changes, (b) the contract rewording, (c) the five-step sequencing with `verified_only` as the universal default until the staged flip. Alternative: keep `verified_only` as the sole behavior and revisit after verification Phase 2 ships.
