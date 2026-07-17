# Frozen event wire fixtures

Each file is the exact JSON body an `@opslane/shared` `ErrorEventPayload` reaches
the wire as, for one released SDK payload shape. They lock the
`POST /api/v1/events` contract in both directions:

- **Ingestion** (`packages/ingestion/handler/wire_compat_test.go`) replays *every*
  file here and asserts the server still accepts and stores it.
- **SDK** (`packages/sdk/src/__tests__/wire-shape.test.ts`) asserts the SDK still
  emits the *current* version's pair through its real transport path.

## Rule: append-only

**Never edit or delete an existing file.** Add a *new* `v<version>-*.json` pair
for every SDK release, keeping any new fields optional server-side; old fixtures
must still pass. A modify/delete is a contract break and fails the
`wire-fixtures` CI check unless the PR carries the `contract-change` label (a
deliberate, reviewed break). See `docs/contracts/events.md`.

## How each file was produced

- `v1.0.0-minimal.json` — SDK configured `maxBreadcrumbs: 0`, no user, no session,
  no `release`. `release`/`session_id` keys are absent because the SDK drops
  `undefined` keys at serialize.
- `v1.0.0-full.json` — user set, `release` set, session established, one
  navigation breadcrumb.

Values are benign so SDK and server redaction are no-ops. `sdk_version` is on the
wire and accepted by the server but not persisted.
