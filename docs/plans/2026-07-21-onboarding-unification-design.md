# Onboarding — one mechanism, three entry points

**Status:** design complete, iteration 12
**Reviews:** Codex rounds 1–3. Round 3 returned REQUEST CHANGES with 13 P1s; all folded in.
Five of my own claims about current code were wrong and are corrected inline.
**Prior art:** `github.com/PostHog/wizard`, read in full including its dependency graph.
Learnings taken; scale deliberately not.

## Position

**An agent installs Opslane, and the agent is ours.** Our harness, our terminal UI, our step
order, our telemetry — running locally on the user's machine. The user's own coding agent
(Claude Code, Codex) is a **fallback** for people who prefer it, served the same spec.

*Reversal from iteration 5, stated plainly:* I made the user's own agent the default we
optimize for, on the grounds that it costs nothing and reasons well. That was wrong about
what onboarding is for. Onboarding is where the product gets explained, where pricing gets
introduced, and — with zero signups — where we learn what breaks. Running inside someone
else's agent gives up the surface, the step order, the voice, and **all funnel telemetry**.
We cannot fix a funnel we cannot see. The reasoning ability was never the differentiator: our
harness is an agent too.

Dashboard and CLI are **entry points**, not implementations.

**GitHub is required, and we say so at the start.** Opslane without repo access is an error
tracker, not Opslane. Identity still comes from login rather than from the install (D19) —
but that is a decoupling, not a reordering, and it is not a way to make GitHub optional.

**Zero signups.** That is the governing constraint of this iteration. Round 3's sharpest
finding was scope: signed remote specs, two-model routing, Python, a public skill, egress
sandboxing and server/local parity are several projects, not a phase. **This iteration cuts
all of them.** Prove one controlled local JavaScript path converts one real repository, then
expand.

**Focus stays production errors → verified fix PR.** Onboarding is the road there.

## Problems

**B1 — The callback assumes the identity provider is GitHub.** The non-agent branch calls
`d.provider().ExchangeCode(ctx, code)` (github_oauth.go:216) *before* install handling. That
`code` is a **GitHub** code; hosted runs WorkOS, which cannot exchange it. Agent onboarding
is dark (`draft: true`), so nobody is hitting it — but PR 7 activation requires flipping the
App's OAuth-during-install toggle, which routes every install into the broken branch.
**B1 gates the launch.**

**B2 — An install that misses its session is silent.** Observed 2026-07-21: approved, green
success page, CLI polled 15 minutes against a session that would never complete. GitHub used
the Setup URL (`GitHubSetupCallback`, github_oauth.go:504), which receives no `code`, no
state, and — see D4 — never verifies the human owns the installation.

**B3 — Recovery cannot recover.** `setup --relink` (setup.ts:267) mints a key for an
*existing* project and returns `project_not_in_active_org` when there is none (setup.ts:281).

**B4 — Onboarding cannot handle a real repository.** `conelike/asset-management-jira`
(Forge app): root `package.json` is a Forge backend and the frontends are **three Vite apps**
under `client/`; `manifest.yml:867` has an egress allowlist naming Sentry and PostHog but not
us, so a correct edit would still send nothing; `client/asset-panel/src/main.tsx:35` already
initializes `@defender-dev/sdk` (migration, not install); Sentry and LogRocket sit in the
same file; env vars are `VITE_APP_*`; deploys are CodeBuild/Forge with no preview URLs.

**B5 — Two mechanisms, already drifting.** Nuxt exists in the CLI codemods and not in the
server prompt; neither knows `packages/sdk-python` exists. `findMainFile` defaults to
`src/main.tsx` when nothing matches (react-vite.ts:22) and `applyPatches` **warns and
continues** on a missing pattern (init.ts:66) — success-shaped, nothing wired.

## Corrections from round 3

Five claims in earlier iterations were false. Recording them so the plan is not read as
describing today's system:

1. **The SDK is not silent on `init()`.** Replay is on by default (config.ts:50) and
   `registerSession` POSTs `/api/v1/sessions/init` (replay.ts:140). The real gap is narrower
   and cheaper: that call carries no SDK/release metadata and is not wired to onboarding
   completion. **The beacon is mostly built.**
2. **Setting `environment: 'development'` in SDK config does nothing.** Provisioning creates
   only a `production` environment (agent_provision.go:234); payload overrides default off
   and fall back to the key-bound environment (env_resolver.go:106).
3. **We cannot claim a matching Origin.** Project origin allowlists default to empty, which
   permits everything (ingest_limits.go:51), and onboarding never establishes an expected
   origin. Server SDKs have no Origin at all.
4. **Q3 was misdiagnosed.** `ProvisionAgentSession` honors an existing installation→org
   mapping *first* (agent_provision.go:141); the home org is only the fallback.
5. **Q5 was false.** `AuthenticateUserSession` already accepts the CLI's PKCE bearer token
   (auth.go:246). There is no auth gap — only a missing admin check.

## Decisions

**D1. One session record with explicit transitions.** Keep `agent_sessions`; add `source`,
`initiating_user_id`, `target_org_id`, `auth_expires_at`, `key_expires_at`,
`retention_expires_at`.

*Reversal from iteration 2:* I froze the status vocabulary and added a parallel `phase` field
to protect deployed clients. Real constraint in general, but there are zero users. **One
`status` field, new vocabulary, no compatibility layer.**

```
created ─────────────────► awaiting_authorization
awaiting_authorization ──► authorizing | authorization_denied | expired
authorizing ─────────────► provisioned | awaiting_authorization (transient) | failed(reason)
provisioned ─────────────► key_ok | key_unavailable
key_ok ──────────────────► app_reporting
key_unavailable ─────────► (terminal; recovery is adopt, D4)
```

