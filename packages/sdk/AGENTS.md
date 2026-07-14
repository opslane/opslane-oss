# SDK guidance

The MIT-licensed browser SDK includes React and Vue integrations plus the Vite source-map plugin.

## Verification

- Run `pnpm --filter @opslane/sdk build` and `pnpm --filter @opslane/sdk test`.
- Confirm the real-browser contract tests execute rather than skip when changing browser capture or replay behavior.
- Run `pnpm --filter @opslane/sdk check:package` when changing exports or package contents.
