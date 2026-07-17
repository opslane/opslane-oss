# Public documentation baseline audit — 2026-07-17

This is the one-time baseline required by the docs-sync quality design. It is
an internal audit artifact, not a published page: `docs/audits/**` is outside
the docs-site loader allowlist.

## Inventory and policy

The loader publishes 19 Markdown pages. After adding the event API contract to
the sidebar, all 19 are navigable. Navigation equality is a current outcome,
not a lint rule; the scope check still permits a deliberately unnavigated page.

| Published page | Type | Policy | Baseline result |
| --- | --- | --- | --- |
| `install.md` | setup | prose | Five fences classified; two SDK initialization examples compile in the React and Vue fixtures. |
| `quickstart/self-host.md` | setup | prose | Seven fences classified; Compose syntax and linked commands checked. Environment-dependent Docker commands remain illustrative rather than CI-runnable snippets. |
| `guides/github-app.md` | setup | prose | Three fences classified; credential placeholders remain templates and the setup-PR route is drift-gated. |
| `guides/react.md` | setup | prose | Three fences classified; the complete boundary example builds in the React fixture. |
| `guides/replay-privacy.md` | setup | prose | Two fragments classified; replay defaults, masking, scrub gate, and retention claims checked against SDK/ingestion code. |
| `guides/source-maps.md` | setup | prose | Four template/output fences classified; plugin symbol, upload route, response shape, and release behavior checked. |
| `guides/vanilla.md` | setup | prose | Five fences classified; both complete initialization forms build against the SDK. |
| `guides/vue.md` | setup | prose | Four fences classified; the complete plugin example builds in the Vue fixture. |
| `architecture/life-of-an-error.md` | internals | prose | Pipeline stages and terminal-state caveat checked against ingestion and worker code. |
| `architecture/overview.md` | internals | prose | Mermaid renders in the real Astro build and the shown trust boundaries match current services. |
| `architecture/precision.md` | internals | prose | Passing-test and high-confidence PR gates checked against `pipeline.ts` and its regression tests. |
| `architecture/trust.md` | internals | prose | GitHub, Anthropic, E2B, credential, replay, and retention claims checked against current read/write paths. |
| `reference/environment-variables.md` | reference | deterministic | Bidirectional source/doc drift check passes. |
| `reference/http-routes.md` | reference | deterministic | All 59 registered routes pass the method-aware drift check. |
| `reference/reason-codes.md` | reference | deterministic | All 22 shared reason codes pass the bidirectional drift check. |
| `reference/sdk-options.md` | reference | deterministic | All 12 SDK options and parsed defaults pass the bidirectional drift check. |
| `contracts/C4-amendments.md` | contract | manual | Session pointer, chunk read, legacy route, and pinned rrweb claims checked; code changes now emit a manual-review reminder. |
| `contracts/events.md` | contract | manual | Append-only rules checked against frozen fixtures and wire compatibility tests; the page is now in sidebar navigation. |
| `contracts/reliability.md` | contract | manual | Current invariants and explicitly planned guarantees checked against the scanner and worker/ingestion ownership code; code changes now emit a manual-review reminder. |

Present but unpublished content is intentional: `docs/plans/**`,
`docs/audits/**`, `docs/agents/**`, and `docs/evidence/**` are excluded by the
loader. The loader resolves symlinks before its allowlist check.

## Snippet evidence

`scripts/docs-sync/snippets.json` classifies every one of the 33 setup fences:
6 runnable, 6 fragments, 9 configuration templates, 2 expected-output blocks,
and 10 illustrative commands/examples. The six runnable examples are
materialized one at a time in isolated copies of `test-fixtures/react-app` or
`test-fixtures/vue-app` and built from their exact Markdown contents.

Package-install, credential, Docker, and destructive cleanup commands are not
silently treated as executable CI snippets. Their explicit non-runnable class
records the environmental input or side effect that prevents a safe verbatim
fixture run.

## Prioritized gaps

No P0 onboarding blocker or P1 accuracy/trust defect remained after the checks
above.

| Priority | Page and reader | Gap | Disposition |
| --- | --- | --- | --- |
| P2 | `contracts/events.md`; integrators and AI assistants | The published normative wire contract was absent from navigation. | Fixed by adding it to the Contracts sidebar. |
| P2 | `architecture/life-of-an-error.md`; evaluating engineers | The seven-stage flow is prose-only. A compact Mermaid sequence would make the state transitions faster to scan. | Deferred; accurate today, and not a P0/P1 correction. |
| P2 | `architecture/trust.md`; security reviewers | The destination table is accurate, but a dedicated credential/data-egress diagram would shorten review time. | Deferred; the overview diagram already shows the main boundaries. |

Baseline readability passed the plain-language/jargon sweep. Normative terms in
contracts were retained where they name an exact guarantee, and the reliability
contract defines “idempotent” immediately rather than assuming the reader knows
it.

## Verification record

- `pnpm docs:scope`: 19 published, 19 navigable; 12 prose, 4 deterministic,
  3 manual.
- `node scripts/check-docs-drift.mjs`: routes, environment variables, SDK
  options, reason codes, and `llms.txt` paths consistent.
- `pnpm --filter @opslane/docs-site build`: Mermaid rendered and all internal
  links passed.
- Snippet manifest validation: all 33 fences classified; all 6 runnable
  examples built successfully.
- Pinned live prompt evaluation: three runs per issue-83 case, 100% stale-fix
  rate, 0% false-edit rate, all thresholds passed, and no baseline regression.
- React and Vue fixture builds passed independently.
- Frozen event-wire checks and repository tests remain part of the root gate.

No baseline-only prose defect was added to the code-diff prompt corpus. The
live corpus contains only the causal issue-83 SDK diff and its expected doc/no-doc
outcomes, preserving the minimal-edit rule.
