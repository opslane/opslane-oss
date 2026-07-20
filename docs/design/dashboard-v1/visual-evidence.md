# Visual evidence status

**No visual approval has been granted for dashboard V1.** Automated build,
test, and browser success are not visual approval and must not be reported as
such. This file exists to keep that distinction explicit.

## What exists

Deterministic Chromium captures of every route at 1440×1000, 1180×1000, and
390×844, driven entirely by mock-labelled fixtures. The set covers the two
branches a success-only fixture can never reach: `activity-empty-mock` (zero
incidents, with the setup action) and `activity-error-mock` (failed incident
load, rendered as a danger alert). Those are exactly the states where the
dropped-slot and wrong-prop regressions hid.

Captures are **not committed**. They are derived artifacts, and a committed set
already went stale once on this branch — standing as evidence for a UI that was
never released. See deviation 6 in `known-deviations.md`. Regenerate locally:

```bash
CAPTURE_DASHBOARD_SCREENSHOTS=1 pnpm --filter @opslane/test-e2e exec vitest run dashboard-screenshots.test.ts
```

That writes the PNGs, `manifest.json` (route, fixture, dimensions, byte size,
SHA-256 per file), and a browsable `index.html`. The safeguard test validates
the manifest whenever one is present, and otherwise requires the absence to
stay recorded in `known-deviations.md` — so "no evidence" cannot pass as
"evidence".

## What does not exist

1. Approved annotated reference comps under `reference/`.
2. A truthful "before" capture set — none was taken prior to implementation.
3. An annotated comparison for the Tailwind migration inventory.
4. A rubric result with a named reviewer and zero zero-tolerance failures.

The `visual-verdict` workflow requires at least one reference image plus a
generated screenshot; its reference input is absent, so no score or pass
verdict has been issued. `reference/`, `screenshots/before/`, and
`screenshots/after/` are evidence locations, not approvals in themselves.

Until all four exist, this change carries engineering verification only.
