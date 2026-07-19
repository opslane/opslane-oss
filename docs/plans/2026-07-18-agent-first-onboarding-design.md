# Agent-First Onboarding ("Let your agent do it")

**Date:** 2026-07-18
**Status:** Draft — v5 after four adversarial review rounds (Codex: 25 findings; round 2: 9; round 3: 7; round 4 on the PR 1 implementation plan: 8 — all 49 dispositioned below). Phase 0 spike completed 2026-07-18 (D-B: OAuth-during-install + shared callback dispatcher). D-A ratified. PR 1 server implementation landed; later onboarding PRs remain planned.
**Author:** Abhishek + Claude; reviews by Codex + external rounds 2–3

## Problem

Signup today is UI-first: OAuth login → dashboard SetupWizard → copy API key → paste SDK snippet. A growing share of new users will arrive as a coding agent (Claude Code, Codex) acting on the human's behalf. Target (context.dev pattern): the human pastes **one line** into their agent; the agent signs them up, obtains an API key, integrates the SDK, and verifies it works — the human's only job is one GitHub authorization step.

The backend skeleton exists on this branch (`packages/ingestion/handler/agent_setup.go`, `cli/src/setup.ts`). Two review rounds established it is not launch-ready: the trust anchor is bypassable and its proposed fix is **unproven against GitHub's actual callback behavior**, key delivery can lose the key, the session secret leaks into browser history, the CLI deadlocks agents and cannot recover, the codemods emit syntactically invalid or architecturally wrong output, and the launch sequencing would advertise a broken flow. The plan fixes the flow first, lands content dark, and activates last.

## Prior art: context.dev

Landing card with a copy-paste prompt referencing an agent-facing markdown URL + quickstart; agent registers via API, human completes a **mandatory browser claim**, agent polls for a long-lived key. Opslane's GitHub App authorization plays the claim role and also grants the repo access Opslane needs for fix PRs.

## Decisions

Ratified (user, 2026-07-18):

1. **Trust anchor is the GitHub App authorization step.** No new email-claim path.
2. **Hosted cloud first.** Defaults target `https://api.opslane.com`; self-host via `OPSLANE_API_URL`.
3. **Doc-driven orchestration, no mega-command.**

v2 decisions, revised in v3:

4. **Human identity is mandatory in the callback — mechanism decided by the Phase 0 spike (R1).** v2 assumed enabling "Request user authorization during installation" delivers `state + code + installation_id` to our agent callback. GitHub's documented behavior (OAuth-during-install redirects to the App's OAuth **Callback URL**, globally, and disables Setup URL behavior) contradicts that assumption and would also reroute the human SetupWizard flow. The spike picks between: shared callback dispatcher, two-stage install-then-OAuth, or a separate agent-only App.
5. **The callback must prove repo access** (installation-token check; `repo_not_granted` failure).
6. **Key delivery is idempotent until session expiry** — but retrieval moves to a dedicated poll token (decision 10).
7. **`setup` gets a non-blocking mode** (`--start` / `--poll --timeout`).
8. **Replay stays on by default; the quickstart requires the agent to surface it** with the opt-out and `docs/guides/replay-privacy.md`.
9. **Publish and verify before advertise** — hardened into content-vs-activation split (decision 13).

New in v3 (round 2):

10. **Split the secrets (R6).** The session ID (in the human-facing auth URL and GitHub `state`, i.e. browser history and logs) is no longer the key-retrieval secret. `POST /agent/setup` returns a separate high-entropy `poll_token`; only its SHA-256 hash is stored. Idempotent key delivery is only safe with this split.
11. **Recovery requires authentication (R3).** `setup --force` cannot mint keys for an existing project (the server correctly refuses). Recovery = `opslane login` (existing PKCE flow) + a `relink` path that mints a fresh env key via the existing authenticated endpoint. Local credentials are never deleted until the replacement is saved.
12. **The API origin travels with the flow (R4).** Pending-session state (including `api_url`) is persisted locally so `setup --poll` in a fresh process targets the right server; credentials are keyed by **origin + repo**; `snippet` emits `endpoint` whenever the origin differs from the hosted default.
13. **Content lands dark; a final activation PR flips it on (R8).** Docs pages, cards, and the one-liner merge unreferenced/flag-off; activation requires npm registry visibility, a clean `npx @opslane/cli@latest` smoke, and the live GitHub App smoke.

New in v4 (round 3):