- Compare-and-set on current status **inside the provisioning transaction**, matching the row
  locking `ProvisionAgentSession` already does (agent_provision.go:51).
- **Out-of-order events:** `app_reporting` may arrive before the CLI probe. It is accepted
  from `provisioned` as well as `key_ok`; the probe is an optimization, not a gate.
- `canceled` from `created`, `awaiting_authorization`, `provisioned`, `key_ok`. `failed`,
  `authorization_denied`, `expired`, `key_unavailable`, `app_reporting` are terminal.
- Transient GitHub errors return to `awaiting_authorization`. No client-asserted status.

**D2. Dispatch on state shape first; exchange the code with GitHub, not the IdP.**
Recognize the session from `state` **alone** before inspecting `installation_id`,
`setup_action`, or `error` — a denial can arrive with no `installation_id`, which is why
`authorization_denied` is currently unreachable (github_oauth.go:135). If install-shaped,
handle it **before** `provider().ExchangeCode`, via `gh.ExchangeOAuthCode`.

**Web state must be reservable** — `ConsumeOAuthLoginStateDetails` (queries.go:2585) is a
single-use irreversible update; consuming before the GitHub exchange makes a transient
failure permanently unretryable. Split into reserve (lease) → finalize / release.

**Web state must carry the actor** — it stores only `target_org_id` (queries.go:2564) and
`/auth/callback` is unauthenticated middleware-wise (routes.go:52). Add `initiating_user_id`;
authenticate the cookie, require the same user, revalidate admin.

**D3. One callback door, last.** Enable OAuth-during-install only after D2 passes under
WorkOS. The Setup URL handler is not convertible (no `code`, no state) — it becomes a
non-mutating landing page, deleted a release later. Once every install originates from a
session, the callback sees one state shape and `applyCombinedGitHubInstallation` stops being
a separate branch.

**D4. Detect divergence; re-authorize to recover.** *(Auto-attaching by repo was an API-key
theft vector.)* An unmatched install is recorded against the authenticated human's org,
written to an `installation_landed` audit table, and nothing else. Pending sessions read it
read-only for `diagnosis`.

**Recovery is the single authorize link (D22), and an audit row is not evidence.** The Setup
URL path never verified that the human owns the installation — `GitHubSetupCallback` checks
only that it belongs to our App (github_oauth.go:504). So adopt performs a **fresh GitHub
user authorization**: exchange a new code, call `ListUserInstallations`, confirm the
installation is theirs *and* currently grants the repo, and require org admin. An admin
session plus history is insufficient.

**Adopt ships with its callers, not alone** — a CLI command and a dashboard action, both in
P0. An endpoint nothing invokes is not recovery.

**D5. Narrate the run and the wait.** The agent emits its full task list before starting, and
the first step is a local check that completes immediately so there is a checkmark within
seconds. The session read returns `status`, `human_sentence`, `waiting_on`, `detail`,
`action_url`, `diagnosis`, `auth_expires_at`, `next_check_in_ms`. Clients clamp
`next_check_in_ms` to `[3000, 30000]` with +0–20% jitter; the floor comes from the 30/min
per-IP limiter (agent_setup.go:24).

**D6. Explicit output mode.** Agents run in PTYs, so `isTTY` cannot identify the caller.
Default stays JSON; `--human` opts into prose, `--json` forces it.

**D7. Browser auto-open, safely.** argv array, no shell; refuse any `action_url` that is not
`https` except localhost; always print the URL; `--no-browser` disables.

**D8. Durability scoped honestly.** The poll token lives only in
`~/.opslane/pending/<uuid>.json` and the key is sealed to it, so cross-machine resume is
impossible by design. Same machine: `--poll` with no argument. Different machine: sign in and
adopt. Ctrl-C prints the resume command.

**D9. Classify, present, confirm — never guess.** Detection produces a report, not a decision:

```
repoType: 'monorepo' | 'single'
projects: [{ path, framework, hasOpslane, action, confidence, evidence, reason? }]
```

- `path` is repo-relative and normalized; anything resolving outside the repo root, or
  through a symlink, is dropped.
- `action` is `install` | `migrate` | `skip` — **migration is orthogonal to
  instrumentability**; an existing Opslane install is a reason to migrate, not to skip.
- `confidence` and `evidence` are required, and `unknown` is a permitted framework value.
- The inventory is capped and reports whether it was truncated.
- One **batched** question. Non-interactive → abort with `requires-interactive`, never guess.

Detection is a single model pass in this iteration. Two-model cost routing is deferred.

**D10. Onboarding completes when the app reports, with an honest claim.**

- **`key_ok`** — a CLI-originated probe. Proves the key and endpoint. Never shown as complete.
- **`app_reporting`** — an event from the app runtime carrying SDK name, version, release,
  and environment.

**The claim is scoped to what the evidence supports, per D14:**

**One claim, for every runtime:** "a valid project key reported, with SDK identity, from a
runtime that is not our CLI." Never "verified."

*An earlier draft claimed a stronger, origin-attested version for local runs. Withdrawn — see
D14: origins are project-scoped and matched by exact string equality, so localhost attestation
is not available without a schema change.*

Threat model: this defends against *accidental* false success. It does not defend against a
user forging their own onboarding event; no incentive, no adversary.

**D11. Install, relink, adopt, and setup-PR require org admin**, revalidated at callback
time. Routes today require authentication but no role (routes.go:155). Per correction 5, the
CLI already authenticates via PKCE bearer — **the fix is adding admin middleware to
`setup-pr`, not inventing an API-key-authenticated repo-write route.** An API key carries
project and org but no user identity, so it can never satisfy an admin check.

**D12. Shared install persistence is a DB primitive** — `persistInstallation(tx, …)`, with
the D4 audit write inside it, because agent provisioning is one transaction
(agent_provision.go:41) while the web paths do a standalone org update.

