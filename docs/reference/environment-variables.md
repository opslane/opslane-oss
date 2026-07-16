# Environment variables

Every variable each service actually reads, from `os.Getenv` (ingestion) and `process.env` (worker). The [drift check](../../scripts/check-docs-drift.mjs) fails the repository test gate (`pnpm test`, which CI runs) if code and this page disagree.

## Ingestion API

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no (8080) | HTTP listen port |
| `JWT_SECRET` | yes | Signs session tokens (≥32 bytes) |
| `DASHBOARD_DIR` | no | Directory of built dashboard SPA to serve (set in the Docker image) |
| `DASHBOARD_ORIGIN` | no | Allowed dashboard origin for CORS **and** the OAuth redirect target. For the bundled Compose setup, set `http://localhost:8082`. |
| `GITHUB_APP_ID` | for GitHub App | App ID |
| `GITHUB_APP_CLIENT_ID` | for OAuth sign-in | OAuth client ID |
| `GITHUB_APP_CLIENT_SECRET` | for OAuth sign-in | OAuth client secret |
| `GITHUB_APP_PRIVATE_KEY` | for GitHub App | App private key (PEM) |
| `GITHUB_APP_SLUG` | no | App slug used in install URLs |
| `GITHUB_WEBHOOK_SECRET` | for webhooks | HMAC secret for webhook verification |
| `REPLAY_STORE_ENDPOINT` / `REPLAY_STORE_PUBLIC_ENDPOINT` | for replays | S3-compatible endpoint (internal / browser-visible) |
| `REPLAY_STORE_ACCESS_KEY` / `REPLAY_STORE_SECRET_KEY` | for replays | Storage credentials |
| `REPLAY_STORE_BUCKET` / `REPLAY_STORE_REGION` | for replays | Bucket and region |
| `INTERNAL_READ_TOKEN` | for worker replay evidence | Shared secret guarding worker-to-ingestion chunk reads. Unset disables the internal endpoint. |
| `VERSION` | no | Reported by `/health` |

Ingestion reads **only** the `REPLAY_STORE_*` names; `MINIO_*` names appear in its test code, not runtime configuration.

## Worker

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes (hard exit without it) | Postgres connection string |
| `INGESTION_BASE_URL` | for session replay evidence | Base URL used to fetch decoded, re-redacted session chunks from ingestion |
| `INTERNAL_READ_TOKEN` | for session replay evidence | Shared secret sent to ingestion as `X-Internal-Token` |
| `ANTHROPIC_API_KEY` | for investigation | Claude API access; missing → `missing_llm_key` outcomes |
| `E2B_API_KEY` | for verification | Sandbox where fixes are tested |
| `GITHUB_TOKEN` | one of the two GitHub modes | PAT for clone + PR |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | the other mode | GitHub App installation tokens |
| `DASHBOARD_URL` / `DASHBOARD_ORIGIN` | no | Links in PR bodies and notifications |
| `WORKER_ID` | no (generated) | Stable worker identity for lease ownership |
| `POLL_INTERVAL_MS` / `LEASE_DURATION_MS` / `REAPER_INTERVAL_MS` / `SILENCE_CHECK_INTERVAL_MS` | no | Queue tuning |
| `SESSION_ANALYSIS_MAX_CONCURRENT` | no (2) | Fleet-wide cap on concurrently claimed `session_analysis` jobs; `0` disables analysis claiming entirely |
| `HEALTH_PORT` | no (8081) | Health endpoint port |
| `REPLAY_STORE_ENDPOINT` / `REPLAY_STORE_ACCESS_KEY` / `REPLAY_STORE_SECRET_KEY` / `REPLAY_STORE_BUCKET` | for replay analysis | Reading stored replays |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET` | legacy aliases | Worker-side fallback names for the same settings |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` / `LANGFUSE_PROJECT_ID` | no | Optional LLM tracing |
| `ANTHROPIC_BASE_URL` | no (Anthropic default) | Alternate Claude API endpoint; used by the hermetic test harness's fake model server |
| `OPSLANE_SANDBOX_BACKEND` | no (`e2b`) | Fix-verification sandbox backend; `local` is only for trusted reliability fixtures and also requires `OPSLANE_RELIABILITY_HARNESS=1` |
| `OPSLANE_RELIABILITY_HARNESS` | no | Explicit guard required before the non-isolating local sandbox test transport can run |
| `OPSLANE_GITHUB_URL` | no (`https://github.com`) | Alternate git host for clones; used by tests and self-hosted git |
| `OPSLANE_GITHUB_API_URL` | no (GitHub default) | Alternate GitHub REST API base URL for PR creation |

The worker starts with only `DATABASE_URL` and logs a warning for missing `ANTHROPIC_API_KEY`, `E2B_API_KEY`, and `GITHUB_TOKEN` — jobs then end in explicit `needs_human` states rather than crashing.

## Set in Compose but consumed by no code (known dead config)

| Variable | Status |
| --- | --- |
| `ALLOW_REGISTRATION` | Read by nothing; there is no self-serve registration path (sign-in is GitHub OAuth). |
| `ENCRYPTION_KEY` | Read by nothing except a sandbox scrub list; at-rest token encryption is not implemented (see [trust](../architecture/trust.md#honest-gaps-current-state)). |