14. **The user token must prove control of the installation (R3-1).** App-JWT `VerifyInstallation` only proves the installation belongs to our App — `installation_id` is an attacker-controlled query parameter. Acceptance criterion: after the code exchange, the server calls `GET /user/installations` (paginated) with the exchanged user token and requires the presented `installation_id` to appear in the result; only then is the installation token used to prove repository access. This binding applies to **both** dispatcher branches — the agent flow and the web flow's `applyCombinedGitHubInstallation`. (The spike already demonstrated the check; v3 had dropped it from PR 1's acceptance criteria.)
15. **No recoverable plaintext API key at rest (R3-2).** v3's "plaintext until expiry" violated the repo guardrail against plaintext production credentials — as does the *existing* `api_key_plaintext` column. Design (sealed box; corrected in v4.1 — a symmetric key derived from the poll token is impossible server-side at callback time, since the server holds only the token's hash): at **setup** time, while the server briefly holds the raw poll token it just generated, it derives an X25519 keypair from the token and stores only the **public** key (plus the token hash). At **provisioning**, the API key is sealed to that public key (ephemeral X25519 + AES-256-GCM, session ID as AAD). At **poll**, the presented token re-derives the private key and opens the box. The server at rest (hash + public key + ciphertext) cannot decrypt — idempotent delivery that survives crashes/restarts with nothing recoverable. Std-lib only (`crypto/ecdh`). The expiry sweep is extended to purge ciphertext from **completed** sessions past expiry (today's sweep only touches pending rows). Tests: crash/restart re-delivery, wrong-token/wrong-session open failure, completed-session cleanup.
16. **Repo-provisioning serialization is a lock on repo identity, not the session row (R3-3; revised by R4-6).** A session-row lock cannot serialize two *different* sessions racing to provision the same repo, and `projects.github_repo` has no uniqueness. Mechanism: inside the provisioning transaction, take `pg_advisory_xact_lock` on canonical repo identity, then re-check project existence under the lock before inserting — this is the **only** serializer. The v4 "one pending session per repo" partial unique index is **dropped** (R4-6): on an unauthenticated endpoint it let anyone squat a public repo's slot and DoS its real owner until the hourly sweep. Multiple pending sessions are allowed; losers fail `repo_already_configured` at the lock. Canonical identity = the `full_name` GitHub returns for the repo in the installation's repo list (rename-canonicalized), compared case-insensitively. A numeric GitHub repo-ID uniqueness column on `projects` is the stronger long-term fix — deferred (schema change beyond this scope) and noted.

Resolved during review:

- ~~**D-A (R5)**~~ — **RATIFIED (founder, 2026-07-18):** if the resolved user is not a member of the org the installation maps to, the session fails with `org_exists_needs_invite` and remediation (admin invites via existing `org_invitations`); no silent membership grants.
- ~~**D-B (R1): Callback mechanism**~~ — **RESOLVED by the Phase 0 spike (see §Phase 0 findings): OAuth-during-install with a shared callback dispatcher.** GitHub empirically delivers `code + installation_id + setup_action + state` together to the callback URL in one human interaction. Two-stage is the proven fallback if GitHub's undocumented combined contract ever changes.

## The one-liner

> Set up Opslane error monitoring in this repo. Fetch https://docs.opslane.com/agent.md and follow it exactly: run `npx -y @opslane/cli setup --start` to create an account and get an API key (I'll complete one GitHub authorization step when you show me the link), then install `@opslane/sdk` and verify the first event arrives.

- Self-hosted dashboards render it via `buildAgentPrompt(origin)` with an `OPSLANE_API_URL=<origin>` prefix; the origin then persists through poll/snippet via decision 12 — the prefix alone is not the mechanism.
- "One GitHub authorization step," never "one click" (F17).

## Work plan

### Phase 0 — GitHub callback feasibility spike — DONE (2026-07-18)

Method: two throwaway GitHub Apps created via the manifest flow against a localhost capture server; both install flows executed live by the founder; every redirect logged. Raw log: spike scratchpad `spike-log.jsonl` (session-local; findings preserved here).

**Findings:**

1. **Experiment A — OAuth-during-install ON (App `opslane-spike-a-e196`).** After `installations/new?state=spike-a-68b4365b`, GitHub redirected the human to the **Callback URL** with **all four parameters together**: `code`, `installation_id=147489201`, `setup_action=install`, and `state` intact. One continuous human interaction (GitHub folds authorization into the install screen). Code exchange returned a `ghu_` user token; `GET /user` gave login + email; `GET /user/installations` listed exactly the new installation — the untrusted `installation_id` is verifiable through the user token, as GitHub's docs recommend. **v2's assumed contract holds empirically even though GitHub's docs don't promise `state`/`installation_id` on this redirect.**
2. **Experiment B — two-stage (App `opslane-spike-b-2075`).** Setup URL received `installation_id + setup_action + state` (state intact through the install hop); redirecting the human to `login/oauth/authorize` with our own state produced `code + state` at the callback. Works end-to-end, but costs a second GitHub screen (separate Authorize page).
3. **Manifest-flow facts:** `hook_attributes.url` must be publicly reachable even with `active:false` (localhost rejected) — use a public dummy URL; the `state` on `settings/apps/new?state=` is echoed to the manifest `redirect_url`; conversion returns id/slug/pem/client_id/client_secret.
4. **Private apps install only to the owning account** (observed: personal namespace only). Fine for dev/smoke apps; the production App is public.

**D-B resolution: Experiment A wins** — one human interaction, exact parameter contract our design needs. Implementation consequence for PR 1: enabling OAuth-during-install applies to **every** install of the production App and disables its Setup URL, so the App's callback URL becomes a **shared dispatcher**: `state` matches a pending agent session → agent flow; otherwise → the existing web-install path (SetupWizard's install handling must be migrated off the Setup URL as part of PR 1). Two-stage (Experiment B) is the proven fallback.

