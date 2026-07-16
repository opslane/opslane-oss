# Life of an error

What happens between an exception in a user's browser and a pull request (or an honest reason there isn't one).

## 1. Capture (browser)

The SDK catches the error via global handlers (or a framework hook), attaches breadcrumbs (console, fetch/XHR, navigation), scrubs tokens and credentials from text and URLs, and POSTs to `/api/v1/events`. Session recording is enabled by default; when browser support, storage, and the project's server-side switch allow it, the SDK uploads a continuous stream of masked-input chunks and the error points into that session.

## 2. Ingest and group (ingestion API)

The event is authenticated by API key, origin-checked, rate-limited, and masked again server-side (sensitive headers, API-key prefixes, URL credentials). It is fingerprinted on error type + message + stack; matching events join an existing **error group**, new fingerprints create one. New groups enqueue an `investigate` job — a Postgres row, not a message queue.

## 3. Claim (worker)

The worker polls Postgres and claims jobs with `FOR UPDATE SKIP LOCKED` under a lease. If a worker dies mid-job, the lease expires and a reaper makes the job claimable again (`lease_lost` is reported if a worker discovers it lost its lease).

## 4. Triage

A fast model call classifies the error: fixable in application code, or not? High-confidence *unfixable* verdicts short-circuit immediately into `needs_human` with a specific reason — `unfixable_third_party`, `unfixable_infra`, `unfixable_test_error`, `unfixable_no_app_frames`, or `unfixable_no_sourcemap` — each with remediation text ([full catalog](../reference/reason-codes.md)).

## 5. Investigate and fix

For fixable errors, the worker clones the repository (GitHub token or App installation token), resolves the stack through uploaded source maps, and runs an agentic fix loop inside an **E2B sandbox**: read the referenced source, form a root cause, edit, install dependencies, and run the test suite. Test success is judged by exit code. Failed attempts escalate through model tiers before giving up.

## 6. Route by confidence — two stages

Investigation and fixing are separate stages:

- **Investigation stage.** High-confidence-fixable errors proceed straight to the fix stage. Medium/low-confidence investigations stop here: the **root-cause analysis** is persisted as **`investigated`** (no fix has been generated yet), waiting for a human to read it and trigger the fix from the dashboard.
- **Fix stage** (automatic for high confidence, human-triggered from `investigated`). The agent writes and tests a fix in the sandbox. Only a **high-confidence fix with passing tests** clears the hard precision gate and becomes a **pull request** (`pr_created`). A fix below the bar terminates as **`needs_human`** (`low_confidence_fix`) — the reason and confidence are preserved, but the candidate diff itself is **not stored**.
- **Anything the worker cannot progress** at either stage → **`needs_human`** with `reason_code`, `reason_message`, and `remediation` — always all three.

One known gap in this contract, stated honestly: if an **investigate** job repeatedly crashes or loses its lease until it dead-letters, its group can currently remain in `analyzing` without a terminal reason — dead-letter reconciliation covers fix jobs only. Tracked as [#25](https://github.com/opslane/opslane-oss/issues/25).

## 7. Human follow-up

From the dashboard: review an `investigated` analysis and trigger the fix, resolve or archive incidents, or act on a `needs_human` remediation (connect the GitHub App, upload source maps, add context) and retry.
