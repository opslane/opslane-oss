# Dashboard guidance

The dashboard is a Vue 3 application served by ingestion.

## Conventions

- Use the Composition API with `<script setup>`.
- Keep API calls in `src/api.ts` and API contracts in `src/types/api.ts`.
- Treat error text and model output as untrusted. Sanitize them before rendering or interpolating them into HTML or Markdown.

## Verification

- Run `pnpm --filter @opslane/dashboard build` and `pnpm --filter @opslane/dashboard test`.