**Assets:** spike App A (`opslane-spike-a-e196`, id 4334696) can be repurposed as the PR 6 development App (repoint its callback to the local ingestion URL); App B (`opslane-spike-b-2075`, id 4334699) can be deleted. Spike credentials live only in the session scratchpad (mode 0600) — delete after PR 6 or regenerate.

### PR 1 — Server: harden the agent flow (AGPL)

**Status: implemented** — see `2026-07-18-agent-onboarding-pr1-server-plan.md`.

`agent_setup.go`, `db/queries.go`, migration `016_agent_sessions_v2.sql`, `gh` package. Callback shape per D-B resolution:

- **Shared callback dispatcher (D-B):** enable "Request user authorization (OAuth) during installation" on the App; its callback URL handles every install with `code + installation_id + setup_action + state`. Dispatch on `state`: matches a pending agent session → agent flow; otherwise → existing web-install handling. **Migrate SetupWizard's install flow off the Setup URL** (disabled by this setting) onto the same dispatcher.
- **Mandatory identity (F1, F3, R5; state machine settled by R4-8):** a session completes only with a proven identity, but a missing/failed `code` exchange is **transient** — the session stays `pending` and the human is told to reopen the auth link. (The session ID is browser-visible, so cheap unauthenticated requests must never be able to kill a session; there is deliberately no `identity_required` failure state.) Definitive failures require a live user token: `identity_unverified` (email list fetched successfully, no verified address), `installation_not_yours`, `repo_not_granted`, `org_exists_needs_invite`, `repo_already_configured`. A transient GitHub API error (including the email-list fetch) never converts to a definitive failure (R4-3). Identity resolution **reuses the provider-neutral verified-identity logic** (the `auth_identities` path): verified-email rules apply, no synthesized `users.noreply.github.com` addresses, identities recorded with real verification state; identity/email resolution takes the **same advisory locks as `ProvisionFromIdentityTx`** so agent and web provisioning of one human serialize (R4-4). Existing-installation resolution consults **both** the rich `github_app_installations` table and the legacy `orgs.github_installation_id` column (R4-5); membership is checked and D-A governs the outcome.
- **User↔installation binding (R3-1, decision 14):** after the code exchange, `GET /user/installations` with the user token (paginated) must contain the presented `installation_id`; else `failed`, `reason: installation_not_yours`. App-JWT verification alone is insufficient. Enforced in both dispatcher branches (agent flow **and** `applyCombinedGitHubInstallation`).
- **Repo-access proof (F2):** installation-token check that the session's repo is granted (case-insensitive match against GitHub's canonical `full_name`; the canonical name is what gets stored — R3-3); else `failed`, `reason: repo_not_granted`.
- **One transaction including completion (F5, R2, R3-3):** inside one transaction: `SELECT ... FOR UPDATE` on the session row, `pg_advisory_xact_lock` on canonical repo identity (decision 16), re-check project existence under the lock, then org/user/identity/installation/project/env/key writes **and** session completion. Tests: concurrent callbacks on one session (one completes, one gets not-pending), concurrent sessions racing the same repo (exactly one project row results), and concurrent sessions for different repos by the same new identity (both succeed, one user, one org — R4-4). The old post-commit completion guard is removed.
- **Split tokens + encrypted delivery (F6, R6, R3-2, decision 15):** `agent_sessions` gains `poll_token_hash` and `api_key_sealed` (replacing plaintext storage). Setup returns `poll_id` (non-secret routing id) + `poll_token` (high-entropy, shown once). Poll contract: token in the **`X-Opslane-Poll-Token`** header; missing or non-matching token → the same `404 {"status":"not_found"}` as an unknown session (no existence oracle); hashes compared constant-time; all agent-endpoint bodies are machine-stable `{"status": ...}` shapes, never `{"error": ...}` (R4-7). On match the key is decrypted with the presented token and returned on every poll **until `expires_at`, enforced in the poll handler itself** — the hourly purge sweep is only a backstop, never the enforcement (R4-2). Migration is expand-only: `api_key_plaintext` is kept (old binaries still read it), stops being written, and is dropped by a follow-up contract migration after deploy + drain (R4-1).
- **No tenant leakage (F4):** `already_configured` returns status + remediation only — no `project_id`/`org_id` (today it returns both).
- **Failure states (F17):** `status='failed'` + `failure_reason`; poll surfaces them.
- **Canonical origin (F25):** `auth_url` built from `AUTH_CALLBACK_ORIGIN` when set.
- **Rate-limit contract (R9):** 429 responses gain a `Retry-After` header so the CLI's `retry_after` field is backed by the server.

