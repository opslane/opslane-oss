# 10/10 Onboarding — Design

**Status:** design (from a grill session, 2026-07-22)
**Origin:** the agent-in-a-TUI prototype (`prototype/onboard-tui`) validated the core feel;
running it live surfaced the real shape of "complete" onboarding. This doc defines what 10/10
is, decision by decision, grounded in verified codebase facts.
**Not in scope:** an implementation plan. This is the target; the build plan comes later.

## Position

Onboarding is 10/10 when the tool does the tedious prod-readiness work that Sentry made you do
by hand — per-environment keys, source-map upload, wiring it into your build — and does it on a
**real** repo, not a clean toy. The whole thesis is: **an agent reasons about your actual
repo where a codemod cannot.** If it only handles a single clean Vite app, a codemod would have
done, and there is no point.

## Scope

Traditional web/app stacks in real repos:
- **Browser:** React / Vue + Vite.
- **Backend:** Flask / Python.
- **Reality:** monorepos, multiple apps, an existing SDK to migrate, per-repo conventions
  (env-var prefix, `--mode` files, config location).

**The acceptance bar is the hard real repo** — `conelike/asset-management-jira`-class: three
Vite frontends under `client/`, `client/asset-panel` already carrying `@defender-dev/sdk`, a
`VITE_APP_*` prefix, committed `.env.staging`/`.env.production` per panel, SDK config in
`vite.config.ts`. Not a clean scaffold. (Forge/embedded runtime specifics are explicitly out —
the apps *inside* are ordinary Vue/Vite/Flask and run locally normally.)

## The shape: two phases, one warm ask between them

### Phase 1 — Local aha (no GitHub)

