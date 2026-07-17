# Enforce SDK↔event-API backward compatibility

Design for [issue #75](https://github.com/opslane/opslane-oss/issues/75). Status: approved 2026-07-16 (revised after design review).

## Problem

The SDK ships to npm and runs in customers' apps. The ingestion API deploys on
our own schedule. We cannot force-upgrade an SDK sitting in someone else's app,
so **old SDK versions POST to our newest server indefinitely**. The
`POST /api/v1/events` event contract must therefore stay backward-compatible
forever.

CI is currently blind to this class of break. Every existing test
(`e2e-keyless`, `reliability-system`) builds the SDK and the server from the
*same commit* — it only proves HEAD-SDK works with HEAD-server. A contract break
manifests as old-SDK-vs-new-server, which HEAD-vs-HEAD cannot exercise. A break
is a silent customer outage we cannot hotfix, so this warrants a hard CI gate.

### Verified current state (2026-07-16)

- The ingestion events decoder (`packages/ingestion/handler/error_event.go`)
  uses plain `json.Unmarshal` with **no `DisallowUnknownFields`**. Forward-compat
  (new SDK → old server) is already safe — the old server ignores unknown
  fields. We only need a guard that keeps it that way.
- **Backward-compat (old SDK → new server) is unguarded.** A future change that
  tightens validation, makes a field required, or stops reading a field the old
  SDK sends would break live clients with no signal.
- The wire shape has two definitions that can drift: TS `ErrorEventPayload` in
  `shared/src/types.ts:37-58` and the anonymous Go request struct in
  `error_event.go:56-68`.

## Decisions

Resolved during brainstorming and design review:

1. **Immutability detection: git-diff script** (not the GitHub API). A local
   `scripts/check-wire-fixtures.mjs` runs `git diff --name-status` and fails on
   any modify/delete under `test-fixtures/wire/`. Self-contained, runnable on a
   laptop before pushing, no network or `gh` dependency.
2. **Override scope: PR-only, `contract-change` label bypasses.** The check runs
   only on `pull_request`, diffs against the PR base. A `contract-change` label
   skips it for the rare legitimate edit. Push-to-main is not checked at the
   workflow level — see *Prerequisites* for how the push path is closed instead.
3. **The gate lives in its own workflow.** `.github/workflows/wire-fixtures.yml`
   triggers on `pull_request` with explicit
   `types: [opened, synchronize, reopened, labeled, unlabeled]` and runs *only*
   the fixture check. Adding or removing the label re-runs this check in seconds
   instead of re-running the whole `ci.yml` pipeline. It becomes its own required
   status check (it is **not** part of `ci-ok`).
4. **SDK assertion: normalized deep equality.** Capture the SDK's true wire
   output, sentinel-replace volatile fields (`timestamp`, `stack`, `sdk_version`,
   `session_id`), then compare the *complete* serialized JSON to the fixture.
   Key-and-type matching was rejected — two same-typed fields could be swapped
   undetected.

### Verified review findings

- `buildPayload()` (`packages/sdk/src/core.ts:62-94`) **always** calls
  `addBreadcrumb(breadcrumb)` (line 70), so `breadcrumbs: []` is only reachable
  with an explicit `maxBreadcrumbs: 0` config. It also returns
  `release`/`session_id` as keys holding `undefined` (lines 91-92); those keys
  disappear only at `JSON.stringify` in `transport.ts`. Fixtures must therefore
  be captured from the **wire form**, not from the raw object.
- `ci.yml` (`:3-6`) uses `pull_request:` with no `types:`, so the default
  activity types (`opened, synchronize, reopened`) exclude `labeled`/`unlabeled`.
  Applying the label after a failure would not re-fire CI, and a manual re-run
  replays the original label-less event. This is why the gate needs its own
  workflow with explicit label activity types (decision 3).

## Prerequisites (ops, not code)

These make the "hard gate" real. Without them the gate is advisory.

1. **Create the `contract-change` label** in the repo
   (`gh label create contract-change`). It does not exist today.
2. **Enforced PR-only branch protection on `main`, including administrators.**
   The gate only runs on pull requests. An admin direct push to `main` bypasses
   it. Branch protection must require the `wire-fixtures` status check and apply
   to admins, or the gate has a hole. Documented here as an explicit prerequisite.
   Residual risk if this is not configured: a direct push can still edit a frozen
   fixture. Push-side verification is intentionally not built — on a direct push
   there is no base PR and no label to express the legitimate-edit escape hatch,
   so the branch-protection route is the correct fix.

## Wire shape (reference)

`ErrorEventPayload` — `shared/src/types.ts:37-58`. Built by `buildPayload()` at
`packages/sdk/src/core.ts:62-94`; sent by `flushEvents()` at
`packages/sdk/src/transport.ts:119-126` as one JSON object per request.

| Field | Required | Notes |
| --- | --- | --- |
| `timestamp` | yes | ISO 8601 |
| `error.{type,message,stack}` | yes | strings; only `message` validated server-side |
| `breadcrumbs` | yes | array, may be empty |
| `context` | yes | object; all sub-fields optional |
| `context.user.{id,email,account_id,account_name}` | no | `user` added only when set |
| `sdk_version` | yes | |
| `release` | no | key **dropped** from wire when unset |
| `session_id` | no | key **dropped** from wire when unset |

Current SDK version is `1.0.0` (`packages/sdk/package.json`), so fixtures are
named `v1.0.0-*`.

## What to build

### 1. Frozen wire fixtures

```
test-fixtures/wire/events/v1.0.0-minimal.json
test-fixtures/wire/events/v1.0.0-full.json
test-fixtures/wire/events/README.md
```

Captured from the **actual wire body** the SDK sends (intercept the `fetch` body
in a test harness, or `JSON.parse(JSON.stringify(buildPayload(...)))`), so the
`undefined`-key drop and breadcrumb behavior are represented truthfully.

- **Minimal** — SDK configured with `maxBreadcrumbs: 0`, no user, no `release`,
  no `session_id`. Wire body: `timestamp`, `error{type,message,stack}`,
  `breadcrumbs:[]`, `context{url,user_agent}`, `sdk_version`. No `release`/
  `session_id` keys.
- **Full** — user set (`id`,`email`,`account_id`,`account_name`), `release` set,
  `session_id` present, at least one real breadcrumb. Wire body includes
  `context.user`, `release`, `session_id`, and a populated `breadcrumbs`.
- `README.md` documents the exact SDK setup used to produce each file, and the
  rule: **append-only — add new files for new SDK versions, never edit or delete
  an existing file.**

Adding a new SDK field is done by adding a *new* fixture and keeping the field
optional server-side; old fixtures still pass.

### 2. Ingestion backward-compat test (`go` job)

New `packages/ingestion/handler/wire_compat_test.go`, package `handler_test`,
modeled on `handler/error_event_test.go`.

- Reuse helpers `testDeps(t)` (`error_event_test.go:25`) and `seedTenant(t,q)`
  (`:46`). Drive requests in-process via `httptest.NewRecorder` +
  `handler.NewRouter(deps).ServeHTTP`.
- Loop **every** `test-fixtures/wire/events/*.json` (relative path
  `../../../test-fixtures/wire/events`): POST each → assert **202** → capture the
  returned `event_id` → `SELECT` that row and assert the **full** contract:
  `timestamp`, `error.type`, `error.message`, `error.stack`, `breadcrumbs` and
  `context` as semantic JSON, `release`, `session_id`, and the event→group
  linkage. For the full fixture, assert user extraction (the documented
  `context.user` side effect).
- **Correct-grouping proof:** POST the same fixture twice and assert the second
  response's `group_id` equals the first — substantiates grouping, not just
  storage.
- **Unknown-field-tolerance case:** load a fixture, inject a top-level
  `future_field` and a nested unknown, POST → still **202**. Locks in
  forward-compat so nobody adds `DisallowUnknownFields` to this endpoint.
- Runs under the existing `go test ./...` step (`ci.yml:84-88`). Skips cleanly
  without `DATABASE_URL`, exactly like its siblings, so `check-go-skips.mjs`
  stays green.

### 3. Fixture immutability check (dedicated workflow)

New `scripts/check-wire-fixtures.mjs`, mirroring `scripts/check-action-pins.mjs`
style (`node:` builtins only, collect `problems[]`, `process.exit(1)` on
failure, success `console.log`).

- Run `git diff --name-status $BASE_SHA...HEAD`, keep lines under
  `test-fixtures/wire/`, **fail on `M` (modified), `D` (deleted), or `R`
  (renamed)**. Added (`A`) is allowed.
- Fail message names the offending files and points at the `contract-change`
  label + `docs/contracts/events.md`.

New `.github/workflows/wire-fixtures.yml`:

```yaml
name: Wire fixtures
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
permissions:
  contents: read
jobs:
  wire-fixtures:
    name: Wire-fixture immutability (append-only)
    runs-on: ubuntu-latest
    if: ${{ !contains(github.event.pull_request.labels.*.name, 'contract-change') }}
    steps:
      - uses: actions/checkout@<sha>   # SHA-pinned per check-action-pins
        with:
          persist-credentials: false
          fetch-depth: 0               # so $BASE_SHA is in history
      - name: Wire-fixture immutability
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: node scripts/check-wire-fixtures.mjs
```

Made a **required status check** on `main` via branch protection (see
Prerequisites). Because the label is one of the trigger activity types, adding
`contract-change` re-runs this workflow, the `if:` guard is skipped, and the
required check turns green — a conscious human act, in seconds, without touching
the rest of the pipeline.

### 4. SDK vitest (`js` job)

New `packages/sdk/src/__tests__/wire-shape.test.ts`, modeled on the existing
`packages/sdk/src/__tests__/contract.test.ts` harness (captures the real `fetch`
body).

- The SDK at HEAD emits only the **current** shape, so it compares against the
  **current release's fixture pair only**, selected by package-version
  convention: read `version` from `packages/sdk/package.json`, load
  `v{version}-minimal.json` and `v{version}-full.json`. Historical fixtures are
  the ingestion side's job, not the SDK's.
- Construct two scenarios that reproduce the documented minimal and full setups,
  capture each wire body, then assert **normalized deep equality**: sentinel-
  replace `timestamp`, `error.stack`, `sdk_version`, `session_id` in both emitted
  and fixture JSON, then `expect(emitted).toEqual(fixture)` on the full object.
- Runs under `pnpm --filter @opslane/sdk test`.

The contract is now pinned from both ends: the SDK cannot stop emitting the
shape, the server cannot stop accepting any historical shape, neither drifts
silently.

### 5. Written rule

- New `docs/contracts/events.md`, matching the `docs/contracts/reliability.md`
  format: the event API is append-only / backward-compatible — add optional
  fields, never remove or require. Changing a frozen fixture requires the
  `contract-change` label and is a conscious human act.
- One line in `AGENTS.md` (Guardrails section) pointing to it, so agents do not
  break the contract.

## Acceptance criteria (from issue #75)

- [ ] Frozen fixtures exist for the current SDK payload (minimal + full),
      captured from the real wire body, documented as append-only with their
      exact SDK setup.
- [ ] Go test in the `go` job replays **every** fixture against ingestion and
      asserts `202` + full field round-trip + correct grouping (double-POST same
      `group_id`).
- [ ] Unknown-field-tolerance test asserts a payload with extra fields is
      accepted (locks in forward-compat).
- [ ] Immutability check fails a PR that edits/deletes an existing wire fixture,
      unless the `contract-change` label is present; adding the label re-runs the
      check and passes.
- [ ] SDK vitest asserts the SDK emits wire JSON matching the current-release
      fixture pair via normalized deep equality.
- [ ] `docs/contracts/events.md` + `AGENTS.md` state the append-only rule.
- [ ] `contract-change` label exists; `main` branch protection requires the
      `wire-fixtures` check and applies to administrators.
- [ ] Adding a new SDK field is done by adding a *new* fixture and keeping the
      field optional server-side; old fixtures still pass.

## Verification

- `cd packages/ingestion && go test ./handler` (with `DATABASE_URL` set) — new
  backward-compat + unknown-field tests pass; double-POST returns identical
  `group_id`.
- `pnpm --filter @opslane/sdk test` — wire-shape test passes against the current
  fixture pair.
- `node scripts/check-wire-fixtures.mjs` against a scratch edit of an existing
  fixture — proves it fails; adding a new fixture passes.
- On a real PR: edit a fixture → `wire-fixtures` check red; add `contract-change`
  → check re-runs and goes green.

## Out of scope

- No `DisallowUnknownFields` is added anywhere (that would break forward-compat).
- No changes to the event decoder or SDK payload shape — this issue only adds
  guards around the existing contract.
- No push-side immutability verification — closed via branch protection instead.