**D13. A thin machine and an authored spec — bundled, not fetched.**

The machine (CLI + worker harness) owns order, mechanics, session state, questions, and
safety, and contains no framework knowledge. The spec owns *how* to wire each framework and
is authored once for both runtimes.

*Deferred from iteration 4, on review:* runtime-fetched specs are an executable supply-chain
surface, not "instructions, not code" — the executing agent has shell and arbitrary path
access, and TLS gives transport security, not artifact integrity. Doing it properly needs
signing, digests, a capability manifest, compatibility ranges, revocation, rollback and a
verified cache. **With zero users that is unjustifiable.** The spec ships inside the CLI and
worker releases. Runtime fetch returns when there are users to justify the signing
infrastructure, and it is its own design doc.

Scope of the spec in this iteration: **JavaScript/TypeScript only** — the four frameworks we
already support, plus multiple apps per repo, network permission as a first-class step
(Forge egress, CSP `connect-src`), migration from `@defender-dev`, co-existence with other
SDKs, local convention discovery, and give-up-with-a-reason. **Python and the publicly
distributed skill are deferred.**

**D14. Provisioning separates development traffic; the session-init call carries the
reporting evidence.**

*Corrections 2 and 3 share one root cause (noted in review): `ProvisionAgentSession` creates
the bare minimum — one project, one `production` environment, one key, no origins — so the
server has no recorded notion of where legitimate events come from. They are **not** the same
property, and must not be collapsed into one task:*

| | What it is | Value | Knowable at provisioning |
|---|---|---|---|
| **Environment** | Client-declared label (core.ts:93), honored only if `allow_payload_environment` | Separates noise. **No** authentication value | Yes |
| **Origin** | Browser-attested; page JS cannot forge it (ingest_limits.go:51) | Stops another site reusing a public key. Partial authentication value | **Only for development** |

Provisioning therefore creates **(environment, expected origins) pairs**:

- `development` → origins `localhost`, `127.0.0.1`. Both knowable now, for free.
- `production` → origins unknown until they deploy. Learn-then-confirm or ask, deferred.

**Withdrawn on implementation review.** I claimed this restored a browser-attested origin
check for local runs. It does not, for two reasons found while planning the work:

1. `allowed_origins` is **project-scoped** (queries.go:307), and API-key lookup returns the
   same project allowlist for every environment's key. Setting it to localhost would block
   production browser traffic for the same project.
2. Matching is **exact string equality** (ingest_limits.go:121), so `http://localhost` never
   matches a real Vite origin like `http://localhost:5173`.

Making it work needs per-environment origin scoping plus port/wildcard semantics — a schema
change and new middleware, neither justified at zero users. **The development environment
still ships** (it prevents local runs being recorded as production traffic, which is the part
that matters). The origin allowlist does not, and **D10's completion claim stays at the weaker
wording**: "a valid project key reported, with SDK identity, from a runtime that is not our
CLI." Revisit if origin verification becomes worth a schema change.

Per correction 1, `registerSession` already POSTs `/api/v1/sessions/init` (replay.ts:140).
The work is to carry SDK name, version, release, and environment on that call, persist them,
and drive the session transition — **not** to add a new beacon.

Per correction 2, provisioning creates only `production` (agent_provision.go:234) and payload
overrides fall back to the key-bound environment (env_resolver.go:106). So **provisioning
creates a `development` environment and key too**, and onboarding wires the development key
locally. Without this, every local run records as production traffic.

**Consent is separate from replay.** If the reporting signal inherited replay's opt-out, a
replay-disabled user could never finish onboarding. The shared session-init request carries SDK
identity plus its existing scrubbed page/user fields, so reporting has its own explicit opt-out.
Until P4 unifies setup and init, a user who declines honestly remains at `key_ok`; the unified
`onboard` command will add the stated terminal reason.

**D15. Preflight, and bail loudly.** Be willing to refuse: *"This is a Forge monorepo with
three frontends and existing instrumentation — automatic setup would guess wrong. Here's a
prompt for your agent."* A reasoned refusal is a better outcome than a confident wrong PR.

**D16. Delete the codemods — after `onboard` replaces them.** `init.ts:5` imports the codemod
registry directly today, so deleting them before the replacement lands removes the only local
wiring path. Order: land `onboard`, migrate `init` to it, run parity tests on the four
frameworks, *then* delete.

**D17. Familiar shape, honest promises.**

- `npx @opslane/cli@1 onboard` — **pinned to a major**, not `@latest`. `-y` plus a floating
  tag means downloading and running mutable code without confirmation.
- Add an `engines` constraint to `cli/package.json`; the repo requires Node 22.12 and the root
  constraint does not travel with the published package.
- State the duration up front and keep it true. The "under 5 minutes" promise is dropped —
  it does not survive a repo like `asset-management-jira`.
- Familiar vocabulary: project, key, environment, release, first event.

**D18. Secrets and hostile input — guarantee only what we control.**

*Round 3 was right that iteration 4 overclaimed.* We cannot make guarantees about a
user-owned agent's tools, context, or logs. So:

- **Inside the Opslane-controlled runner:** the key is never handed to the model. A
  host-owned `write_secret(path, variable, ref)` primitive writes it after resolving the ref;
  the model receives only the ref. The written path is denied to subsequent model reads, and
  the value is redacted from tool output, logs, traces, diffs, and errors. Refs are
  session-scoped, expire with the run, and are cleaned up on crash. Paths are contained to
  the repo root with symlinks refused.
- **In the user's own agent:** we state plainly that their harness handles the key, and we do
  not claim otherwise.
- **Read content is data, never instructions** — our pipeline reads production error
  payloads, which are attacker-influenceable, and `AGENTS.md` already names them a trust
  boundary.