Our agent, local, in a TUI (the prototype's engine: Claude Agent SDK). One session.

1. **Survey** the repo: detect apps, frameworks, entry points, an existing SDK, and the repo's
   conventions (env prefix, `.env.[mode]` files, where SDK config lives).
2. **Ask** which app(s) to instrument — batched multi-select, agent-driven.
3. **Wire** the SDK **in the repo's own style**, not an imposed one. Migrate, don't duplicate,
   if an SDK already exists.
4. **Confirm the first event** by running the app (Vite dev / Flask dev). For anything that
   cannot easily produce a real event, fire one synthetic error through the wired SDK.

**Aha: your app reached Opslane.** This is the moment the prototype proved feels right.

### The boundary — a warm, required GitHub ask

> "It works. Connect GitHub so I can open the PR and fix your errors."

GitHub is **required** — fix PRs are the product, and they need repo write. But the ask lands
**after** the aha, when the user has already seen value. One browser trip. This reuses the P2
provider-agnostic callback (`docs/plans/2026-07-21-onboarding-p2-*`), which is built and
verified end-to-end under WorkOS.

### Phase 2 — Prod-ready (one PR, via the App)

5. **Ask what environments** the user runs (dev / staging / prod).
6. **Mint an Opslane key per environment** and show them.
7. **Open one setup PR** that commits, in the repo's convention:
   - per-mode env files (`.env.staging`, `.env.production`) with the (public) keys + endpoint;
   - the source-map upload plugin wired into `vite.config` (browser) / the build (Python);
   - `release = git SHA` wired into the repo's **specific** build/CI.
8. The App now also powers Opslane's **fix PRs**.

**Merge = production monitored, with readable stack traces.**

## Decisions and rationale

**D1. Two phases, aha before auth.** Local value first, GitHub second. A cold repo-write ask
before the user has seen anything is the high-friction order; the warm ask after the aha is
easy to say yes to. (Matches the earlier D19 conclusion.)

**D2. Our agent, local TUI, drives both phases.** Not the web dashboard's server agent — that
can't run the app to confirm the event, and loses the live local aha the prototype proved.
One agent, one session, start to finish.

**D3. The agent detects and extends the repo's convention; it never imposes one.** This is the
load-bearing "why an agent" decision, and `asset-management-jira` is the proof: it uses
`loadEnv(mode, '.', 'VITE_APP_')` (client/asset-panel/vite.config.ts:8), commits
`.env.staging`/`.env.production` per panel, and configures the SDK in `vite.config.ts`
(`apiKey: env.VITE_APP_DEFENDER_API_KEY`). A codemod writing `VITE_OPSLANE_API_KEY` into
`main.tsx` would be wrong on every count. The agent reads that setup and matches it.

**D4. Keys are public — this is the central simplifier.** The browser SDK key ships inside the
client bundle (`VITE_OPSLANE_API_KEY`, embedded at build), and source-map upload **reuses the
same key** (`packages/sdk/vite-plugin/index.ts:85` sends `X-API-Key: options.apiKey` to
`/api/v1/sourcemaps`, route `AuthenticateSDK`). So nothing in Opslane onboarding is secret.
Consequences:
- The agent may write keys anywhere, or **commit** them (the repo already commits its Defender
  key in `.env.production`).
- **No deploy-platform OAuth**, no secret store, no CI secret token. All of Phase 2 fits in one
  reviewable PR.
- The Sentry pain — scattering secret tokens across deploy platforms and CI — **does not exist
  here.** This is a genuine competitive simplification.

**D5. Per-environment config is committed `.env.[mode]` files + Vite `--mode`.** This is both
the repo's real convention and Vite best practice: `.env.[mode]` is loaded by `--mode`, only
`VITE_`-prefixed (or custom-prefix) vars reach client code, committed `.env.[mode]` holds
public config while `.env.[mode].local` (gitignored) holds true secrets. Opslane has no
secrets, so everything is a committed `.env.[mode]` entry.

**D6. The agent wires `release` into the repo's specific build.** The one value not known at PR
time is the build's git SHA (source maps must match the deployed bundle). The agent detects
the build/CI (package.json scripts, CodeBuild, GitHub Actions) and injects
`release = git SHA` into the build step, reasoning per-repo. **Belt-and-suspenders (floor):**
the SDK's Vite plugin should also auto-derive `release` from git at build time, so a repo the
agent can't fully parse still isn't broken. Today the plugin **warns and skips upload when
release is missing** (vite-plugin/index.ts:67) — correct, but a bad default for a zero-config
promise.

**D7. GitHub is required and used for the setup PR too.** Rejected the "open the PR with the
user's local git to avoid the App" option: the App is needed anyway for fix PRs, so dodging it
just means asking twice. One auth, the one the product fundamentally requires.

**D8. The bar is the hard repo.** 10/10 is not "a clean Vite app, beautifully." It is
`asset-management-jira` handled correctly: multiple frontends, an existing SDK migrated, the
`VITE_APP_*` convention matched, a Flask backend covered. Reasoning per-repo is the point.

## The key simplifier, stated once more

Because keys are public, **Phase 2 is one PR with no secrets.** Everything a real Sentry setup
scatters across a deploy platform and CI collapses into committed config the agent writes in
the repo's own style. This is the single biggest reason 10/10 is achievable here and was not
for Sentry.

## Prerequisites — real blockers this surfaced (must fix, separate from the flow)

These are not design choices; they are things that are broken today and gate 10/10:

1. **Publish `@opslane/sdk` with the identity field.** The server completes onboarding only
   when `/sessions/init` carries `sdk:{name,version}` (session.go:195). The **published**
   `@opslane/sdk@1.0.0` does not send it; the fix is in local source (v1.1.0,
   `packages/sdk/src/replay.ts:154`) and **unpublished**. Until it ships, a real user wires
   everything, runs their app, gets a 200 — and stays stuck at `key_ok` forever. Found live.
2. **Bump the SDK's `vite` peer range to include `^8`.** Current Vite users hit `ERESOLVE` on
   install (`@opslane/sdk` peers `vite ^6 || ^7`; smoke runs vite 8). Found live.
3. **Onboarding must cover the Python/Flask SDK.** `packages/sdk-python` exists; neither the
   current onboarding nor the prototype touches it. 10/10's scope includes Flask, so the agent
   must wire and confirm it, and `app_reporting` must fire for the Python SDK.
4. **The agent needs a constrained git capability** (branch / commit / push / open-PR). The
   prototype ran shell-free (`disallowedTools: ["Bash"]`); opening the setup PR needs git.
   Either a narrow git tool, or the App opens the PR server-side from the agent's diff.

## Open questions (not yet decided)

- **Q1 — Per-env key provisioning.** Server currently provisions `development` + `production`
  (agent_provision.go). A user declaring `staging` needs a third environment + key minted on
  demand. What mints them — the agent via an API, or the PR flow?
- **Q2 — Confidence in Phase 2.** The user sees the local event (Phase 1). How do they gain
  confidence source maps actually resolve in prod *before* a real prod error occurs? (A
  post-merge "first prod event resolved" confirmation? A preview-deploy check?)
- **Q3 — The one-public-key security tradeoff.** Source-map upload authorized by a public key
  means anyone reading the bundle could upload junk maps. Sentry split public-DSN from
  secret-upload-token to avoid this. Decision for now: keep it simple; revisit if abuse
  appears.
- **Q4 — Where the finish line sits.** This doc ends 10/10 at "production monitored." Whether
  the first real **fix PR** is part of onboarding or the product's first moment beyond it is
  unsettled.

## What this builds on

- Prototype engine + feel: `docs/plans/2026-07-22-onboarding-prototype.md`, branch
  `prototype/onboard-tui`.
- The reporting signal (`app_reporting`) and dev environment: shipped (P1).
- The provider-agnostic GitHub callback the warm ask depends on: shipped + verified (P2).
- `agent-core` remains a committed hedge, unused (the prototype uses the Claude Agent SDK
  directly).