Verification: `go build ./... && go test ./...`; new tests: identity-required, installation-not-yours, repo-not-granted, concurrent callbacks (one project, one completion), concurrent same-repo sessions (one project row), poll with wrong/missing token (404, no oracle), double-poll same key, decrypt-after-restart (ciphertext + fresh token presentation still delivers), post-expiry nothing + ciphertext purged, migration fresh+reapply on a disposable DB.

### PR 2 — CLI: agent-safe protocol + first npm publish (MIT)

- **Formal CLI contract (R9, R3-7):** a `docs/reference/cli-agent-contract.md` table — for each command: every `status` value, HTTP cause, JSON schema, exit code, retry rule. Invariants: exactly one JSON document per invocation on stdout, diagnostics to stderr; `pending`/`auth_required` are exit 0 (not errors); conflicts (`--start` + `--poll`) are usage errors with JSON output. **The one-JSON invariant covers `setup`, `snippet`, `verify`, `status` only; `login` is documented as an interactive human command and exempt.** The contract also pins: poll-token header name `X-Opslane-Poll-Token`; the canonical-origin algorithm (lowercase scheme+host, strip default ports 80/443, no trailing slash or path); and atomic local-file writes (temp file + rename, mode 0600). Tested by running the **compiled CLI as a subprocess**.
- **Hosted default:** `cli/src/config.ts` (`https://api.opslane.com` fallback) used by `setup`/`login`/`doctor`.
- **Non-blocking flow (F9) + origin persistence (R4):** `setup --start` writes `~/.opslane/pending/<poll_id>.json` (`api_url`, `repo`, `poll_token`, `created_at`, mode 0600) and prints `auth_url`/`poll_id`. `setup --poll <id> [--timeout 60]` loads that state — the origin can no longer silently reset to hosted mid-flow. Completed/expired pending files are cleaned up.
- **Repo+origin-scoped credentials (F7, R4):** credentials map keyed by `<canonical-origin>|<owner/repo>`, migrating the old single-object shape on read.
- **Recovery (F8, R3, R3-4):** `--force` clears local state and re-runs **only when the server has no project for the repo**. `already_configured` output directs to `opslane login` + `opslane setup --relink`. Origin-safety: PKCE tokens move from the single global `~/.opslane/credentials.json` to the same canonical-origin keying as agent credentials; `--relink` resolves its origin from the repo's pending/agent state or `--api-url`, its project by repo lookup over the authenticated project list, and defaults to the `production` environment before calling the existing `POST /api/v1/environments/{envID}/api-keys`. Old credentials are preserved until the new key is written. **Documented limitation:** recovery requires a local interactive session (browser for PKCE); headless/remote agents are told to have the human mint a key in the dashboard instead — `login` is not part of the one-JSON agent contract.
- **Agent-safe errors (F10):** guarded fetch/parse; poll statuses mapped (`not_found`, `expired`, `rate_limited` + server `Retry-After`, `api_unreachable`, pass-through `failure_reason`).
- **Structural codemod rework (F11, R7):** current transforms are broken beyond the placeholder values — vue inserts mid-expression after the substring `createApp(` (invalid output), Next injects a browser SDK init into `app/layout.tsx` (a Server Component). v3 codemods:
  - react-vite / vue-vite: line-anchored insertion (after the import block; `app.use(opslaneVuePlugin)` after the full `const app = createApp(...)` statement, handling multiline calls). Idempotency is **per-aspect, not per-import (R3-6)**: import, `init(...)` call, plugin registration, and env configuration are each detected independently, so a project that imports another SDK symbol still gets initialization, and re-running never duplicates any aspect.
  - nextjs app router: create `app/opslane-client.tsx` (`'use client'` init component) imported from the layout — never init in the Server Component; pages router: `_app` stays but with env-var key.
  - nuxt: plugin file via runtime config.
  - All emit env-var reads (`import.meta.env.VITE_OPSLANE_API_KEY` / `process.env.NEXT_PUBLIC_OPSLANE_API_KEY`), no `environment` option (not in `OpslaneInitConfig`), plus an `env` section (`{var, value, file: ".env.local", gitignore: true}`). `snippet` adds `endpoint: <origin>` when the credential origin ≠ hosted default (R4).
