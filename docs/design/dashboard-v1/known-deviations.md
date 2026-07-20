# Known deviations

These deviations predate the design-system cutover and are intentionally frozen
by the frontend-only scope.

1. `packages/dashboard/src/App.vue` performs sign-out with a direct
   `POST /api/v1/auth/logout` fetch. Moving it into `src/api.ts` would alter the
   frozen request surface, so V1 preserves it.
2. `packages/dashboard/src/api.ts` declares ten exported API-facing interfaces
   locally (`Project`, `FixStats`, `Environment`, `EnvironmentListResponse`,
   `APIKey`, `APIKeyCreated`, `ProjectProvisioningResponse`,
   `OnboardingSetupResponse`, `EventStatus`, and `ReplayRecording`). The plan's
   earlier count of eleven is stale at the pinned commit. Relocating these types
   is outside this presentation-only change.
3. The plan's expected bridge-consumer count of 236 is not reproducible at the
   pinned commit. The documented detector reports 362 token occurrences (307
   legacy palette utility prefixes plus 55 `btn-*`/`tab-*` class uses). The
   countdown uses that explicit detector so later numbers remain comparable.
4. No approved target comps exist under `reference/`, and no truthful "before"
   screenshot set was supplied at implementation start. Visual approval and a
   rubric score remain blocked until those artifacts are captured and reviewed.
5. Safari and Firefox support is declared but not browser-tested in this scope;
   see `browser-support.md`.
6. No captured screenshots are committed. They are derived artifacts —
   deterministic, regenerable in seconds, and 2.2 MB of binaries that no
   reviewer can meaningfully diff. Committing them already failed once on this
   branch: a stale set stood as "evidence" for a UI that was never released
   (invisible toggle tracks, from legacy Tailwind classes that emitted no CSS),
   and nothing caught it because a changed PNG reads as a byte-count delta. The
   capture harness is retained and gitignored; see `visual-evidence.md`.
7. Dark mode is not shipped. A full `[data-theme='dark']` token set existed but
   nothing set `data-theme` and there was no `prefers-color-scheme` fallback, so
   it was unreachable. The tokens were removed; V1 is light-only.
8. The incident pipeline stepper was removed. `PipelineIndicator.vue` showed a
   five-stage progress trail (New, Queued, Analyzing, Investigated, Fixing) with
   completed and current states. `IncidentLifecycle.vue` replaces it with the
   current status and a one-line summary, so stage-by-stage progress is no
   longer visible. This is a deliberate ledger-aesthetic decision, recorded here
   so it is not mistaken for an accidental drop.
