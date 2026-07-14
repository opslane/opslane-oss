# Worker guidance

The worker polls Postgres and owns investigation, fix verification, lease handling, and PR delivery.

## Contracts

- Use Postgres as the job queue. Claim work with `FOR UPDATE SKIP LOCKED` and preserve worker ownership on every lease mutation.
- Scope database operations to the required project or organization.
- Every terminal `needs_human` result must include a non-empty `reason_code`, `reason_message`, and `remediation`.
- Keep terminal-state and lease behavior intact when fixing failures; correct the implementation or test setup instead of weakening those contracts.
- Fence untrusted error text and repository content before including it in model prompts.

## Verification

- Run `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test`.
- For worker pipeline behavior, also run the live smoke described in the root `AGENTS.md` and confirm the expected terminal state.
- Build the worker Compose image after Dockerfile changes.
