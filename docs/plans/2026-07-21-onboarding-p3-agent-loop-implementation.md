# P3 Foundation: Portable Agent Loop and Safe Local Executor

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the CLI its own agent loop — the same one the worker runs — with a model
adapter that is not the Anthropic Agent SDK (rejected on licensing) and a local tool executor
that has **no shell**. This is the dependency root of P3.

**Architecture:** Design: `docs/plans/2026-07-21-onboarding-unification-design.md` (iteration
12). The loop today lives in `packages/worker/src/harness/agent-loop.ts`, written directly
against `@anthropic-ai/sdk` primitives (`client.messages.create`, `toAnthropicTool`, two
`cache_control` markers). We introduce a **provider-neutral model port**, keep the worker on
Anthropic (behavior-locked by characterization tests), add a **Vercel AI SDK** port for the
CLI, extract the loop into a shared **AGPL** package, and build a **typed shell-free** tool set.

**Tech Stack:** TypeScript, Node 22, Vitest. CLI model layer: `ai` + `@ai-sdk/openai-compatible`
(Apache-2.0). Worker keeps `@anthropic-ai/sdk` (MIT).

**Reviews:** one Codex round folded in (11 P1s: line refs, ModelPort completeness, package
wiring, insufficient behavior-lock, Anthropic client/tracing preservation, Vercel provider
mechanics, symlink containment, add_dependency lifecycle scripts, secret redaction scope).

---

## Spikes — complete, do not re-run

| Spike | Verdict | Doc |
|---|---|---|
| S1 renderer | **Ink 7.1.1 + @inkjs/ui 2.0.0** | `docs/decisions/tui-renderer.md` |
| S2 model SDK | **Vercel AI SDK.** Anthropic Agent SDK is all-rights-reserved; Commercial Terms D.4 bars competing products and redistributing its binary | `docs/decisions/anthropic-agent-sdk-terms.md` |

---

## Scope

**In:** (1) CLI relicensed AGPL; (2) provider-neutral `ModelPort` + extracted `toolLoop` in a
new AGPL package `@opslane/agent-core`, worker refactored onto it **behavior-locked**; (3)
Anthropic and Vercel ports; (4) shell-free typed local tools (`read`/`write`/`edit`/`search`/
`add_dependency`) + `write_secret` + redaction.

