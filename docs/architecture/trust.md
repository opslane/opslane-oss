# Trust and security model

What Opslane can touch, what leaves your infrastructure, how credentials are handled, and what the current honest gaps are. Everything on this page describes the code as it is today — gaps are stated, not papered over.

## GitHub permissions

The worker needs to **read repository contents** (clone, source maps context) and **write pull requests**. Two credential modes:

- **Personal access token** (`GITHUB_TOKEN`): a fine-grained PAT with `contents` and `pull_requests` write on the repositories you connect.
- **GitHub App**: the worker mints short-lived installation tokens from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`. Installation tokens expire on the order of an hour and are scoped to the repositories the App is installed on. The App also powers dashboard sign-in (OAuth) and webhooks (HMAC-verified).

The worker pushes exactly one thing: a newly created fix branch (`git push origin <branch>`, no force flags anywhere in the pipeline), then opens a PR from it. It never pushes to existing branches; merging is always yours.

## Data flow: what leaves your host

| Destination | What is sent | When |
| --- | --- | --- |
| Anthropic API | Error details, stack traces, relevant source file contents, test output | Only during investigation, only with `ANTHROPIC_API_KEY` set |
| E2B sandbox | A clone of the connected repository, the candidate fix, dependency installs, test runs | Only during fix verification, only with `E2B_API_KEY` set |
| GitHub (worker) | The fix branch (pushed **before** PR creation — if the PR call then fails, the pushed branch remains and the incident ends `needs_human`), then the PR body (root cause, diff, verification evidence). The setup-PR flow likewise pushes an `opslane/setup` branch and opens a PR. | During fix delivery and setup-PR |
| GitHub (ingestion) | OAuth code exchange and user/email lookup (sign-in); installation and repository listing (App setup) | During dashboard sign-in and GitHub setup |

With no credentials configured, **nothing leaves your host** — the stack ingests, groups, and files `needs_human` incidents entirely locally.

Secrets hygiene in the sandbox: before the agent loop runs, well-known secret variables (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, storage and app secrets) are scrubbed from the environment the agent can observe (`packages/worker/src/repo-clone.ts`).

## Browser data and masking

Defense in two layers, both on by default — with an honest note on their scope:

**In the browser (SDK):** since SDK 1.0.0, session recording is **on by
default** (`replay.enabled` defaults to `true`). Earlier versions defaulted to
off; the default changed only across a major version, so it never flips under an
existing integration. Opt out with `replay: { enabled: false }`, or disable
recording for a whole project through the server-side `recording_enabled`
setting without redeploying. A dashboard control is not included in Batch 1.

Every session is recorded, not only error moments. All input values are masked
(`maskAllInputs: true`), as is anything matching `.opslane-mask`;
`.opslane-block` skips a subtree entirely. **Rendered page text is captured as
displayed unless you mask it** — this has not changed, but it now applies to
every session rather than only sessions that hit an error. If you have not
reviewed your masking, do that before upgrading.

For **chunked session recordings**, the browser uploads gzipped ~30s chunks
directly to private object storage via a size-capped presigned POST policy. A
server-side scrubber inflates each chunk under a hard ceiling, redacts it, and
re-stores it. A chunk is **unreadable until that completes**: `scrubbed_at` is
the only thing that makes it visible to any reader, and a chunk that cannot be
scrubbed stays unreadable permanently rather than being served raw.

The older error-triggered one-shot replay path still redacts by rewriting the
object at completion, so an upload interrupted before completion leaves the raw
recording in storage. That path is retired once error replays resolve to chunk
pointers.

For error events, ingestion also replaces sensitive headers, well-known API-key
prefixes, and URL-embedded credentials with `[REDACTED]` before persistence.

See [replay privacy and masking](../guides/replay-privacy.md) for what replay data may contain.

## Credential storage

- **Ingest API keys** are stored as SHA-256 hashes; the raw key is shown once at creation.
- **User sessions** are JWTs signed with `JWT_SECRET`, mated with rotating refresh-token families (token hashes only in the database).
- **GitHub App private key** and worker credentials are environment variables — supplied by your deployment, never written to the database.

## Honest gaps (current state)

These are known, tracked, and stated here so you can make an informed deployment decision:

- **Replay and session retention.** Chunked session recordings are deleted on a per-project clock (default 30 days, `projects.session_retention_days`), removing both the database rows and the entire stored-object prefix. Sessions pinned as incident evidence survive the normal window but are hard-capped at 90 days. Deleted session ids are tombstoned and their prefixes are re-swept continuously, so an upload accepted just before policy expiry cannot permanently recreate the data.
- **The older one-shot replay path still has no retention.** `session_replays` rows from the error-triggered path have no expiry or cleanup job and persist until you delete them. See [#29](https://github.com/opslane/opslane-oss/issues/29).
- **`github_token_encrypted` is unused.** The schema has an encrypted-token column, but no code path writes or reads it; GitHub credentials come from the environment (PAT or App key). Envelope-encrypted at-rest token storage is not implemented yet.
- **The bundled Compose file is a development deployment.** Development credentials, no backups, no upgrade/rollback procedure. A production operations guide is tracked separately and blocked on that work.

## Why the prompts are public

The investigation and fix prompts live in this repository (`packages/worker/src`), not behind an API. That is intentional: you can read exactly what instructions the agent operates under, what it is told never to do, and how untrusted error text is fenced (`<untrusted_user_data>` delimiters in the fix loop) before you let it near your code.