- **Screening is not a boundary.** The worker already executes repository-controlled install
  and lifecycle scripts before agent work (harness/sandbox-repo.ts:153) with network-capable
  shell. The real controls are **egress restriction, path containment, and a command
  allowlist** — the current denylist is bypassable through any interpreter. Sizing and
  sequencing this is **its own plan**; the honest statement here is that it is a known,
  currently-open exposure, not something this document closes.

**D19. Separate identity from installation. GitHub stays required.**

*Correction to iteration 6, which overclaimed.* I argued that moving the GitHub step later
would shorten time-to-first-event, shrink B1's blast radius, and make the ask warmer. Checked
against the reference implementation: PostHog's step 3 is labelled **"Connect GitHub
(REQUIRED)"** and declining aborts the run (`[ABORT] github connection declined`), with auth
at step 1. Both are mandatory, in one sitting. Three of my four claimed benefits do not
survive:

- *Time to first event* — same sitting, minutes apart. Marginal.
- *B1's blast radius* — **unchanged.** If GitHub is required to finish, B1 still gates
  completion wherever it sits.
- *Warmer ask* — cosmetic.

And the counter-argument I failed to make against myself: when a step is mandatory,
discovering it is blocked is **better early than late**. Learning that an org owner must
approve the App is far kinder before we edit someone's code than after.

**What survives is the decoupling, which is structural rather than positional.** Today the
GitHub App install *is* the authentication — `POST /api/v1/agent/setup` is unauthenticated
and the session takes identity, repo grant, and org provisioning from one callback. Splitting
"who are you" (login) from "may we write to your repo" (installation) pays off at any
ordering:

- **Anonymous sessions disappear**, and with them the API-key theft vector, the load-bearing
  poll token, and adopt's fresh re-authorization dance. All three exist only because a session
  has no owner at birth.
- **The GitHub step becomes independently retryable.** Org approval pending? The session,
  project, and key survive; retry that one step tomorrow without redoing anything.

**Resulting shape — fail fast, install whenever:**

```
1. Log in                          browser #1 — WorkOS            → identity
2. Warn on likely friction         best-effort heuristic only     → not a gate (see below)
3. Detect and confirm                                             (D9)
4. Wire the SDK, key to .env.local                                (D18)
5. Install the GitHub App          browser #2, retryable alone    → fix-PR capability
6. Run the app → first event                                      → onboarding complete
```

**Step 2 is a heuristic, not a gate — corrected.** I claimed we could determine before
installing that an org requires owner approval. We cannot: WorkOS login yields no GitHub
token (auth/workos.go:137 returns an Identity with no access token), and the GitHub layer can
list installations only with a user token and repositories only with an installation token
(github/app.go:147). For a private repo in an org the user does not own, there is nothing to
query. So step 2 warns from what is cheaply knowable (the remote's owner is an org, not the
user) and is explicitly labelled a guess. **The only reliable fail-fast is to attempt the
installation before editing files** — which is the option to take if the heuristic proves
useless in practice.

**Completion requires both gates — corrected.** Iteration 7 said steps 5 and 6 could swap,
while `app_reporting` was terminal. That would let a run complete with no installation, which
contradicts "GitHub is required." The session carries two independent timestamps,
`github_authorized_at` and `app_reporting_at`; onboarding is complete only when **both** are
set. Either may arrive first. A run with one but not the other is named and resumable, never
a success.

**A new provisioning path is still required**: org → project → environment → key **from an
authenticated user with no installation**. The pieces exist (the dashboard does this with
separate endpoints; `projects.github_repo` is nullable per migration 006) but are not wired
for the CLI. `ProvisionAgentSession` keeps serving the install-first path until retired.

**D20. Extract a provider-neutral agent loop — not the `harness/` directory.**

*Corrected. My first check was too shallow:* I grepped `harness/` for database and job-queue
imports, found none, and concluded it was portable. It is not, and the coupling that matters
is elsewhere:

- `sandbox-runtime.ts:6` imports **`e2b`** and hardcodes `VIRTUAL_HOME = '/home/user'`.
- `tool-bridge.ts` depends on the worker's reason registry; `sandbox-repo.ts` on the worker's
  logger, repo-clone, and platform modules; `agent-loop.ts` on the worker's Anthropic client
  and tracing.
- **The onboarding steps are not in `harness/` at all** — they live in `setup-agent.ts:14`,
  and the prompt hardcodes the E2B path (`"checked out at /home/user/repo"`).

Moving the directory would therefore move none of the knowledge and inherit a sandbox
dependency the CLI cannot use. The real work is to extract a **provider-neutral loop and tool
protocol** with injected adapters: model client, tracing, filesystem, command execution,
path resolution, and reason vocabulary. The worker injects E2B; the CLI injects a local,
deliberately narrow implementation (D23). That is a refactor with a design, not a file move —
and it is the only version that actually prevents drift.

**The model adapter has two candidates, and the license boundary constrains the choice:**

| | `@anthropic-ai/claude-agent-sdk` | Vercel AI SDK (`ai`) |
|---|---|---|
| Level | Agent-shaped: file tools, `allowedTools`/`canUseTool`, hooks, sessions | Primitives: provider-neutral text/tool calling |
| Gives us D23's boundary | **Yes, as configuration** | No — we build it |
| Providers | Anthropic only | Many |
| npm license field | `SEE LICENSE IN README.md` | `Apache-2.0` |
| Passes `scripts/check-licenses.mjs` today | No — needs an allowlist entry | Yes |

**Decision (2026-07-21, licensing spike): use the Apache-2.0 Vercel AI SDK.** Anthropic's
Agent SDK is distributed under all-rights-reserved terms, binds use to approved Anthropic
commercial access, and includes a material competing-product restriction. Relicensing our
CLI does not grant redistribution or remove those field-of-use terms. P3 therefore includes
the cost of building and testing the shell-free executor boundary. See
`docs/decisions/anthropic-agent-sdk-terms.md`. The worker's existing
`@anthropic-ai/sdk` is MIT and unaffected.