- **Package-manager detection (F24):** install command from lockfile.
- **doctor agent-aware (F12):** passes on agent credentials for the current origin+repo or PKCE tokens; `.opslane.json` optional.
- **Publish (F13, R8):** `"publishConfig": {"access": "public"}`, changeset to 0.1.0. Note the pipeline reality: `release-npm.yml` (changesets/action) first opens a **Version Packages PR — merging PR 2 does not publish**. Publication completes only when that PR merges; the activation gate checks the registry, not the merge.
- Fix `packages/sdk/README.md:95` replay-default row.
- Tests: contract subprocess suite; **apply-and-build fixtures for all four frameworks** (add clean Next + Nuxt fixtures alongside `test-fixtures/react-app`, `vue-app`); codemod edge fixtures — multiline `createApp(...)`, aliased imports, partial integrations (import-only, init-only), comment-adjacent anchors, and double application (R3-6); one browser event-capture test (fixture app + patched init actually delivers an event to a local server) (R7).

### PR 3 — Agent quickstart content (lands dark)

- `docs/quickstart/agent.md` + `docs-site/src/pages/agent.md.ts` raw endpoint. **Real dark launch (R8, R3-5):** "unreferenced" is not enough — the `starlight-llms-txt` plugin auto-includes every non-draft entry in the generated llms files. The page ships with `draft: true` frontmatter (excluded from the built site, navigation, search index, and llms outputs) until PR 7 flips it; verify during PR 3 that the plugin honors `draft` and add an explicit exclusion if it does not. The raw `/agent.md` endpoint is gated on the same flag. A built-artifact test asserts the slug is absent from navigation HTML, the Pagefind index, and `llms.txt`/`llms-full.txt` while dark.
- Content: audience statement ("`setup`, `snippet`, `verify`, `status` print JSON" — F22) → `setup --start`, show `auth_url` verbatim, loop `setup --poll` → apply `snippet` patches + env file → replay privacy step (decision 8) → trigger error + `verify` → failure table (`expired`, `rate_limited`, `identity_unverified`, `installation_not_yours`, `repo_not_granted`, `org_exists_needs_invite`, `repo_already_configured`, org-approval-pending; plus the transient "reopen the auth link" cases which never fail the session — R4-8) → self-hosting → raw HTTP appendix (including poll-token header).
- Absolute `https://docs.opslane.com/...` links only (F21) + endpoint test (raw `.md` bypasses the HTML link checker).
- `covers:` frontmatter for drift checks.

### PR 4 — Dashboard cards (flag-off) (AGPL)

- `agent-onboarding.ts` with `buildAgentPrompt(origin)`; cards in `Login.vue` + `SetupWizard.vue` behind a config flag **default off** (R8).

### PR 5 — Funnel telemetry (AGPL)

- Columns from PR 1's migration (`auth_clicked_at`, `key_claimed_at`, `failure_reason`). Steps: `setup_started` (`created_at`), `auth_clicked` (COALESCE in `AgentAuthRedirect`), `completed`, `key_claimed` (first delivery, exactly-once by COALESCE), `first_event_received` (read-time `EXISTS` to `error_events` — point-in-time metric, not an event log) (F18).
- `OnboardingFunnel(ctx, since)` (default 30 days, explicit param); post-migration sessions only, no backfill. Exposed via `AdminOverview`.
- Scoped out (F19): card-impression/copy/doc-fetch analytics — needs a client analytics vendor decision.

