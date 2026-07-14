# Precision: what "verified" means

Opslane opens pull requests automatically. That is only tolerable if the bar for opening one is explicit. This page states the bar exactly — including what it does **not** guarantee.

## The gate

A PR is opened only when **all** of the following held during the run (`packages/worker/src/pipeline.ts`):

1. The candidate fix was produced and applied inside an isolated sandbox against a real clone of your repository.
2. The project's **test suite ran and passed** in that sandbox, judged by exit code — not by parsing output text.
3. The fix carries **high confidence** from the investigation. This is a hard, independent guard: even a plausible fix with medium confidence does not ship. It becomes `investigated` (analysis posted, fix awaits your go-ahead) or `needs_human` (`low_confidence_fix`), with the candidate diff preserved for your review.

If dependency installation fails in the sandbox, tests cannot run — and a fix without a test run **cannot** reach high confidence and cannot become a PR (`tests_failed` / `low_confidence_fix`).

## What this guarantees

- No PR was opened from an unverified change: everything in a PR passed your test suite in a clean environment.
- Every non-PR outcome tells you why, with a machine-readable `reason_code` and human-actionable `remediation` — never a silent drop.

## What this does NOT guarantee

Honesty requires the other side of the ledger:

- **Passing tests ≠ correct fix.** If your test suite doesn't cover the broken behavior, a wrong fix can pass it. Verification quality is bounded by test quality.
- **The root cause may be deeper.** The fix addresses the error as observed; an underlying design issue can produce the same class of error elsewhere.
- **No performance or security review.** The gate checks behavior via tests, not resource usage, latency, or vulnerability introduction. Review PRs as you would a human contractor's.
- **Reproduction is not always possible.** Errors without app stack frames, without source maps, or originating in third-party code are declared unfixable rather than guessed at — that is the gate working, not failing.

## Why the gate is strict

A wrong automatic PR costs more trust than ten honest `needs_human` incidents. The pipeline is built to prefer an explicit "a human should look at this, and here's why" over a confident-looking guess.