**D21. Dead time teaches the product** — *sequenced behind a protocol, renderer decided by spike.*

This is not rendering work first. There is no task lifecycle, question event, answer channel,
or pause-resume in today's agent events (harness/types.ts:55). The protocol comes first, a
single-pane task list second, the teaching pane last and cuttable.

**The content is the differentiator, not the framework.** While tasks tick through, the other
pane explains what an incident is, what a verified fix PR means, and what it costs. Copy is
authored once and ships with the harness.

**Clone risk is a design problem, not a dependency problem.** PostHog's wizard uses a
two-pane Learn/Tasks layout. Matching their layout, pacing, and tone would read as a clone
regardless of which library renders it — and since they are moving into our space, resembling
them helps them. Our layout, vocabulary, and voice are deliberately ours. The renderer is
paper, not writing.

**S1 (completed 2026-07-21): choose Ink 7.1.1 with `@inkjs/ui` 2.0.0.** Both MIT, so both clear
`scripts/check-licenses.mjs`. Build the same throwaway screen in each — streaming task list,
one select prompt, a second pane — and measure:

| Criterion | Why it decides |
|---|---|
| `npx` cold-start time and download size on a clean machine | The promise is "one line, nothing installed." This is the whole product surface |
| Platform coverage: macOS arm64/x64, Linux glibc **and musl/Alpine**, Windows, CI containers | OpenTUI ships a native Zig core with per-platform prebuilt binaries (`@opentui/core-linux-x64`); Ink is pure JS. This is the main open question about it |
| **Non-TTY behavior with stdout piped** | D6 requires byte-clean JSON when piped. A renderer that writes escape codes into a pipe breaks the agent contract |
| Resize, narrow terminals, and dumb/CI terminals | Onboarding runs in whatever terminal the user has |
| Ergonomics of the layout we actually need | A task list and two text panes is a low bar; ease of iteration matters more than capability |

The measured spike chose Ink: it loaded on Node 22 across macOS arm64, Linux glibc, and Linux
musl; OpenTUI React required Bun and failed on musl. Both guarded pipe paths emitted byte-clean
JSON, but forcing OpenTUI rendering emitted ANSI. Ink was also materially smaller. Windows
remains an explicit verification gap. Full measurements are in `docs/decisions/tui-renderer.md`.

**D22. One authorize link, three cases — collapse relink, adopt, and install.**