**Deferred** (cannot be TDD'd until the loop exists as real symbols): P3b protocol+TUI, P3c
spec+detection, P3d `onboard`+metered proxy+login-first, P3e `service` field. The metered
inference proxy is P3d — this plan exercises the CLI loop with a **fake `ModelPort`**, so it
needs no live model credential.

---

## Conventions

- Vitest, colocated `__tests__`. Commit after every task.
- `@opslane/agent-core` is **AGPL-3.0-only**, published (not `private`), with a real
  `src/index.ts` and `exports`/`main`/`types`. It is **not** `@opslane/shared` (MIT).
- **Pin exact versions** — `ai` and `@ai-sdk/openai-compatible` are new to the repo; capture
  the resolved versions in `package.json` without ranges (the S1/S2 docs set this precedent).
- Verify per task; full gate at the bottom.

---

## Phase A — Relicense the CLI (Q8)

### Task A1: Move the CLI to AGPL-3.0-only

**Files:** `cli/LICENSE`, `cli/package.json`, the **complete** set of MIT-CLI claims — `AGENTS.md:17` and `:44`, `README.md:82-83` and the
prose at `:85`, `docs-site/src/content/docs/index.mdx:41`, `scripts/check-licenses.mjs:5`
(comment), and `llms.txt:3` — plus `scripts/check-licenses.mjs` and a **new** inventory assertion.

**Step 1:** `scripts/check-licenses.mjs` checks *dependencies*, not each package's own
license, so it cannot prove the CLI manifest changed. Add an explicit inventory check —
extend the script (or add `scripts/check-package-licenses.mjs`) that asserts
`cli/package.json` declares `AGPL-3.0-only` and that `MIT_PACKAGES` no longer lists
`@opslane/cli`. Write it as a failing assertion first.

**Step 2:** Run it → FAIL (CLI still MIT).

**Step 3:** Copy the AGPL text from the **root** `LICENSE` into `cli/LICENSE`. Set
`"license": "AGPL-3.0-only"` in `cli/package.json`. In `README.md` move `CLI ([`cli`]…)` from
the MIT row (line 83) into the AGPL row (line 82). Fix **every** claim listed above:
`AGENTS.md:17` + `:44`, `README.md:85` prose, `docs-site/.../index.mdx:41`,
`scripts/check-licenses.mjs:5` comment, `llms.txt:3`. Remove `@opslane/cli` from `MIT_PACKAGES`.

**Step 4:** Inventory check → PASS; `node scripts/check-licenses.mjs` → PASS; `pnpm -r build`.

**Step 5: Commit** — `chore(cli): relicense to AGPL-3.0-only`

---

## Phase B — Provider-neutral model port and loop extraction

### Task B1: `ModelPort` and complete neutral message types

**Files:** new `packages/agent-core/` (`package.json` with `"license":"AGPL-3.0-only"`, **not**
`private`; `src/index.ts`; `tsconfig.json`; `vitest.config.ts`);
`packages/agent-core/src/model-port.ts`; test alongside.

**Step 1:** Failing test pins the **full** contract — enough to represent a real multi-turn
tool conversation, not just first-turn text:

```ts
it('ModelPort round-trips tool calls and tool results across turns', async () => {
  const port: ModelPort = {
    async generate(req) {
      // messages carry structured parts, incl. prior assistant tool_use and user tool_result
      expect(req.model).toBe('m');
      expect(req.signal).toBeInstanceOf(AbortSignal);
      return {
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: 'tool_use',
      };
    },
  };
  const out = await port.generate({
    model: 'm',
    system: [{ text: 's', cache: true }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', output: 'done', isError: false }] },
    ],
    tools: [{ name: 'read', description: 'r', schema: {} }],
    signal: new AbortController().signal,
  });
  expect(out.content[0]).toMatchObject({ type: 'tool_use', name: 'read' });
});
```

**Step 2:** Run → FAIL.

**Step 3:** Define the types. **Required by review:** structured `content` parts (`text`,
`tool_use`, `tool_result` with `isError`); `system` as cacheable blocks; per-request `model`
and `signal`; usage with **all four** counters (`inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`); `stopReason`.

**Step 4:** Run → PASS. **Step 5: Commit** — `feat(agent-core): provider-neutral model port`

### Task B2: Anthropic port — construct the client in the worker, inject it

**Files:** `packages/agent-core/src/model-anthropic.ts`; add `@anthropic-ai/sdk` to
`packages/agent-core/package.json`; run `pnpm install` and **commit `pnpm-lock.yaml`**; test alongside.

> **Do not re-create the client inside agent-core.** The worker's `anthropic-client.ts`
> preserves `ANTHROPIC_BASE_URL` (line 10) and tracing instruments Anthropic *before*
> construction. The port takes an **already-constructed `Anthropic` client** as a constructor
> argument; the worker keeps building it via `createAnthropicClient`.

**Step 1:** Failing tests, using a stubbed client, assert:
- neutral request → Anthropic params: tools mapped via the lifted `toAnthropicTool`; **system
  block carries `cache_control:{type:'ephemeral'}`** *and* the **last user message block**
  carries the per-turn ephemeral marker (both behaviors exist in `agent-loop.ts` today);
- `tool_use` response → neutral `tool_use` content; a subsequent turn's neutral `tool_result`
  → Anthropic `tool_result` block;
- usage maps all four counters including `cache_read`/`cache_creation`;
- `signal` is forwarded to `messages.create`.

**Step 2:** Run → FAIL.

**Step 3:** Implement `createAnthropicModelPort(client, opts)` by lifting the mappings
**verbatim** from `agent-loop.ts`. Copy, do not improve.

**Step 4:** Run → PASS. **Step 5: Commit** — `feat(agent-core): anthropic model port`

### Task B3a: Characterization tests on the worker loop (before extraction)

**Files:** `packages/worker/src/__tests__/agent-loop-characterization.test.ts`

> Same-test-count is **not** proof of identical behavior. Lock the behaviors the extraction
> could silently change, against the current code, first.

**Step 1:** Write tests (green against current `agent-loop.ts`) asserting: request
serialization for a two-turn tool exchange; both cache markers present; `AbortSignal`
forwarded and cancellation emits the `CANCELLED` error event; event ordering
(`turn_start` → tool events → completion); API-error classification; tracing spans emitted per
tool; tool-result round-trip into the next turn; **cached-token pricing** (cacheRead/cacheWrite
priced distinctly via `MODEL_PRICING`).

**Step 2:** Run → all PASS on current code (they characterize, they don't drive new behavior).

**Step 3:** (none — characterization only.)

**Step 4:** Confirm green. **Step 5: Commit** — `test(worker): characterize the agent loop`

### Task B3b: Extract `toolLoop`; worker runs through it unchanged

**Files:** `packages/agent-core/src/tool-loop.ts`; modify
`packages/worker/src/harness/agent-loop.ts` to a thin wrapper; add `@opslane/agent-core` to
`packages/worker/package.json` (`workspace:*`); run `pnpm install`, **commit `pnpm-lock.yaml`**, and **`pnpm --filter @opslane/agent-core build` first** (worker imports its built `dist`).

**Step 1:** (tests already exist — B3a + `agent-loop.test.ts`.)

**Step 2:** Extract the loop body into `toolLoop(port, { tools, state, tracer, signal, ... })`.
`tracing`, `AgentState`, **and the pricing table/budget calculator** are **injected
collaborators** — the worker passes its real `MODEL_PRICING`; agent-core stays
provider-neutral and never hardcodes Anthropic pricing. Add a test that `toolLoop` reports the
injected pricing, not a built-in.

**Step 3:** Rewrite `runAgentLoop` to build the Anthropic client (worker side, preserving base
URL + tracing), wrap it with `createAnthropicModelPort`, and `return toolLoop(...)`. Keep
`runAgentLoop`'s signature and `AgentLoopConfig` unchanged so `setup-agent.ts`, `agent-fix.ts`,
and their tests are untouched.

**Step 4:** `pnpm --filter @opslane/worker test` → **B3a + all prior tests pass, unchanged.**
That equality is the acceptance criterion.

**Step 5: Commit** — `refactor(worker): run the harness loop through agent-core`

### Task B4: Vercel AI SDK port

**Files:** `packages/agent-core/src/model-vercel.ts`; add pinned `ai` (7.x) and
`@ai-sdk/openai-compatible`; run `pnpm install` and **commit `pnpm-lock.yaml`**; test alongside.

> **Mechanics fixed per review.** Core `ai`'s `generateText` needs a `LanguageModel`, not a
> `baseURL`. The CLI will point at an **OpenAI-compatible** metered proxy (P3d), so the port
> uses `@ai-sdk/openai-compatible` and accepts an **injected `LanguageModel`** (constructed
> from `{ baseURL, fetch, modelId }`) so tests can pass a mock and P3d can pass the proxy.

**Step 1:** Failing test using the AI SDK's test double for the installed 7.x line
(**check the resolved version and use its documented mock — current docs use
`MockLanguageModelV3`, not V1**). Assert: neutral request → `generateText({ model: resolve(req.model), abortSignal: req.signal, tools,
messages })`; that `req.model` is passed to `resolve`; returned tool-calls come back as neutral `tool_use`; usage maps to all four
counters (map cache fields to 0 when the provider omits them).

**Step 2:** Run → FAIL.

**Step 3:** Implement `createVercelModelPort({ resolve })` mapping neutral ↔ Vercel: call `resolve(req.model)`,
pass `abortSignal: req.signal`. Test that `req.model` reaches `resolve` and the signal reaches
`generateText`. No provider key is read here. Proxy protocol: OpenAI-compatible.

**Step 4:** Run → PASS; `node scripts/check-licenses.mjs` → PASS.

**Step 5: Commit** — `feat(agent-core): vercel ai sdk model port`

---

## Phase C — Shell-free local tool set

### Task C1: Correct path containment

**Files:** `packages/agent-core/src/local-tools/paths.ts`; test alongside.

**Step 1:** Failing tests: path inside root resolves; `../` escape rejected; **an existing
final-component symlink pointing outside the root is rejected** (the flaw the review caught —
realpathing only the parent misses this); a nested symlink inside a subdir that escapes is
rejected; a *new* file whose real parent is inside root is allowed.

**Step 2:** Run → FAIL.

**Step 3:** Implement `containedPath(root, candidate)`: for an existing target, compare
`realpath(target)` against `realpath(root)`; for a new target, `realpath` the parent and
require it inside root. Reject symlinked components at any depth.

**Step 4:** Run → PASS. **Step 5: Commit** — `feat(agent-core): repo-root path containment`

### Task C2: read / write / edit / search, with limits

**Files:** `packages/agent-core/src/local-tools/index.ts`; tests alongside.

**Step 1:** Failing tests: `read` returns contents, **caps output at 12,000 chars** (match the
worker's `MAX_OUTPUT_CHARS`) and refuses binary files; `write` writes atomically with
restrictive perms (0600) and no-follow; `edit` replaces an exact string and **fails loudly
when the anchor is absent** (the B5 silent-success bug); `search` returns matches, honors
traversal exclusions (node_modules/.git), caps file count and match output, and rejects a
ReDoS-prone pattern. All route through `containedPath`.

**Step 2:** Run → FAIL.

**Step 3:** Implement as neutral `ToolSpec`s with **host-side runtime validation** of inputs
(types alone are not validation), the caps above, and traversal exclusions lifted from the
worker's `traversal-exclusions.ts` if reusable.

**Step 4:** Run → PASS. **Step 5: Commit** — `feat(agent-core): shell-free file tools`

### Task C3: `add_dependency`, constrained and script-safe

**Files:** `packages/agent-core/src/local-tools/add-dependency.ts`; test alongside.

**Step 1:** Failing tests: `add_dependency('@opslane/sdk')` runs the package manager via
`execFile` (argv array, no shell) **with `--ignore-scripts`**, a bounded timeout, capped
output, `cwd` contained to the repo root, and a sanitized environment; any other package name
is **rejected before executing**; the manager is chosen from the root `packageManager` field
first, then the lockfile.

**Step 2:** Run → FAIL.

**Step 3:** Implement. The allowed name is a hardcoded constant; model input is never
interpolated into the command. Document the registry policy: `--ignore-scripts` plus a fixed
registry argument so a repo `.npmrc` cannot redirect `@opslane/sdk`.

**Step 4:** Run → PASS. **Step 5: Commit** — `feat(agent-core): constrained add_dependency tool`

### Task C4: secret vault, and redaction across every output channel

**Files:** `packages/agent-core/src/local-tools/secrets.ts`; modify `tool-loop.ts` (redaction
hook) and the read/search tools (deny secret paths); tests alongside.

**Step 1:** Failing tests:
- `write_secret(ref, path, varName)` upserts an env var into an env file with correct
  escaping, an **atomic no-follow write**, and 0600 perms; the raw value is **never** in the
  tool's return payload (model gets only the ref).
- a `redact(text)` pass replaces known secret values, and redaction is applied **before events,
  tracing, middleware, logs, and model history** — not only before model re-entry.
- `read` and `search` **refuse** a path registered as a secret sink.

**Step 2:** Run → FAIL.

**Step 3:** Implement a session-scoped host-only vault (`ref → value`, expires with the run),
the `write_secret` tool, a `redact` function, and a single redaction chokepoint in `toolLoop`
that every emitted string passes through.

**Step 4:** Run → PASS. **Step 5: Commit** — `feat(agent-core): secret vault and redaction`

### Task C5: `createLocalToolset` composition + acceptance test

**Files:** `packages/agent-core/src/local-tools/toolset.ts` (new production function);
`packages/agent-core/src/__tests__/local-loop.test.ts`

> Fixed per review: a test that only composes already-built symbols passes immediately and is
> not fail-first. C5 introduces a real `createLocalToolset(root, vault)` that assembles the
> tools + redaction chokepoint into the shape `toolLoop` consumes — the red test drives *that*.

**Step 1:** Failing test that calls `createLocalToolset(...)` (does not exist yet) and runs a
scripted fake `ModelPort` through `toolLoop` with it: `read package.json` →
`write src/opslane.ts` → `add_dependency @opslane/sdk` → complete, against a temp project;
assert the file was written and the (mocked, `--ignore-scripts`) install ran with
`@opslane/sdk`. A second script attempts `add_dependency('evil')` and a path escape; assert
both are rejected without side effects, and that a seeded secret value never appears in any
emitted event.

**Step 2:** Run → FAIL.

**Step 3:** Implement `createLocalToolset` to assemble C2–C4 into a single toolset + the
redaction chokepoint; the test drives it. No real model, no network.

**Step 4:** Run → PASS. **Step 5: Commit** —
`test(agent-core): local loop wires the shell-free tools end to end`

---

## Before merge

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
node scripts/check-licenses.mjs
(cd packages/ingestion && go build ./... && go test ./...)
```

**Acceptance criteria specific to this plan:**
1. `pnpm --filter @opslane/worker test` passes with the B3a characterization tests green and
   the pre-existing suite unchanged — extraction is invisible to the worker.
2. `node scripts/check-licenses.mjs` and the new package-license inventory check pass — MIT
   boundary is exactly `@opslane/sdk`, `@opslane/sdk-python`, `@opslane/shared`.
3. No `bash`/shell tool exists in the CLI-facing tool set; `add_dependency` runs
   `--ignore-scripts`; every emitted string passes the redaction chokepoint.

---

## What this unblocks

The loop becomes portable AGPL code with a swappable model and a safe local tool set. P3b
(protocol+TUI), P3c (spec+detection), P3d (onboard+proxy+login-first), and P3e (service field)
can then be written against real symbols.
