# Agent Onboarding PR 3 — Agent Quickstart Content (Lands Dark) Implementation Plan

> **Execution:** task-by-task, a commit per task (Claude: `superpowers:executing-plans`; other executors follow the same flow).

> **Status:** FINAL — two Codex review rounds (round 1: 2 P0, 9 P1, 4 P2; round 2 confirmed all addressed, no new P0/P1, one carry-over → Task 1b).

**Goal:** Ship `docs/quickstart/agent.md` (the agent-facing onboarding doc) and a raw `/agent.md` endpoint on the docs site, both fully dark — excluded from navigation, search, llms outputs, and the built site — until PR 7 flips `draft: true` off.

**Architecture:** The doc is canonical content in `docs/quickstart/` (already inside the loader allowlist and the prose docs-policy tier). Dark launch rides Starlight's native `draft: true`: production builds exclude draft pages from HTML/sidebar/Pagefind, and the installed `starlight-llms-txt` filters `!doc.data.draft` — all verified against installed versions (Starlight 0.41.3, starlight-llms-txt 0.11.0, Astro 7.1.0). One shared fail-closed frontmatter parser feeds both the raw endpoint and a built-artifact gate, so a single flag governs every surface and the gate self-inverts when PR 7 flips it.

**Tech Stack:** Markdown + Starlight frontmatter, one shared parser module (`docs-site/scripts/frontmatter.mjs`), one Astro static endpoint (`docs-site/src/pages/agent.md.ts`), one build-gate script (node, dependency-free like `check-built-links.mjs`), vitest.

**Context you need (verified against the repo and installed packages, 2026-07-20):**

- **Content pipeline:** docs-site loads canonical docs from `../docs` via `repoDocsLoader()` (`docs-site/src/loaders/repo-docs.ts`). `docs/quickstart/**/*.md` is already allowlisted (`PUBLIC_DOCS_DIRECTORIES`), slug derives from the path → **`quickstart/agent`**. The enricher **requires exactly one H1** (`extractTitle` throws) and derives `title` from it — no `title:` frontmatter (match `docs/quickstart/self-host.md`, which carries only `covers:`).
- **Dark-launch mechanics (installed-version verified):** Starlight 0.41.3 excludes `draft: true` pages from production routes/sidebar/Pagefind (Pagefind indexes built HTML — no page, no entry). `starlight-llms-txt` 0.11.0 filters drafts (`generator.ts:30`). Astro 7.1.0 **omits the output file for a null-body 404 from a static endpoint** (`astro/dist/core/build/generate.js:244`) — and **rethrows endpoint errors**, so throwing while dark is NOT a fallback; the null-body 404 is the mechanism, full stop.
- **Path arithmetic (Codex P0):** from `docs-site/src/agent-md.ts` the canonical doc is `../../docs/quickstart/agent.md` (src is one level under docs-site root). The loader uses `../../../docs/` only because it sits a level deeper (`src/loaders/`). Get this wrong and the endpoint 404s forever while tests read the wrong tree.
- **No sidebar change in this PR** (PR 7 adds the entry — a sidebar slug pointing at a draft page breaks the build). No root `llms.txt` change, no `docs/install.md` pointer, no landing CTA (all PR 7, F20).
- **Gates that fire on this PR:**
  - `scripts/check-docs-drift.mjs`: prose-tier docs (`docs/quickstart/**` per `docs-map.mjs`) must declare non-empty `covers:`. The deterministic CLI status check (§6) compares ONLY `docs/reference/cli-agent-contract.md` to `cli/src/contract.ts AGENT_STATUSES` — the quickstart's prose is not parsed, so its accuracy is guarded by Task 4's tests instead.
  - docs-site build = `astro build && node scripts/check-built-links.mjs` (+ the new dark-launch gate).
  - docs-site vitest (`src/__tests__/`, house style in `repo-docs.test.ts`). There is no vitest config or TS boundary preventing a source import of `cli/src/contract.ts` from a docs-site test — use the real import, never a copied list (a copy is a stale duplicate, worse than nothing).