### PR 6 — Live end-to-end smoke

- Uses the Phase 0 development App. Full loop from `test-fixtures/react-app`: `setup --start` → human authorization → `setup --poll` → patches + env file → error → event at `/api/v1/events` → `verify` `has_events:true` → funnel 1/1/1/1/1.

### PR 7 — Activation (R8)

Flips everything public in one reviewable diff: docs sidebar entry + landing CTA (`index.mdx`) + llms.txt entry + `docs/install.md` pointer + dashboard card flag on.

Gates (all must hold before merge):
1. `npm view @opslane/cli version` returns ≥ 0.1.0 (Version Packages PR merged and published).
2. Clean-machine smoke: `npx -y @opslane/cli@latest setup --start` from a **fresh git clone with an `origin` remote** (repo detection needs one; an empty directory cannot pass) against a disposable server (R3-7).
3. PR 6 live smoke green.
4. Hosted domains live (`api.opslane.com`, `docs.opslane.com`) and hosted GitHub App configured per D-B.

## Dispositions

### Round 1 — Codex (F1–F25)

| # | Finding (short) | v3 disposition |
|---|---|---|
| F1 | Human click bypassable | PR 1 mandatory identity; **mechanism via Phase 0 spike** (superseded detail: v2's OAuth-during-install assumption was unproven, see R1) |
| F2 | No repo-access check | PR 1 installation-token check |
| F3 | Org without usable user | PR 1 verified-identity reuse (revised by R5) |
| F4 | `already_configured` leaks IDs | PR 1 status-only response |
| F5 | "One transaction" false | PR 1 single tx **including `CompleteAgentSession`** (extended by R2) |
| F6 | One-shot key claim loses key | PR 1 idempotent delivery **behind split poll token** (extended by R6) |
| F7 | Machine-global credentials | PR 2 origin+repo-keyed map (extended by R4) |
| F8 | `credentials_invalid` dead end | PR 2 `--force` (no project) / `login` + `--relink` (existing project) (revised by R3) |
| F9 | Blocking poll deadlock | PR 2 `--start` / `--poll --timeout` |
| F10 | Errors look like pending | PR 2 status-mapped errors |
| F11 | Codemods emit placeholders/bad options | PR 2 structural rework (extended by R7) |
| F12 | doctor incompatible | PR 2 agent-aware |
| F13 | Publish sequenced after advertising | PR 2 publish + PR 7 activation gates (extended by R8) |
| F14 | Local smoke impossible with prod App | Phase 0 dev App + PR 6 |
| F15 | Self-host one-liner points hosted | PR 4 `buildAgentPrompt` + PR 2 origin persistence (extended by R4) |
| F16 | Replay without human decision | Decision 8, PR 3 quickstart step |
| F17 | "One click" overpromises | PR 1 failure states + PR 3 wording; approval-pending state machine scoped out (sessions expire, re-run documented) |
| F18 | Funnel semantics undefined | PR 5 definitions |
| F19 | No upstream funnel analytics | Scoped out (vendor decision) |
| F20 | Landing CTA missing | PR 7 (moved from PR 3 by R8) |
| F21 | Raw agent.md relative links | PR 3 absolute links + test |
| F22 | "All commands print JSON" false | PR 3 wording narrowed |
| F23 | No apply+compile tests | PR 2 fixtures all four frameworks + browser test (extended by R7) |
| F24 | Hardcoded npm install | PR 2 lockfile detection |
| F25 | auth_url trusts Host | PR 1 `AUTH_CALLBACK_ORIGIN` |

### Round 2 — plan feedback (R1–R9)

| # | Finding | v3 disposition |
|---|---|---|
| R1 (P0) | OAuth-during-install callback contract unproven; affects all installs globally | **Phase 0 spike** before PR 1; D-B open until it reports |
| R2 (P0) | `CompleteAgentSession` outside the provisioning tx; races still orphan/duplicate | PR 1: row lock + provision + complete in one tx; concurrency tests; old guard removed |
| R3 (P0) | `--force` can't recover an existing project; can strand the user keyless | Decision 11: authenticated `login` + `--relink` via existing key endpoint; old creds preserved until replacement saved |
| R4 (P0) | Origin doesn't survive poll/snippet; creds keyed only by repo | Decision 12: pending-session state file, origin+repo credential keys, `endpoint` in snippet |
| R5 (P1) | Identity provisioning bypasses verified-email logic; existing-org installer role undefined | PR 1 reuses `auth_identities` verified flow; **D-A open** (proposed: `org_exists_needs_invite`, no silent membership) |
| R6 (P1) | Session ID doubles as bearer secret in browser-visible URLs | Decision 10: split `poll_token` (hashed server-side) from session/routing id |
| R7 (P1) | Codemods structurally broken (vue mid-expression insert, Next server-component init) | PR 2 structural transforms, `'use client'` component for Next app router, 4 fixtures + browser event test |
| R8 (P1) | Sequencing contradiction; changesets doesn't publish on merge | Decision 13: content dark (PRs 3–4), activation PR 7 gated on registry visibility + smokes |
| R9 (P2) | No formal CLI protocol; `retry_after` unbacked | PR 2 contract doc + subprocess tests; PR 1 adds `Retry-After` header |

### Round 3 — plan feedback (R3-1–R3-7)

| # | Finding | v4 disposition |
|---|---|---|
| R3-1 (P0) | Callback never binds the installation to the OAuth user; App-JWT check proves App ownership only | Decision 14 + PR 1: `GET /user/installations` with the user token must contain the presented `installation_id` (`installation_not_yours` failure); enforced in both dispatcher branches |
| R3-2 (P0) | Idempotent polling keeps a production key in plaintext, violating the AGENTS.md guardrail; expiry sweep never touches completed rows | Decision 15 + PR 1: AES-GCM ciphertext under a poll-token-derived key (server stores only the token hash — cannot decrypt alone); sweep extended to purge completed-session ciphertext; crash/restart + cleanup tests. Also retires the existing `api_key_plaintext` violation |
| R3-3 (P0) | Session-row lock cannot serialize cross-session same-repo races; `github_repo` not unique | Decision 16 + PR 1: `pg_advisory_xact_lock` on canonical repo identity + in-lock existence re-check; canonical = GitHub's `full_name` (case-insensitive, rename-canonicalized); numeric repo-ID uniqueness deferred with note |
| R3-4 (P1) | Recovery not origin-safe (global PKCE file) or agent-safe (interactive login, human stdout) | PR 2: PKCE tokens keyed by canonical origin; `--relink` origin/project/env selection defined; recovery documented as requiring a local interactive session, `login` exempted from the one-JSON contract |
| R3-5 (P1) | "Dark" content auto-exposed via starlight-llms-txt | PR 3: `draft: true` until activation, `/agent.md` endpoint gated, built-artifact test (navigation, Pagefind, llms files) |
| R3-6 (P1) | Import-presence idempotency too coarse; multiline anchors fragile | PR 2: per-aspect detection (import / init / plugin / env), multiline-call handling, edge fixtures incl. aliased imports, partial integrations, double application |
| R3-7 (P2) | Stale header vs D-A; empty-dir smoke can't detect a repo; unnamed poll-token header and file semantics | Header fixed; PR 7 gate uses a fresh clone with remote; contract pins `X-Opslane-Poll-Token`, 404-without-oracle on missing/invalid token, constant-time compare, canonical-origin algorithm, atomic temp-file+rename writes |

### Round 4 — PR 1 plan feedback (R4-1–R4-8)

| # | Finding | v5 disposition |
|---|---|---|
| R4-1 (P0) | Migration nulls+drops `api_key_plaintext` immediately — breaks old binaries, strands unclaimed keys | 016 is expand-only (columns + widened status CHECK); plaintext column kept, unwritten by the new binary, dropped by a follow-up 017 after deploy + drain |
| R4-2 (P0) | 15-min delivery window enforced only by the hourly sweep (~75-min exposure) | Poll handler checks `expires_at` before opening the sealed key; sweep demoted to backstop; expired-completed poll tested end-to-end |
| R4-3 (P0) | Transient email-API failure became definitive `identity_unverified` | `pickVerifiedEmail` returns an error; API failure → retry page, session pending; only a successful fetch with no verified address is definitive |
| R4-4 (P0) | Identity resolution not concurrency-safe — same new user, two repos → unique-violation rollback with a consumed code | Identity/email advisory locks extracted from `ProvisionFromIdentityTx` into shared helpers used by both paths; lock order repo→identity→email; concurrent same-identity test |
| R4-5 (P1) | Legacy `orgs.github_installation_id` mapping ignored — legacy installs could bind a second org, bypassing D-A | Provisioning consults rich table then legacy column, backfills the rich row; legacy-only test added |
| R4-6 (P1) | Pending-uniqueness index = unauthenticated repo-squatting DoS; case-sensitive; held until hourly sweep | Index dropped entirely; multiple pending sessions allowed; the provisioning advisory lock is the sole serializer; 409 `setup_in_progress` path removed |
| R4-7 (P1) | Poll error bodies used `writeJSONError`'s `{"error"}` shape, not the documented `{"status"}` contract | `agentJSON` helper; exact-body assertions for `not_found`, `expired`, `rate_limited`, `failed`; setup 429 included |
| R4-8 (P1) | `identity_required` vs transient-pending contradiction across design/plan | State machine settled: no `identity_required` state; missing/failed code = transient (pending + retry page); definitive vocabulary fixed at five reasons; design + quickstart table updated |

### Round 5 — PR 2 (CLI) plan feedback (R5-1–R5-8)

All plan-scoped (no design decision changed); dispositions live in the "Round-5 amendments" section of `2026-07-18-agent-onboarding-pr2-cli-plan.md`. Summary: `--force` never deletes credentials before a replacement is saved (R5-1); `completed`-without-key is a terminal `key_unavailable` state, not "re-run setup" (R5-2); legacy PKCE tokens are never reused across origins (R5-3); the one-JSON invariant holds by routing interim `auth_required` to stderr, and `already_configured` is exit 0 (R5-4); credential single-entry fallback only when repo detection fails and origin matches, all six consumers updated (R5-5); every wrong-key path fixed incl. `ai-fallback.ts` and `init.ts` plaintext persistence, Next layout must render the client component (R5-6); `--relink` cross-org returns a specific `project_not_in_active_org` (R5-7); the contract is made drift-proof via a machine-readable status enum + drift test (R5-8). Plus smaller corrections: export `applyPatches`, hermetic subprocess tests (temp HOME/cwd), unique-temp-file credential writes, poll-ID/timeout validation, added setup error-body tests.

## Launch blockers (outside this repo's code)

1. Hosted domains live: `api.opslane.com`, `docs.opslane.com`.
2. Hosted GitHub App configured per D-B outcome (plus slug/credentials/private key).
3. Development GitHub App (Phase 0).
4. Marketing-site card (opslane.com) — copy via `buildAgentPrompt`.
5. Production GitHub App: enable **Request user authorization (OAuth) during installation**, set the callback URL to `<AUTH_CALLBACK_ORIGIN>/auth/callback`, and grant Account permission **Email addresses: Read-only**.
6. Hosted deployments must set `AUTH_CALLBACK_ORIGIN`; the proxy must forward `X-Forwarded-Proto: https` so agent authorization URLs and callback cookies use the public HTTPS origin.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 25 findings (16 P1 / 9 P2), 25/25 dispositioned |
| Plan feedback (round 2) | external review | P0 feasibility + sequencing gaps | 1 | issues_found | 9 findings (4 P0 / 4 P1 / 1 P2), 9/9 dispositioned |
| Plan feedback (round 3) | external review | Security binding + at-rest key + serialization | 1 | issues_found | 7 findings (3 P0 / 3 P1 / 1 P2), 7/7 dispositioned |
| Plan feedback (round 4) | external review | PR 1 plan: deploy safety + concurrency + contract | 1 | issues_found | 8 findings (4 P0 / 4 P1), 8/8 dispositioned |

**CODEX:** Round 1 (high reasoning effort, 1.3M tokens) drove the v2 hardening; round 2 forced the Phase 0 spike, single-tx completion, split poll token, origin persistence, and activation gating; round 3 closed the remaining security gaps — user↔installation binding (the spike's own check, restored as an acceptance criterion), poll-token-derived encryption replacing plaintext keys at rest, advisory-lock repo serialization, origin-keyed PKCE recovery, draft-based dark launch, and per-aspect codemod idempotency.

**VERDICT:** RATIFIED (v5) — four review rounds fully dispositioned, D-A and D-B resolved, PR 1 implementation plan revised for deploy safety (expand/contract), poll-time expiry, transient-vs-definitive identity semantics, identity-lock concurrency, legacy installation mapping, no pending-uniqueness DoS, and machine-stable bodies. Ready for implementation.

NO UNRESOLVED DECISIONS