Today the plan carries three separate concepts for what is one user intent ("connect this
repo to Opslane"): `setup --relink` (setup.ts:267, existing project only), the new
`onboarding/adopt` (an install that missed its session), and the ordinary install flow. That
tripling is most of B3's mess, and each path needs its own auth story, its own failure modes,
and its own docs.

The reference implementation uses **one deep link that covers fresh install, linking an
existing installation, and re-auth**, with no separate re-link path. Adopt the same shape:

**The link must carry a minted capability, not a session id — corrected.** CLI PKCE login
returns an authorization code to localhost and the CLI stores a bearer (login.ts:148); it
never sets browser cookies (github_oauth.go:281). So a printed
`authorize?session=<id>` URL carries no authenticated actor, and treating the session UUID as
authority recreates exactly the capability-theft problem D4 exists to prevent. Instead the
CLI makes an **authenticated POST** that mints a short-lived, hashed, single-use capability
bound to user, session, target org, and repo; the printed URL carries that capability.

Note also: login-first does **not** remove the need for fresh GitHub authorization. WorkOS
proves the Opslane actor; it proves nothing about control of a GitHub installation.

`GET /api/v1/onboarding/authorize?cap=<capability>` resolves the case server-side —

| Situation | What the single link does |
|---|---|
| No installation for this repo | GitHub App install flow |
| Installation exists, no Opslane project | Link it and provision |
| Installation exists, session missed it (B2) | Verify ownership, attach, continue |
| Key rotation | **Only** with an explicit `rotate_key` intent carrying project and environment identity in server-owned state. Never inferred from a repo match — server keys do not expire, and the CLI detects invalidity locally (setup.ts:363), so a bare repo-connect link cannot know which key to replace |

In every branch it performs the same verification: fresh GitHub user authorization,
`ListUserInstallations`, a current repo-grant check, and org admin (D11). One code path, one
audit trail, one thing to document.

**`setup --relink` is deleted, `adopt` never becomes a separate concept**, and D4's recovery
becomes "open the authorize link" — which the CLI can print and the dashboard can render as a
button.

**D23. Running locally needs a model path and an executor boundary. The boundary is built and
kept deliberately small.**

Two blockers on hosting the loop in the CLI. Iteration 8 treated both as custom work; the
reference implementation shows most of it is configuration.

**Executor boundary — buy it.** `sandbox-runtime.ts:34` documents the local backend as *"a
transport test double, not a security boundary,"* running `/bin/sh -c` on the host. Giving a
model arbitrary shell on a user's machine is unacceptable, and D18 deferred exactly that.

The resolution stands — **the local agent gets no shell**. The licensing spike rejected
`@anthropic-ai/claude-agent-sdk`, so the Vercel AI SDK supplies model/tool-calling primitives
and we implement the narrow capability layer ourselves.

Our local profile is: read, edit, search, and one
`add_dependency` whose package name is fixed to `@opslane/sdk`. No `Bash`. Anything outside
that set is a give-up with a reason, not an escape hatch. The executor must expose typed tools
directly; it must never translate model output into a general shell command.

**Model access — proxy it.** The loop needs a model credential. The worker has a server
secret; the CLI has none, and shipping one in a public npm package leaks it. **A hosted AI
gateway does not fix this**: a gateway key in a public package leaks exactly like a provider
key. Gateways buy spend caps, per-user attribution, failover, and observability — all behind
our own endpoint, never in front of it.

```
CLI ──(user's login bearer)──▶ Opslane API ──(our secret)──▶ gateway ──▶ model
```

`anthropic-client.ts:13` already honors `ANTHROPIC_BASE_URL`, so the CLI points at an
**authenticated, metered Opslane inference endpoint**. Per-user metering and abuse limits are
part of this work. A gateway behind that endpoint is an independent, optional improvement the
worker can adopt today.

## Open questions

- **Q1 — RESOLVED.** Hosted runs WorkOS; B1 gates the launch. P0 and P1 are independent of it.
- **Q2 — `SetupWizard` becomes an entry point.** Its install step changes; its setup-PR step
  becomes "run our agent."
- **Q3 — RESTATED (correction 4).** Existing installation→org mapping wins today
  (agent_provision.go:141); home org is the fallback. **Decision: keep that precedence** —
  an installation belongs to whoever first claimed it — and make web sessions pass an
  explicit `target_org_id` that must match the existing mapping or fail with a specific
  reason. No silent re-homing.
- **Q4 — RESOLVED (2026-07-21). One project per repo; `service` is a second dimension.**

  A project maps to a GitHub repo (`projects.github_repo`), fix PRs target a repo, and one
  team wants one inbox — so `conelike/asset-management-jira` is **one** project, not three.

  **Scope of "one per repo": onboarding-enforced, not a database constraint.**
  `ProvisionAgentSession` already does a global case-insensitive repo check
  (agent_provision.go:78); plain `CreateProject` (queries.go:138) permits duplicates and stays
  that way. Onboarding refuses to create a second project for a repo that already has one in
  the same org. No new DB constraint, because self-hosters and manual setups have legitimate
  reasons to shape projects differently. Since services (below) cover the multi-app case,
  **onboarding never needs to add projects per app** — an earlier draft implied it might,
  which contradicted this decision and is withdrawn.
  The three Vite panels are **services**: `asset-panel`, `asset-booking-panel`,
  `asset-portal-panel`, with the Forge backend a fourth later.

  "Service" is chosen over "app" or "component" because OpenTelemetry already defines
  `service.name` for exactly this, so an OTel ingest path maps over with no translation — and
  it reads correctly for a Python backend, which "app" does not.

  **Storage: an optional event field, like `environment` — not a new hierarchy level.** The
  wire contract is append-only and permits new optional fields, so nothing breaks and services
  need no pre-registration. The spec writes `service: '<name>'` into each app's `init()`. One
  project, one key per environment, services distinguished by what each bundle declares.

  **Grouping: encode `service` in the fingerprint. Do not touch the unique constraint.**
  *(Corrected on review — the constraint change would have broken friction.)*
  `error_groups` holds friction incidents as well as errors, and friction upserts through
  `UNIQUE(project_id, fingerprint)` as its conflict target (queries.go:553,
  worker/src/friction/promotion-db.ts:269). Migration 007 states the rule and the precedent
  outright: *"UNIQUE(project_id, fingerprint) stays… Friction incidents encode environment in
  the derived fingerprint `friction:<environment_id>:<signal_fingerprint>`."*

  So `service` becomes an input to `Fingerprint()` (grouping/fingerprint.go:27), exactly as
  environment already is for friction. Two services' errors get different fingerprints and
  therefore different groups — the requested behaviour — with **no schema migration, no
  constraint change, and no friction breakage**.

  **Cross-service linking is dropped, not deferred vaguely.** An earlier draft proposed
  joining groups that share a fingerprint across services. That cannot work: fingerprints
  include normalized frame coordinates (fingerprint.go:89), so the same source defect compiled
  into two separately built bundles will not produce the same fingerprint anyway. De-duplicating
  a shared-code bug needs a different similarity signal (error type + message + top frame
  symbol), which is its own piece of work.

  **The consequence is accepted explicitly:** a bug in code shared by three services produces
  three groups, and since every new group creates a job (queries.go:650), three investigations
  and potentially three PRs. That is the cost of the user-requested isolation. It is recorded
  here so it is a decision, not a surprise.

  **Field rules (must be specified before implementation):** `service` is normalized
  server-side — trimmed, lowercased, max 64 chars, `[a-z0-9._-]` only. Empty, null, missing,
  or invalid all collapse to the sentinel `default`. It is persisted on **both**
  `error_events` and `error_groups`. Unbounded client-controlled values would fragment groups
  and spawn jobs, so validation is a correctness requirement, not hygiene.

  **Wire contract: this is the sanctioned pattern, and it has a required step.**
  `docs/contracts/events.md` permits adding optional fields and records the exact precedent —
  "SDK 1.1.0 adds the optional top-level `environment` string," shipped with a **frozen
  fixture pair** (`-minimal.json` with the field omitted, `-full.json` with it present).
  Adding `service` therefore requires a new fixture pair under `test-fixtures/wire/events/`;
  existing fixtures are never edited. CI enforces this (`scripts/check-wire-fixtures.mjs`).

  Like `environment`, `service` is client-declared and unverified. It organizes; it never
  authorizes.

- **Q4 (original framing) — superseded.** Provisioning creates exactly one repo-level project,
  environment, and key (agent_provision.go:225). Adopt would bake that shape in before we
  decide whether N chosen apps become N projects. **Resolution: split authorization from
  provisioning.** Adopt authorizes the installation and creates the repo-level project as
  today; per-app cardinality is decided in P3 and can add projects later without redoing
  authorization.
- **Q5 — CLOSED (correction 5).** No auth gap; add admin middleware to `setup-pr`.
- **Q6 — DEFERRED.** Org-level AI data-processing consent.
- **Q8 — RESOLVED (2026-07-21). The MIT boundary is the SDKs only; the CLI becomes AGPL.**

  Today `cli/LICENSE`, `cli/package.json`, and `AGENTS.md` all put the CLI under MIT, and
  `scripts/check-licenses.mjs` enforces that on `@opslane/sdk` and `@opslane/cli`. Moving the
  CLI to AGPL-3.0-only closes the repository's internal package-boundary issue for the
  extracted agent loop. It does not override third-party terms; the Anthropic Agent SDK spike
  rejected that dependency independently.

  The reasoning holds because the two packages are consumed differently. **The SDK must stay
  MIT** — it ships inside the customer's application bundle, where AGPL would reach into their
  code. **The CLI is a tool people run**, not a library they link; AGPL restricts distribution
  and modification, not use.

  **Full inventory of places that state the CLI is MIT:** `cli/LICENSE`, `cli/package.json`,
  `AGENTS.md`'s licensing paragraph, `README.md:78`, and `docs-site/src/content/docs/index.mdx:41`.
  Plus removing `@opslane/cli` from `MIT_PACKAGES` in `scripts/check-licenses.mjs`.
  `scripts/check-packed-packages.mjs` is license-agnostic and needs no change. No workspace
  package depends on the CLI, and the CLI does not consume `@opslane/shared`.

  **The extracted agent loop must live in an explicitly AGPL package** — *not* in the MIT
  `shared/` package.

  **Relicensing removes our CI gate, not Anthropic's terms.** Dropping the CLI from
  `MIT_PACKAGES` mechanically ends the allowlist requirement, but says nothing about whether
  Anthropic's redistribution terms permit shipping the SDK as a dependency of a published
  package. Read them before the dependency is locked in (S2).

  **The one condition that reverses this:** if the CLI ever becomes a build-time or CI
  dependency — a source-map uploader, a release tagger — it lands in customers' lockfiles,
  where blanket "no AGPL" scanners will flag it. Interactive `npx` use leaves no such trace.
  Source-map upload currently lives in the SDK's Vite plugin, not the CLI; **keep it there.**
- **Q7 — RESOLVED (2026-07-21). The CLI creates accounts, and nothing needs building.**

  The PKCE login opens `/oauth/authorize`, which uses `provider=authkit` — WorkOS's *hosted*
  page, which offers sign-up and sign-in on the same screen (auth/workos.go:41). So "click the
  link, make an account, come back to the terminal" is the flow we already have. No in-CLI
  signup surface, and no abuse protection to build for one.

  **Signup is tenant-configurable, so it is a deployment prerequisite, not a code guarantee.**
  The repository proves only that we request `provider=authkit`; WorkOS lets a tenant disable
  self-serve signup. Hosted Opslane must have signup enabled, and a live acceptance test must
  create a genuinely new account through the CLI. Without that check this resolution is an
  assumption.

  **What is already handled, precisely:** `ProvisionFromIdentity` (db/queries.go:2068) creates
  the identity, home org, user, and `owner` membership atomically — **and only for
  verified-email identities**. It creates **no project, environment, or key**. So the correct
  claim is narrower than an earlier draft's: login-first needs **no new identity or home-org
  bootstrap**, but D19's authenticated org → project → environment → key path is still
  required and still new work.

  **Org naming (decided): use the full email.** Today it derives from GitHub username, then
  full name, then the email's local part — producing org names like `abhishek`, which read as
  a person rather than an organization and get confusing the moment a colleague joins. The
  full email is always present and unambiguous, and the name is renameable later. *Not yet
  implemented — a ~5-line change in `ProvisionFromIdentity`.*

  This applies only to the **self-provisioned login path**. `ProvisionAgentSession`
  (db/agent_provision.go:174) names an org from the GitHub org or login, which is correct
  there: installing on the `conelike` GitHub org should produce an org called `conelike`.

## Spikes — run before P3 is estimated

Both are small, both are blocking, and both change P3's cost depending on the answer.

| # | Question | Shape | Blocks |
|---|---|---|---|
| **S1 — complete** | **Ink 7.1.1 + `@inkjs/ui` 2.0.0** | Measured smaller and portable across the available Node 22 targets; Windows remains a P3 verification item. See `docs/decisions/tui-renderer.md` | — |
| **S2 — complete** | **Vercel AI SDK (`ai`)** | Anthropic Agent SDK terms are restrictive for this distribution/use case. See `docs/decisions/anthropic-agent-sdk-terms.md` | — |

## Phases

### P0 — Stop the silence; recover what is recoverable (8–12 days) — *independent of B1*

**Narrowed on review.** P0 cannot deliver all four D22 cases: with the App toggle off a new
install still lands at `GitHubSetupCallback` (github_oauth.go:504), which has no OAuth code
and no usable session state, and the WorkOS-safe dispatch that fixes it is P2 work. The
authenticated actor D22's capability needs arrives with login-first in P3. So P0 ships
**diagnosis plus recovery for installations that already exist**, and `setup --relink` stays
until its replacement actually works.

- New status vocabulary; `human_sentence`, `waiting_on`, `detail`, `diagnosis`,
  `auth_expires_at` (D1, D5).
- `installation_landed` audit table written by all three install paths; read-only diagnosis.
- **Recovery for existing installations** (D22, partial): fresh GitHub user authorization and
  a current repo-grant check, reachable from the CLI and the dashboard. The fresh-install and
  key-rotation cases wait for P2 and P3. `setup --relink` is **kept** until then.
- CLI clamps and jitters `next_check_in_ms`; prints the resume command on SIGINT.
- Verification: replay the 18:15 sequence with the toggle OFF; a stuck client is told within
  one poll, and a human completes setup through adopt without touching the database.

### P1 — Reporting signal and a development environment (4–6 days) — *independent*

- SDK metadata on the existing `/api/v1/sessions/init` call; persisted (D14).
- Provisioning creates a `development` environment and key, and onboarding wires that key
  locally (D14). No origin claim is made.
- Session reaches `app_reporting`, including out-of-order arrival (D1).
- Separate reporting consent from replay. Cross-command opt-out completion is deferred to
  P4's unified `onboard`; until then an opted-out run honestly remains at `key_ok`.
- Verification: a Vite fixture reaches `app_reporting` within 60s of `npm run dev`, recorded
  against `development`; reporting opt-out sends no session init and leaves the run at `key_ok`.

### P2 — Provider-agnostic callback (6–10 days) — *launch gate*

- State-shape dispatch (D2); `authorization_denied` reachable.
- Install branch ahead of `provider().ExchangeCode`; dedicated GitHub exchange.
- Reserve/finalize/release; `initiating_user_id` on the state row.
- Q3 precedence enforced; admin middleware (D11); `persistInstallation(tx, …)` (D12).
- Verification: under `AUTH_PROVIDER=workos`, a live dev App completes **both** a dashboard
  and an agent install; a regression test fails on today's code.
- **Only then**: flip the App toggle; Setup URL becomes a landing page (D3).

### P3 — Our harness, running locally (12–25 days) — *blocked on S1*

The licensing spike selected the Vercel AI SDK fallback, so this estimate must include the
typed shell-free executor boundary and its adversarial tests. Ink is fixed as the renderer.

Deliberately narrow: **JavaScript/TypeScript, our four frameworks, our harness.**

- Extract a provider-neutral loop with injected adapters; CLI supplies a shell-free local
  typed-tool adapter built on Vercel AI SDK primitives (D20, D23).
- Relicense the CLI to AGPL-3.0-only and drop it from `MIT_PACKAGES` (Q8).
- Authenticated metered inference proxy for the CLI (D23).
- **Agent event protocol first**: task lifecycle, question/answer channel, pause-resume, and
  non-interactive behavior. Today's events carry only messages, tool calls, turns, completion
  and errors (harness/types.ts:55) — the UI cannot exist before the protocol does.
- `--human` / `--json` land here, with the UI they activate — not split across phases.
- **Single-pane** task list first. The second pane (D21) is a follow-on, cut if the phase slips.
- Login-first ordering and the no-installation provisioning path (D19).
- Spec authored and bundled; server agent switches to it (D13).
- Detection report, batched ask, preflight refusal (D9, D15).
- `write_secret` and redaction inside our runner (D18).
- `onboard` lands and `init` migrates to it; parity tests; **then** codemods deleted (D16).
- `service` as an optional event field: server-side normalization and sentinel default,
  persisted on `error_events` and `error_groups`, and fed into `Fingerprint()` (Q4).
  **No constraint change** — friction upserts through `UNIQUE(project_id, fingerprint)`.
- New frozen wire fixture pair under `test-fixtures/wire/events/` (Q4).
- The spec writes `service` into each app's `init()`.
- Verification: a **committed reduced fixture** derived from `asset-management-jira` at a
  pinned commit, license-safe, with deterministic expected report, diff, and refusal
  assertions. The fixture does not exist yet and creating it is part of this phase.

### P4 — Entry points and second runtime (5–8 days)

- `npx @opslane/cli@1 onboard`, safe browser open, `--poll` with no argument.
- Second pane and product teaching copy (D21), if not already cut.
- Dashboard hands off the prompt and live-updates the shared session.
- Server-runtime parity against the same fixture.
- Internal fixture benchmarks for duration. **No published p50** — with zero users a
  percentile is theatre; report fixture timings and make D17's stated duration match.

### Deferred, with reasons

| Item | Why not now |
|---|---|
| Runtime-fetched spec | Needs signing, digests, revocation, rollback. Unjustifiable at zero users (D13) |
| Python spec coverage | Prove one language path converts a real repo first |
| Publicly distributed skill | Same spec, extra distribution surface; wait for demand |
| Two-model cost routing | Optimizing a cost we do not yet pay |
| Egress sandboxing and command allowlist | Real and currently open; needs its own plan, not a bullet (D18) |
| Origin expectations | Project-scoped exact matching cannot safely express localhost ports per environment; revisit only with explicit schema and wildcard semantics (D14) |

## Risks

| Risk | Mitigation |
|---|---|
| Toggle flipped before D2 lands takes hosted web installs down | Last step of P2, after both entry points pass under WorkOS; reversible in one setting |
| Agent onboarding activated before P2 | PR 7's flag flip has P2 as an explicit prerequisite |
| Codemods deleted before `onboard` exists, breaking `init` | D16 fixes the order and requires parity tests before deletion |
| Adopt becomes a new attachment hole | Fresh GitHub user authorization, current repo-grant check, org admin — not an audit row |
| Dev traffic recorded as production | P1 provisions a development environment; without it the beacon is actively harmful |
| Reporting signal blocked by replay opt-out | Separate consent; decliners terminate cleanly at `key_ok` |
| Worker executes repo-controlled scripts with network shell | Named as open in D18; own plan; do not let this document imply it is closed |
| P3 estimate optimistic | Scope cut to one language and one runtime; fixture creation counted in the phase |
| Zero-signup simplifications become debt | D1's status simplification and D13's bundled spec are both marked revisitable |
| Two browser trips read as more friction, not less | Trip one is a reflexive login. The feasibility check (D19 step 2) means a blocked org is discovered before any code is touched, which is where the friction actually hurt |
| GitHub presented as optional, users left with an error tracker | It is required and stated up front (D19). A run that cannot complete it ends in a named resumable outcome, never a claimed success |
| Building a terminal UI eats the schedule | The agent loop already exists (D20); only the render, task stream, and question bridge are new. Cut to a single-pane task list if it slips |
| Login-first path diverges from install-first path | `ProvisionAgentSession` keeps serving install-first until it is retired; both must reach the same project shape, asserted by one test |
