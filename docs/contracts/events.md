# Event API contract

`POST /api/v1/events` is **append-only and backward-compatible, forever.**

The SDK ships to npm and runs in customers' apps on their upgrade schedule; the
ingestion API deploys on ours. Old SDK versions POST to our newest server
indefinitely and we cannot force-upgrade them. A break is a silent customer
outage we cannot hotfix.

## Rules

- **Add only optional fields.** Never remove a field the SDK may send, never make
  an existing field required, never stop reading a field an old SDK sends.
- **Never tighten decoding.** The events decoder must keep tolerating unknown
  fields (no `DisallowUnknownFields`) so a *newer* SDK's extra fields are ignored,
  not rejected.
- **Fixtures are frozen.** `test-fixtures/wire/events/` holds the exact wire JSON
  for every released SDK version. Add a new `v<version>-*.json` pair for every
  SDK release, even when no other field changes; never edit or delete an existing
  file.

## Enforcement

- `packages/ingestion/handler/wire_compat_test.go` (`go` CI job) replays every
  fixture and asserts `202` plus full field round-trip, stable grouping, and
  unknown-field tolerance.
- `packages/sdk/src/__tests__/wire-shape.test.ts` (`js` CI job) asserts the SDK's
  real transport output still matches the current version's pair.
- `.github/workflows/wire-fixtures.yml` (trusted-base `pull_request_target`)
  publishes the required `wire-fixtures` status on the PR head and fails it when
  a PR modifies or deletes a frozen fixture, unless the PR carries the
  `contract-change` label: the one deliberate, reviewed way to change the
  contract.

## Making a deliberate change

Adding a field: add a new fixture pair, keep the field optional server-side, and
the old fixtures still pass. Editing or removing an existing fixture: apply the
`contract-change` label, a conscious acknowledgement that live clients may break.
