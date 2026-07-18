# HTTP routes

All routes registered by the ingestion API (`packages/ingestion/handler/routes.go`). Auth column legend: **none** (public), **SDK** (`X-API-Key` per-environment key; browser endpoints also origin-gated and rate-limited per project), **session** (dashboard JWT cookie or CLI token), **either** (session or SDK).

These are curated tables, not a stability contract — the API is early-stage and may change. The [drift check](../../scripts/check-docs-drift.mjs) fails the repository test gate (`pnpm test`, which CI runs) if this page and `routes.go` disagree.

## Public

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness + dependency checks |
| GET | `/metrics` | none | Internal metrics |
| POST | `/auth/refresh` | none | Rotate session tokens |
| GET | `/auth/login` | none | Begin the configured identity-provider sign-in |
| GET | `/auth/github` | none | Compatibility redirect to `/auth/login` |
| GET | `/auth/callback` | none | Configured identity-provider callback |
| GET | `/auth/github/callback` | none | Compatibility callback alias for existing GitHub App configurations |
| GET+POST | `/oauth/authorize` | none | CLI PKCE authorization |
| POST | `/oauth/token` | none | CLI PKCE token exchange |
| POST | `/api/v1/agent/setup` | none | Agent-first onboarding start |
| GET | `/api/v1/agent/poll/{sessionID}` | none | Agent onboarding poll |
| GET | `/agent/auth/{sessionID}` | none | Agent onboarding browser auth |
| GET | `/agent/auth/callback` | none | Agent onboarding callback |
| POST | `/api/v1/github/webhook` | HMAC | GitHub webhook receiver — requires `X-GitHub-Delivery` (400 without it); responds `processed`, `no_match`, or `duplicate` (idempotent on redelivery) |

## SDK (X-API-Key)

| Method | Path | Origin-gated | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/events` | yes | Ingest an error event |
| POST | `/api/v1/replays/init` | yes | Begin a replay upload |
| POST | `/api/v1/replays/{replayID}/complete` | yes | Finish a replay upload |
| POST | `/api/v1/replays/{replayID}/fail` | yes | Record a replay upload failure |
| POST | `/api/v1/sessions/init` | yes | Register a session; returns the recording kill switch |
| POST | `/api/v1/sessions/{sessionID}/chunks/upload-url` | yes | Size-capped presigned POST policy for one chunk |
| POST | `/api/v1/sessions/{sessionID}/chunks/{seq}/commit` | yes | Acknowledge an uploaded chunk exists |
| POST | `/api/v1/sessions/{sessionID}/chunks/{seq}/inline` | yes | Keepalive tail flush on tab close (at most 64KB) |
| POST | `/api/v1/sourcemaps` | no (build-time upload) | Upload source maps |

## Session (dashboard/CLI)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/auth/me` | Current user |
| GET | `/api/v1/auth/verify` | Validate session |
| POST | `/api/v1/auth/logout` | End session |
| POST | `/auth/switch-org` | Cloud only: rotate the current session into another member organization |
| GET | `/api/v1/invitations` | Cloud org admin: list active-org invitations |
| POST | `/api/v1/invitations` | Cloud org admin: create an active-org invitation |
| DELETE | `/api/v1/invitations/{invitationID}` | Cloud org admin: revoke an outstanding invitation |
| POST | `/api/v1/invitations/accept` | Cloud: accept a single-use, verified-email-bound invitation |
| GET | `/api/v1/admin/overview` | Operator-only cross-tenant observability overview (404 unless allowlisted) |
| GET | `/api/v1/admin/jobs` | Operator-only recent jobs (404 unless allowlisted) |
| POST | `/api/v1/onboarding/setup` | First-run setup |
| GET | `/api/v1/projects` | List projects |
| POST | `/api/v1/projects` | Create project |
| PATCH | `/api/v1/projects/{projectID}` | Update project settings, including `friction_autonomy` and `pr_posture` (partial: omitted/null fields are preserved, so `github_repo` can no longer be cleared here) |
| GET | `/api/v1/projects/{projectID}/fix-stats` | Per-kind fix generation and PR outcome receipts |
| GET | `/api/v1/projects/{projectID}/environments` | List environments |
| POST | `/api/v1/projects/{projectID}/environments` | Create environment |
| POST | `/api/v1/environments/{envID}/api-keys` | Create ingest key |
| GET | `/api/v1/projects/{projectID}/api-keys` | List ingest keys |
| GET | `/api/v1/projects/{projectID}/replays/{replayID}` | Fetch a replay |
| GET | `/api/v1/projects/{projectID}/sessions` | List sessions with filters and keyset pagination |
| GET | `/api/v1/projects/{projectID}/sessions/{sessionID}` | Session detail and scrubbed chunk manifest |
| GET | `/api/v1/projects/{projectID}/sessions/{sessionID}/chunks/{seq}` | Fetch one decoded, re-redacted scrubbed chunk |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}/affected-users` | Affected users |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/fix` | Trigger an eligible error or approved friction fix |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/resolve` | Resolve incident |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/archive` | Archive incident |
| POST | `/api/v1/projects/{projectID}/incidents/{incidentID}/unarchive` | Unarchive incident |
| GET | `/api/v1/projects/{projectID}/accounts` | List B2B accounts |
| GET | `/api/v1/projects/{projectID}/accounts/{accountID}` | Account detail |
| GET | `/api/v1/projects/{projectID}/accounts/{accountID}/incidents` | Account incidents |
| GET | `/api/v1/github/setup` | GitHub App install callback |
| GET | `/api/v1/github/status` | GitHub App status |
| GET | `/api/v1/github/repos` | List installable repos |
| PUT | `/api/v1/projects/{projectID}/github` | Set project repo config |
| GET | `/api/v1/projects/{projectID}/github` | Get project repo config |
| DELETE | `/api/v1/projects/{projectID}/github` | Remove project repo config |
| POST | `/api/v1/projects/{projectID}/setup-pr` | Open SDK setup PR |
| GET | `/api/v1/projects/{projectID}/setup-pr` | Setup PR status |

## Session or SDK

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/projects/{projectID}/event-count` | Event count stats |
| GET | `/api/v1/projects/{projectID}/incidents` | List incidents |
| GET | `/api/v1/projects/{projectID}/incidents/{incidentID}` | Incident detail |

## Internal service reads

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/internal/v1/projects/{projectID}/sessions/{sessionID}/chunks/{seq}` | `X-Internal-Token` | Worker fetch of one decoded, re-redacted scrubbed chunk |

## Catch-all

Any other path serves the dashboard SPA from `DASHBOARD_DIR` (missing static assets 404 rather than falling back to `index.html`).
