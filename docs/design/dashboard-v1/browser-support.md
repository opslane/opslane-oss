# Dashboard V1 browser support

The declared browser floor is Chrome 111+, Safari 16.4+, and Firefox 128+.
This floor follows Tailwind CSS 4's documented compatibility requirements; it
is not evidence that this dashboard was exercised in all three engines.

The automated gate in this repository is Chromium only. The current CI installs
Chromium, and the frontend-only scope excludes CI workflow changes. Safari and
Firefox therefore remain declared but unverified for V1. A cross-browser gate
requires a separately scoped CI change.

## Evidence status

| Engine | Status | Evidence |
|---|---|---|
| Chromium | automated gate | `test-e2e/dashboard-design-system.test.ts` via the deterministic mock harness |
| WebKit / Safari | not run | no WebKit installation or CI job in this scope |
| Firefox | not run | no Firefox installation or CI job in this scope |

This document must not be interpreted as a cross-browser sign-off.