- **Link policy (F21):** every link in `agent.md` is absolute `https://…` (the raw `/agent.md` is consumed outside the site). Our own docs links: `https://docs.opslane.com/quickstart/self-host/`, `https://docs.opslane.com/guides/replay-privacy/`, `https://docs.opslane.com/guides/github-app/`, `https://docs.opslane.com/reference/cli-agent-contract/`. `docs.opslane.com` activation is pending — dead-while-dark absolute links are acceptable; PR 7 gate 4 requires the domain live.
- **CLI/server truth to encode (source-verified; the doc below already reflects it):**
  - `setup`, `snippet`, `verify`, `status` emit exactly one JSON document on stdout (F22); `login` is interactive-human. Full table: `cli/src/contract.ts AGENT_STATUSES` (24 variants).
  - `POST /api/v1/agent/setup` takes `repo_url` in **`owner/repo` format** — a full GitHub URL is a 400 (`agent_setup.go:68`). The CLI normalizes URLs itself; raw-HTTP callers must send `owner/repo`.
  - If the repo already has a project, `setup` (server) returns `already_configured` with the recovery message "run `opslane login` then `opslane setup --relink`" (`agent_setup.go:82-88`). The CLI also returns `already_configured` locally when valid credentials exist. The doc's table distinguishes both cases — "run verify" alone is wrong for the server case (there may be no local credential; `verify` would say `no_credentials`).
  - `key_unavailable` is synthesized by the CLI from a **completed** poll whose delivery window closed (`setup.ts:168-175`); remediation is `opslane login` + `setup --relink` (a fresh `setup --start` on that repo now returns `already_configured`).
  - `rate_limited` surfaces from `setup --start`; poll-time 429s are retried internally by the CLI. The failure table must not present everything as "poll results".
  - `repo_not_granted` (and every other `failed` state) is **terminal for the session** — `/agent/auth/{id}` rejects non-pending sessions (`agent_setup.go:262`); remediation is fixing repo access then a **new** `setup --start`, never "reopen the same link".
  - `snippet` output includes an **`install`** command (package-manager-specific, `snippet.ts:98`) alongside `patches` (`file_path`, `action`, `insert_after`/`insert_content`) and `env` `{var, value, file, gitignore}` — the doc must say run the install too, or agents import an uninstalled `@opslane/sdk`.
  - Transient callback problems (expired `code`, GitHub hiccup — e.g. PR 6's missing-email-permission retry) leave the session `pending`; the human reopens the auth link, the agent keeps polling (R4-8). Only these reopen-the-link; `failed` states never do.
  - Replay is **on by default**; the quickstart instructs the agent to surface the opt-out + privacy guide (decision 8 / F16).
  - Self-hosting caveat: the default Compose stack has **no GitHub App credentials** (`docker-compose.yml:65-72` all default empty), and the callback refuses to provision without them — the doc's self-host note must point at the GitHub App guide, not pretend `--api-url` alone suffices.
- **CI note:** the docs-sync bot pushes `docs: sync` commits to PR branches, cancelling in-flight CI — judge CI on the newest head only.

---

## Task 1: `docs/quickstart/agent.md` (draft, covers, absolute links)

**Files:** Create `docs/quickstart/agent.md`.

**Step 1: Write the doc.** Full content:

````markdown
---
draft: true
covers:
  - cli/src/index.ts
  - cli/src/setup.ts
  - cli/src/snippet.ts
  - cli/src/verify.ts
  - cli/src/status.ts
  - cli/src/contract.ts
  - cli/src/agent-credentials.ts
  - cli/src/pending.ts
  - packages/ingestion/handler/agent_setup.go
  - packages/ingestion/handler/routes.go
  - packages/sdk/src/config.ts
---
# Agent quickstart

This page is for **coding agents** (and the humans supervising them) setting up Opslane in a repository. Every command below — `setup`, `snippet`, `verify`, `status` — prints exactly one JSON document on stdout; diagnostics go to stderr. `opslane login` is an interactive human command and is not part of this flow. The full status and exit-code table is the [CLI agent contract](https://docs.opslane.com/reference/cli-agent-contract/).

One human interaction is required and cannot be skipped: a person must authorize the GitHub App. Everything else is yours.

## 1. Start a setup session

Run from the repository root (a git `origin` remote pointing at GitHub is required for repo detection; otherwise pass `--repo owner/name`):

```bash
npx -y @opslane/cli@latest setup --start
```

```json
{
  "status": "auth_required",
  "auth_url": "https://api.opslane.com/agent/auth/6f0c…",
  "poll_id": "6f0c…",
  "poll_token": "<secret — store locally, never print or commit>",
  "message": "Authorize Opslane: https://api.opslane.com/agent/auth/6f0c…"
}
```

If the repo already has an Opslane project, you get `{"status": "already_configured", …}` instead — see the table below.

Self-hosting? Add `--api-url http://localhost:8082` to every command on this page. Note the agent flow needs a configured GitHub App on your server ([connecting GitHub](https://docs.opslane.com/guides/github-app/)); the default Compose stack from the [self-host quickstart](https://docs.opslane.com/quickstart/self-host/) does not include one.

## 2. Hand the auth link to your human

Show `auth_url` to your human **verbatim** and ask them to open it in a browser where they are signed in to GitHub. They will see one combined GitHub screen that installs the Opslane App and authorizes their identity. The session expires about 15 minutes after `setup --start`.

## 3. Poll until provisioned

```bash
npx -y @opslane/cli@latest setup --poll <poll_id>
```

- `{"status": "pending", …}` — the human hasn't finished (or the org requires installation approval). Exit code 0. Run the poll again; remind the human about the link if it persists.
- `{"status": "completed", "org_id": "…", "project_id": "…", "api_key": "…"}` — provisioned. The credential is stored locally (`~/.opslane/agent-credentials.json`, mode 0600). Do not echo `api_key` into logs, chat, or commits.

If the human reports an error page that says to **reopen the authorization link**, that is a transient GitHub-side hiccup, not a failure: the session is still `pending` — have them open the same `auth_url` again and keep polling. (Only `pending` sessions can be reopened; the `failed` states in the table below always need a fresh `setup --start`.)

## 4. Wire the SDK

```bash
npx -y @opslane/cli@latest snippet
```

The JSON response has three parts — apply all three:

1. `install` — the package-manager-specific install command for `@opslane/sdk`. Run it first.
2. `patches` — each with `file_path`, an `action`, and content/anchor fields (for example `insert_after` + `insert_content`). Apply exactly as printed.
3. `env` — `{var, value, file, gitignore}`. Write the variable to the named file (typically `.env.local`) and make sure that file is gitignored.

## 5. Tell your human about session replay

Opslane records session replay **by default** so investigations can see what the user did before an error. Surface this to your human before shipping: replay is masked by default and can be tuned or disabled — point them at [replay privacy and masking](https://docs.opslane.com/guides/replay-privacy/). Do not silently make this decision for them.

## 6. Trigger an error and verify

Cause any handled or unhandled error in the running app (a test route, a dev-only crash button), then:

```bash
npx -y @opslane/cli@latest verify
```

`{"status": "ok", "api_reachable": true, "has_events": true}` means the loop is closed: Opslane is receiving events for this project. `has_events: false` with `status: "ok"` means the API is reachable but no event has arrived yet — trigger the error again and re-run.

## Failure and edge states

Where each state comes from and what to do. (`rate_limited` comes from `setup --start`; the CLI retries poll-time rate limits internally. `key_unavailable` is reported by the CLI after a *completed* poll whose key-delivery window closed. The rest are poll or start results as noted.)

| Response | Emitted by | Meaning | What the agent should do |
| --- | --- | --- | --- |
| `status: "already_configured"` (exit 0) | `setup` / `setup --start` | Either valid local credentials exist for this repo, or the server already has a project for it. | If you have local credentials, run `verify`. If `verify` says `no_credentials`, recovery needs the human: `opslane login`, then `opslane setup --relink`. |
| `status: "expired"` | `setup --poll` | The ~15-minute session lapsed before authorization. | Run `setup --start` again and hand over the fresh link. |
| `status: "not_found"` | `setup --poll` | Unknown `poll_id` or wrong poll token. | Run `setup --start` again. |
| `status: "rate_limited"` | `setup --start` | Too many session starts. | Wait `retry_after` seconds, then retry. |
| `status: "key_unavailable"` | `setup --poll` | Provisioning completed but the key-delivery window closed. | Recovery needs the human: `opslane login`, then `opslane setup --relink`. |
| `status: "failed", failure_reason: "identity_unverified"` | `setup --poll` | GitHub couldn't prove the authorizing human's identity (for example no verified email). | Human fixes their GitHub account state; then a fresh `setup --start`. |
| `status: "failed", failure_reason: "installation_not_yours"` | `setup --poll` | The person who authorized doesn't own the App installation used. | The same human must both install and authorize; fresh `setup --start`. |
| `status: "failed", failure_reason: "repo_not_granted"` | `setup --poll` | The installation doesn't include this repository. | Human grants the repo in the installation's repository access first; then a fresh `setup --start` (failed sessions cannot be reopened). |
| `status: "failed", failure_reason: "org_exists_needs_invite"` | `setup --poll` | The org already exists in Opslane and the human isn't a member. | An existing org admin invites them in the dashboard; then a fresh `setup --start`. |
| `status: "failed", failure_reason: "repo_already_configured"` | `setup --poll` | Another project already owns this repository. | Use the existing project: `opslane login` + `opslane setup --relink`. |

## Raw HTTP (no CLI)

The CLI is a thin client over two endpoints — usable directly if you cannot run `npx`. `repo_url` takes **`owner/repo` format** (a full GitHub URL is rejected with 400):

```bash
curl -s -X POST https://api.opslane.com/api/v1/agent/setup \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "OWNER/REPO", "agent_name": "my-agent"}'
# → 201 {"status":"auth_required","auth_url":…,"poll_id":…,"poll_token":…}

curl -s https://api.opslane.com/api/v1/agent/poll/<poll_id> \
  -H "X-Opslane-Poll-Token: <poll_token>"
# → 200 {"status":"pending"} … then {"status":"completed","api_key":…}
```

The poll token is the retrieval secret — send it only in the `X-Opslane-Poll-Token` header, never in a URL. Completed polls redeliver the key until the session expires; treat every delivery as the same secret.
````

**Step 2: Verify the doc parses and passes gates**

```bash
node scripts/check-docs-drift.mjs && node scripts/check-docs-scope.mjs
(cd docs-site && pnpm build)
```

Expected: drift ✓ (non-empty `covers:`); build succeeds and — because of `draft: true` — emits **no** `dist/quickstart/agent/` page. (`extractTitle` fails the build on zero/multiple H1s — one H1 exists.)

**Step 3: Commit**

```bash
git add docs/quickstart/agent.md
git commit -m "docs: agent quickstart content (dark — draft: true)"
```

## Task 1b: GitHub App guide — document the agent-flow App requirements

**Files:** Modify `docs/guides/github-app.md` (under "## Mode 2: GitHub App", `github-app.md:23-54`).

The quickstart's self-host note points here for App setup, but the guide predates the agent flow and omits its two hard requirements — both proven live in the PR 6 smoke (the missing email permission produced a 502 "GitHub check failed" on first authorization).

**Step 1:** Add a short subsection to Mode 2 (match the guide's voice; absolute links not required here — this page is site-rendered, not raw-consumed):

```markdown
### Extra requirements for agent onboarding

If agents will set up projects via `opslane setup` (see the agent quickstart), the App additionally needs:

- **"Request user authorization (OAuth) during installation" enabled** — the agent flow verifies the authorizing human's identity in the same interaction as the install.
- **Account permission "Email addresses: Read-only"** — the identity check reads the authorizer's verified email; without this permission every agent authorization fails with "GitHub check failed".
- The **Callback URL** must be your server's `/auth/github/callback` (one shared callback dispatches both the web login flow and agent sessions).
```

(Do not link the agent quickstart by URL yet — it is dark until PR 7; the prose mention is enough and PR 7 can add the link.)

**Step 2:** Gates re-run clean: `node scripts/check-docs-drift.mjs && node scripts/check-docs-scope.mjs` (guide already has `covers:`; content-only edit).

**Step 3: Commit**

```bash
git add docs/guides/github-app.md
git commit -m "docs: GitHub App requirements for agent onboarding (OAuth-during-install, email read)"
```

## Task 2: Shared fail-closed frontmatter parser + raw `/agent.md` endpoint

**Files:** Create `docs-site/scripts/frontmatter.mjs` (shared parser), `docs-site/src/agent-md.ts` (endpoint logic), `docs-site/src/pages/agent.md.ts` (thin endpoint); test `docs-site/src/__tests__/agent-md.test.ts`.

One parser, two consumers (endpoint + Task 3 gate) — two hand-rolled parsers would quietly disagree and break the "one flag gates every surface" invariant (Codex P2).

**Step 1: Failing tests** (`agent-md.test.ts`, vitest, house style per `repo-docs.test.ts`):

```typescript
import { describe, expect, it } from 'vitest';

import { parseDraft } from '../../scripts/frontmatter.mjs';
import { agentQuickstartResponse, loadAgentQuickstart } from '../agent-md';

describe('parseDraft', () => {
  it('parses explicit draft flags, tolerating CRLF', () => {
    expect(parseDraft('---\ndraft: true\n---\n# T\n')).toBe(true);
    expect(parseDraft('---\r\ndraft: false\r\n---\r\n# T\r\n')).toBe(false);
  });
  it('fails closed on missing, duplicate, or malformed draft', () => {
    expect(() => parseDraft('---\ncovers: []\n---\n# T\n')).toThrow();          // missing
    expect(() => parseDraft('---\ndraft: true\ndraft: false\n---\n')).toThrow(); // duplicate
    expect(() => parseDraft('# no frontmatter\n')).toThrow();                    // malformed
  });
});

describe('agent quickstart endpoint', () => {
  it('reads the real canonical doc', () => {
    const doc = loadAgentQuickstart();
    expect(doc.body).toContain('# Agent quickstart');
    expect(doc.body.startsWith('---')).toBe(false); // frontmatter stripped
  });
  it('404s (null body) while draft; serves markdown when live', async () => {
    expect(agentQuickstartResponse({ draft: true, body: 'x' }).status).toBe(404);
    const live = agentQuickstartResponse({ draft: false, body: '# T' });
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toContain('text/markdown');
    expect(await live.text()).toBe('# T');
  });
});
```

**Step 2: Run — expect FAIL** (`cd docs-site && pnpm test`): modules not found.

**Step 3: Implement.**

- `docs-site/scripts/frontmatter.mjs`: `export function parseDraft(markdown)` — require a leading `---` fence, extract the block, find lines matching `/^draft:\s*(true|false)\s*$/` (after CRLF normalization); **throw** on zero or multiple matches or missing fence. Fail-closed consumers: the endpoint treats a throw as dark (404), the gate treats a throw as build failure.
- `docs-site/src/agent-md.ts`: resolve the canonical doc at `new URL('../../docs/quickstart/agent.md', import.meta.url)` — **two** levels up from `src/` (the loader's three-level path is for `src/loaders/`; wrong depth is a silent 404). `loadAgentQuickstart()` reads the file, `parseDraft`s it (try/catch → `draft: true` on parse failure), strips frontmatter, returns `{draft, body}`. `agentQuickstartResponse({draft, body})` returns `new Response(null, {status: 404})` when draft (null body ⇒ Astro 7.1.0 emits no file — verified `generate.js:244`; do NOT throw while dark, Astro rethrows endpoint errors and fails the build) else `new Response(body, {status: 200, headers: {'Content-Type': 'text/markdown; charset=utf-8'}})`.
- `docs-site/src/pages/agent.md.ts`:

```typescript
import type { APIRoute } from 'astro';

import { agentQuickstartResponse, loadAgentQuickstart } from '../agent-md';

export const GET: APIRoute = () => agentQuickstartResponse(loadAgentQuickstart());
```

**Step 4: Run tests + build; verify dark behavior empirically**

```bash
cd docs-site && pnpm test && pnpm build
ls dist/agent.md 2>/dev/null && echo "PROBLEM: emitted while draft" || echo "dark ok"
```

**Step 5: Commit**

```bash
git add docs-site/scripts/frontmatter.mjs docs-site/src/agent-md.ts docs-site/src/pages/agent.md.ts docs-site/src/__tests__/agent-md.test.ts
git commit -m "feat(docs-site): raw /agent.md endpoint gated on the quickstart draft flag"
```

## Task 3: Built-artifact dark-launch gate (self-inverting for PR 7)

**Files:** Create `docs-site/scripts/check-dark-launch.mjs`; modify `docs-site/package.json:9` (build script).

**Step 1: Write the check** — dependency-free, style of `check-built-links.mjs`; imports `parseDraft` from `./frontmatter.mjs` (same parser as the endpoint). Sentinels: the slug `quickstart/agent` **and** the unique body strings `# Agent quickstart` / `Hand the auth link to your human` — llms outputs contain title+body, not necessarily the slug, so a slug-only search could miss a full-content leak (Codex P1). Logic:

1. `parseDraft` on `../../docs/quickstart/agent.md` (throw ⇒ exit 1).
2. **Dark (`draft: true`):** assert ALL of — no `dist/quickstart/agent/` directory; no `dist/agent.md`; none of the three sentinels appear in any `dist/**/*.html` or in `dist/llms.txt`, `dist/llms-full.txt`, `dist/llms-small.txt`. (No Pagefind byte-scan: the installed Pagefind index is compressed — even the live `quickstart/self-host` slug is absent from raw bytes, so a byte-scan proves nothing; absence of the built HTML page IS the Pagefind guarantee.)
3. **Live (`draft: false`, post-PR 7):** invert — assert `dist/quickstart/agent/index.html` exists AND `dist/agent.md` exists and contains `# Agent quickstart`. The gate flips itself when PR 7 flips the flag.
4. Exit 1 with a listed-problems report (mirror `check-built-links.mjs` output shape).

**Step 2: Wire into the build** — `docs-site/package.json`:

```json
"build": "astro build && node scripts/check-built-links.mjs && node scripts/check-dark-launch.mjs",
```

**Step 3: Prove the gate discriminates (both flag states)**

```bash
cd docs-site && pnpm build            # dark: gate passes
# Flip draft: false in docs/quickstart/agent.md, rebuild:
pnpm build                            # live: gate now demands presence — passes (page + agent.md emitted)
mv dist/agent.md /tmp/ && node scripts/check-dark-launch.mjs; echo "exit=$?"   # expect exit=1
git checkout -- ../docs/quickstart/agent.md   # restore draft: true
pnpm build                            # dark again, green
```

**Step 4: Commit**

```bash
git add docs-site/scripts/check-dark-launch.mjs docs-site/package.json
git commit -m "test(docs-site): build gate asserts agent quickstart dark-launch state"
```

## Task 4: Content-invariant tests (links, contract, failure reasons)

**Files:** Test `docs-site/src/__tests__/agent-quickstart-content.test.ts`.

Honest scope: these tests guard **link discipline, status-name validity, and failure-reason validity**. They cannot prove prose semantics (exit codes, remediation correctness) — that is what this plan's source-verified content plus review is for; do not claim otherwise in the PR.

**Step 1: Write the test** (vitest): read `docs/quickstart/agent.md` raw and assert:

- After stripping fenced code blocks: every markdown link target and `<https…>` autolink matches `^https://`; links into our docs host match `^https://docs\.opslane\.com/…/$` (trailing slash, Starlight canonical form). No relative/rooted/`http://` links outside code fences.
- Frontmatter: `parseDraft` returns `true` (delete this assertion in PR 7 — leave a `// PR 7 deletes this line` comment) and a non-empty `covers:` block exists.
- Exactly one H1 (reuse `extractTitle` from `../loaders/repo-docs`).
- Every `status: "…"` string used in the doc exists in `AGENT_STATUSES` — **real source import** `import { AGENT_STATUSES } from '../../../cli/src/contract';` (no vitest config or TS boundary blocks this; if it somehow fails, fix the config — do NOT copy the list, a copy is a stale duplicate).
- Every `failure_reason: "…"` string used in the doc appears as a quoted literal in `packages/ingestion/handler/agent_setup.go` (read the file as text) — guards the failure table against server-side renames the deterministic checker can't see.

**Step 2: Run — expect PASS** (`cd docs-site && pnpm test`).

**Step 3: Commit**

```bash
git add docs-site/src/__tests__/agent-quickstart-content.test.ts
git commit -m "test(docs-site): agent quickstart link and contract invariants"
```

## Task 5: Full gate + PR

**Step 1: Gates**

```bash
node scripts/check-docs-drift.mjs && node scripts/check-docs-scope.mjs
(cd docs-site && pnpm test && pnpm build)
```

**Step 2: Branch + PR.** Work happens on `abhishekray07/agent-quickstart` off `origin/main`. Push is hook-blocked for agents — founder runs `! git push -u origin abhishekray07/agent-quickstart` (Claude Code bang prefix; plain `git push -u origin abhishekray07/agent-quickstart` in a terminal), then `gh pr create` from the repo root. PR body: what lands dark; the surfaces the gate proves dark (built page, sidebar/Pagefind, llms outputs, `/agent.md`); what PR 7 flips. CI note: expect the docs-sync bot to push a `docs: sync` head — judge the newest run.

## Out of scope (explicit — all PR 7)

- Sidebar entry, root `llms.txt` entry, `docs/install.md` pointer, landing CTA (`index.mdx`), dashboard card flag, and flipping `draft: false`.
- `docs.opslane.com` domain activation (PR 7 gate 4).
- Any CLI or server change — this PR is content + gating only.
