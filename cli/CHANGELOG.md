# @opslane/cli

## 0.1.0

### Minor Changes

- 778b280: Add the agent-first onboarding protocol: non-blocking setup and authenticated relink flows, origin-and-repository-scoped credentials, safe poll-token persistence, structural SDK codemods, and a machine-readable CLI contract. Correct the SDK replay documentation and make the Vue plugin type compatible with Vue's plugin API.

### Patch Changes

- c0a6eac: Publish readiness. SDK type declarations are now bundled into flat per-entry files, inlining types from the private `@opslane/shared` package — previously the published tarball's types were unresolvable for npm consumers. CLI tarball now ships only `dist` and carries repository metadata required for npm provenance.
