# Agent Onboarding PR 6 — Live End-to-End Smoke Plan

> **Execution:** task-by-task (Claude: `superpowers:executing-plans`; other executors follow the same flow). Tasks marked **HUMAN** need the founder at a browser logged into GitHub as `abhishekray07` — the executor must stop and wait at each one.

> **Status:** EXECUTED GREEN 2026-07-19 (PDT). Revised after two Codex review rounds (round 1: 6 P0, 9 P1, 6 P2; round 2: 4 carry-overs + 1 P0, 4 P1 new — all folded in). Evidence and execution findings below; three runbook corrections from the live run are annotated inline.

**Goal:** Prove the entire agent-first onboarding loop works live, exactly as an agent would drive it: `setup --start` → human GitHub authorization → poll (server redelivery contract proven over raw HTTP, then CLI claim) → apply `snippet` patches + env file → real browser error → event ingested at `/api/v1/events` (202, network-captured) → `verify` reports `has_events: true` → admin funnel reads exactly `started 1 / auth_clicked 1 / completed 1 / key_claimed 1 / first_event_received 1 / failed 0`.

**Architecture:** No product code changes are expected. The PR ships this runbook with a filled-in evidence section, design-doc status updates, and — only if the smoke finds bugs — minimal scoped fixes as separate commits. The smoke runs against the local Compose stack using the Phase 0 spike App A as the development GitHub App and a fresh `opslane_smoke` database so the funnel numbers are exact.

**Tech Stack:** docker compose (ingestion, postgres, minio, migrate — **not** worker), `@opslane/cli` (built from `main`), `test-fixtures/react-app` + Vite, Playwright via `test-e2e`'s `@playwright/test` for the network-captured error trigger, `psql`, `curl`.

**Shell discipline (Codex P0 ×2):** every command block below is fully self-contained — no variable, working directory, or export survives between blocks (the run crosses two human pauses and possibly multiple shells). Each block literally begins with these three lines (no shorthand):

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
```

Cross-block state (like the session's `POLL_ID`) is persisted by **appending exports to the env file**, never by relying on shell memory.

**Context you need (verified against merged code, 2026-07-19):**

- **The loop under test** (design doc §PR 6; PRs 1/2/4/5 merged):
  - `POST /api/v1/agent/setup` (`AgentSetup`, `handler/agent_setup.go:42`) returns **HTTP 201** with `status: "auth_required"`, `auth_url`, `poll_id`, `poll_token`, `message` (`agent_setup.go:123-128`). Sessions expire after **15 minutes** — the human step must happen inside that window.
  - `auth_url` is `{AUTH_CALLBACK_ORIGIN}/agent/auth/{sessionID}`; opening it stamps `auth_clicked_at` and redirects to `https://github.com/apps/{GITHUB_APP_SLUG}/installations/new?state={sessionID}` (`agent_setup.go:234-276`).
  - GitHub (OAuth-during-install ON) sends `code + installation_id + setup_action + state` to the App's **Callback URL**, which must be the shared dispatcher `**/auth/github/callback**` — UUID state routes to the agent path (`github_oauth.go:98-101`). NOT `/agent/auth/callback`.
  - **Poll redelivery contract:** on every authenticated poll of a completed session before expiry, the server unseals and returns the **raw `api_key`** again (`agent_setup.go:180-208`) — redelivery, not exactly-once. Exactly-once is CLI-side: `setup --poll` deletes its local pending file after saving credentials (`setup.ts:197`), so a second CLI poll is a **local** `not_found`. The smoke proves the server contract with two raw-HTTP polls (asserting the two delivered keys are **identical**, compared by hash — never printed), then lets the CLI claim.
  - `key_claimed_at` stamps on **first** delivery only (COALESCE in `MarkAgentKeyDelivered`), so the raw polls don't inflate the funnel.
  - `POST /api/v1/events` returns **HTTP 202** with `event_id` + `group_id` (`error_event.go:212`).
  - `opslane verify` reads saved credentials and calls `/api/v1/projects/{project_id}/event-count` → `has_events` (`cli/src/verify.ts:66`).
  - Funnel: `onboarding` object on `GET /api/v1/admin/overview` (PR 5, #117).
- **Dev GitHub App = spike App A**: `opslane-spike-a-e196`, id **4334696**, owner **abhishekray07** (personal). Private app ⇒ installable **only on abhishekray07's namespace** — the smoke repo must live there; the monorepo remote (`opslane/opslane-oss`) will NOT work, so `--repo` is passed explicitly.
- **Policy decision (supersedes design §Assets "delete after PR 6"):** App A is promoted to the **standing dev App** for local smokes; its credentials live at `~/.opslane/dev-apps/opslane-spike-a.json` (0600, outside any repo). Rotate via the App's GitHub settings page if ever exposed. App B (`opslane-spike-b-2075`) is still deleted. Task 8 updates the design doc to say this explicitly.
- **App A credentials** currently exist ONLY in the ephemeral session scratchpad
  `/private/tmp/claude-501/-Users-abhishekray-orca-workspaces-opslane-oss-CLI-onboarding/bfb1ffff-e71a-4064-99cf-58baefd28f56/scratchpad/spike/apps/a.json`
  (`id`, `slug`, `client_id`, `client_secret`, `pem`, `webhook_secret`). `/private/tmp` is wiped on reboot — Task 0 preserves them (plus the spike's manifest capture server) FIRST and treats their presence as a **hard prerequisite**. If already gone: follow Appendix A before continuing.
- **Compose env plumbing** (`docker-compose.yml:46-74`): `GITHUB_APP_*`, `INGESTION_PORT`, `AUTH_CALLBACK_ORIGIN`, `AUTH_PROVIDER`, `ADMIN_EMAILS`, `OPSLANE_COMPOSE_DATABASE_URL` all interpolate from the shell environment. **Defaults are not assumed:** the env file pins `INGESTION_PORT=8082`, `AUTH_CALLBACK_ORIGIN=http://localhost:8082`, `AUTH_PROVIDER=github` explicitly so pre-existing shell exports can't silently redirect the flow. `OPSLANE_COMPOSE_DATABASE_URL` steers **both** `migrate` and `ingestion` at the fresh smoke DB.
- **Clean-state guardrail**: funnel must read exactly 1/1/1/1/1 ⇒ fresh `opslane_smoke` database (created in the existing compose postgres, dropped at the end with `WITH (FORCE)` after stopping ingestion). Never run destructive SQL against the retained `opslane` DB.
- **Fixture reality (Codex P0):** `test-fixtures/react-app/src/main.tsx` **already contains** a full `init({...})` with the hard-coded `e2e-test-key-plaintext` key (`main.tsx:2-11`). The react-vite codemod returns **no patches** when import+init already exist (`codemods/react-vite.ts:29`) — running `snippet` against the untouched fixture silently no-ops and the smoke passes **vacuously** on a key that doesn't exist in the fresh DB. Task 5 strips the existing init first, asserts a non-empty `src/main.tsx` patch, and restores the fixture afterward. The valid framework name is **`react-vite`** (`detect.ts:4`, `codemods/registry.ts:7`) — `--framework react` falls through to the AI fallback and produces a different file entirely.
- **Local CLI state:** credentials live at `~/.opslane/agent-credentials.json` — **v2 keyed-record shape** `{ version: 2, credentials: Record<string, {org_id, project_id, api_key, repo, api_url}> }` (`agent-credentials.ts:15-17`); pending sessions at `~/.opslane/pending/<poll_id>.json` (`pending.ts:15`). A stale credential for `(http://localhost:8082, <smoke repo>)` makes `setup` short-circuit with `credentials_invalid` before creating a session. Task 3 surgically clears that one record (v2 shape only; anything else → inspect by hand or use `--force` and record it).
- **Fixture error path:** the crash is two clicks — `[data-testid="nav-profile"]` then `[data-testid="load-profile-btn"]` (`App.tsx:8`, `BuggyProfile.tsx:14`); the error boundary shows `[data-testid="boundary-fallback"]`.
- **Worker stays down:** `docker compose up -d ingestion` does not stop an already-running worker — Task 2 stops it explicitly so the ingested error doesn't trigger LLM investigation spend.
- **Playwright**: `test-e2e` has `@playwright/test` (`test-e2e/package.json:14`); the capture script runs with `test-e2e` as cwd so the import resolves. If Chromium isn't installed yet: `cd test-e2e && pnpm exec playwright install chromium` once.

---

## Task 0: Preserve App A credentials, write the smoke env file, preflight

**Step 1: Preserve credentials + manifest capture server (hard prerequisite)**

```bash
set -euo pipefail
SPIKE="/private/tmp/claude-501/-Users-abhishekray-orca-workspaces-opslane-oss-CLI-onboarding/bfb1ffff-e71a-4064-99cf-58baefd28f56/scratchpad/spike"
mkdir -p "$HOME/.opslane/dev-apps" && chmod 700 "$HOME/.opslane/dev-apps"
if [ -f "$HOME/.opslane/dev-apps/opslane-spike-a.json" ]; then echo "already preserved"
elif [ -f "$SPIKE/apps/a.json" ]; then
  cp "$SPIKE/apps/a.json" "$HOME/.opslane/dev-apps/opslane-spike-a.json"
  cp "$SPIKE/server.mjs" "$HOME/.opslane/dev-apps/manifest-capture.mjs" 2>/dev/null || true
else echo "GONE — follow Appendix A before continuing"; exit 1; fi
chmod 600 "$HOME/.opslane/dev-apps/opslane-spike-a.json"
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.opslane/dev-apps/opslane-spike-a.json'))); assert all(k in d for k in ('id','slug','client_id','client_secret','pem')), 'missing fields'; print('ok:', d['slug'], d['id'])"
```

Expected: `ok: opslane-spike-a-e196 4334696`.

**Step 2: Write the env file** (0600; single source of truth for every later block)

```bash
set -euo pipefail
mkdir -p "$HOME/.opslane/smoke" && chmod 700 "$HOME/.opslane/smoke"
REPO_ROOT="/Users/abhishekray/orca/workspaces/opslane-oss/CLI-onboarding"
PSQL_BIN=$(command -v psql || ls /opt/homebrew/opt/libpq/bin/psql)
python3 - "$REPO_ROOT" "$PSQL_BIN" > "$HOME/.opslane/smoke/pr6.env" <<'EOF'
import json, os, shlex, sys
d = json.load(open(os.path.expanduser('~/.opslane/dev-apps/opslane-spike-a.json')))
repo_root, psql = sys.argv[1], sys.argv[2]
print(f'export REPO_ROOT={shlex.quote(repo_root)}')
print(f'export PSQL={shlex.quote(psql)}')
print('export SMOKE_REPO="abhishekray07/opslane-smoke-fixture"')
print('export PG_ADMIN="postgres://opslane:opslane_dev@localhost:5434/postgres"')
print('export SMOKE_DB="postgres://opslane:opslane_dev@localhost:5434/opslane_smoke"')
print(f"export GITHUB_APP_ID={d['id']}")
print(f"export GITHUB_APP_CLIENT_ID={shlex.quote(d['client_id'])}")
print(f"export GITHUB_APP_CLIENT_SECRET={shlex.quote(d['client_secret'])}")
print(f"export GITHUB_APP_PRIVATE_KEY={shlex.quote(d['pem'])}")
print(f"export GITHUB_APP_SLUG={shlex.quote(d['slug'])}")
print('export OPSLANE_COMPOSE_DATABASE_URL="postgres://opslane:opslane_dev@postgres:5432/opslane_smoke?sslmode=disable"')
print('export OPSLANE_ADMIN_EMAILS="admin@e2e.test"')
print('export INGESTION_PORT=8082')
print('export AUTH_CALLBACK_ORIGIN="http://localhost:8082"')
print('export AUTH_PROVIDER=github')
EOF
chmod 600 "$HOME/.opslane/smoke/pr6.env"
source "$HOME/.opslane/smoke/pr6.env" && echo "env ok: app=$GITHUB_APP_SLUG port=$INGESTION_PORT"
```

Expected: `env ok: app=opslane-spike-a-e196 port=8082`.

**Step 3: Preflight — ports, fixture cleanliness, branch (rerun-safe)**

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
lsof -nP -iTCP:8082 -sTCP:LISTEN && { echo "8082 BUSY — stop that stack first"; exit 1; } || echo "8082 free"
lsof -nP -iTCP:5199 -sTCP:LISTEN && { echo "5199 BUSY — free it first"; exit 1; } || echo "5199 free"
git status --porcelain -- test-fixtures/react-app | grep . && { echo "fixture DIRTY — commit/stash first (cleanup uses git restore)"; exit 1; } || echo "fixture clean"
git fetch origin
git checkout -b abhishekray07/agent-live-smoke origin/main 2>/dev/null || git checkout abhishekray07/agent-live-smoke
git log --oneline -1   # must include the PR 5 merge (#117)
```

---

## Task 1 (HUMAN): Point App A at the local stack + create the smoke repo

The executor prints these instructions and **waits**. Founder, logged into GitHub as `abhishekray07`:

1. Open <https://github.com/settings/apps/opslane-spike-a-e196>.
2. Set **Callback URL** to exactly: `http://localhost:8082/auth/github/callback` (the shared dispatcher — not `/agent/auth/callback`).
3. Confirm **"Request user authorization (OAuth) during installation"** is **checked**.
4. Save.
5. Create the smoke repo (private, under your personal account; skip-if-exists makes reruns safe):
   ```bash
   gh repo view abhishekray07/opslane-smoke-fixture >/dev/null 2>&1 || gh repo create abhishekray07/opslane-smoke-fixture --private
   ```
6. If App A is currently installed anywhere (<https://github.com/settings/installations>), uninstall it so the smoke exercises a **fresh** install.

If you pick a different repo name, update `SMOKE_REPO` in `~/.opslane/smoke/pr6.env`.

---

## Task 2: Fresh smoke database + stack up (worker stopped, health-gated)

**Step 1: Postgres up, worker down, prior smoke ingestion stopped** (rerun-safe)

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
docker compose up -d --wait postgres
docker compose stop worker ingestion 2>/dev/null || true
docker compose ps --status running | grep -E "worker|ingestion" && { echo "still running"; exit 1; } || echo "worker+ingestion down"
```

**Step 2: Disposable database** (`WITH (FORCE)` kills leftover connections from a crashed run)

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
"$PSQL" "$PG_ADMIN" -c "DROP DATABASE IF EXISTS opslane_smoke WITH (FORCE)"
"$PSQL" "$PG_ADMIN" -c "CREATE DATABASE opslane_smoke OWNER opslane"
```

**Step 3: Build + start ingestion, gated on health**

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
docker compose build ingestion
docker compose up -d --wait --force-recreate ingestion   # deps: minio, minio-setup, migrate
docker compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' | grep migrate   # expect: migrate exited 0
curl -sf http://localhost:8082/health
"$PSQL" "$SMOKE_DB" -c "SELECT count(*) FROM agent_sessions"   # expect: 0
```

If `--wait` times out or migrate exited non-zero: `docker compose logs migrate ingestion --tail 50` and diagnose before proceeding.

**Step 4: Seed the admin user** (funnel check only; bcrypt hash copied from `scripts/seed-e2e.sql:30-33` in case `users.password_hash` is NOT NULL)

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
"$PSQL" "$SMOKE_DB" <<'SQL'
INSERT INTO orgs (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Smoke Admin Org') ON CONFLICT DO NOTHING;
INSERT INTO users (id, org_id, email, password_hash, name) VALUES
 ('00000000-0000-0000-0000-000000010000', '00000000-0000-0000-0000-000000000001',
  'admin@e2e.test', '$2b$10$G63dr4R.8EijgojPPTsQ8uC0hdGaPvtQ4UiSqj9Nbi0DH0Wh/xgi2', 'Smoke Admin')
ON CONFLICT (id) DO NOTHING;
SQL
```

---

## Task 3: Build the CLI, clear stale local state, start the session

**Step 1: Build**

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
pnpm install --frozen-lockfile
pnpm --filter @opslane/cli build
```

**Step 2: Surgically clear the stale CLI credential for this (api_url, repo) pair** (v2 keyed-record shape)

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.opslane/agent-credentials.json')
repo, api = os.environ['SMOKE_REPO'].lower(), 'http://localhost:8082'
if not os.path.exists(p):
    print('no credentials file'); raise SystemExit
d = json.load(open(p))
creds = d.get('credentials') if isinstance(d, dict) else None
if isinstance(d, dict) and d.get('version') == 2 and isinstance(creds, dict):
    drop = [k for k, v in creds.items()
            if isinstance(v, dict)
            and v.get('repo', '').lower() == repo
            and v.get('api_url', '').rstrip('/') == api]
    for k in drop: del creds[k]
    json.dump(d, open(p, 'w'), indent=2)
    print(f'removed {len(drop)} stale record(s)')
else:
    print('UNRECOGNIZED SHAPE — inspect by hand, or run setup with --force and record that in evidence')
EOF
```

**Step 3: `setup --start`** — capture output to a file, persist `POLL_ID` into the env file

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT/test-fixtures/react-app"
node "$REPO_ROOT/cli/dist/index.js" setup --start \
  --api-url http://localhost:8082 \
  --repo "$SMOKE_REPO" \
  --agent-name claude-code | tee "$HOME/.opslane/smoke/setup-start.json"
POLL_ID=$(python3 -c "import json; print(json.load(open('$HOME/.opslane/smoke/setup-start.json'))['poll_id'])")
grep -q "^export POLL_ID=" "$HOME/.opslane/smoke/pr6.env" && sed -i '' "s|^export POLL_ID=.*|export POLL_ID=$POLL_ID|" "$HOME/.opslane/smoke/pr6.env" || echo "export POLL_ID=$POLL_ID" >> "$HOME/.opslane/smoke/pr6.env"
echo "POLL_ID=$POLL_ID persisted"
```

Expected JSON (in `setup-start.json`): `status: "auth_required"`, `auth_url` = `http://localhost:8082/agent/auth/<uuid>`, `poll_id`, `poll_token`, `message`. **Redact `poll_token` in all evidence** (the capture file is under the 0700 smoke dir; it's deleted in cleanup). The pending session is saved at `~/.opslane/pending/<poll_id>.json`. **The 15-minute expiry clock starts now.**

**Step 4: DB checkpoint**

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
"$PSQL" "$SMOKE_DB" -c "SELECT status, auth_clicked_at IS NOT NULL AS clicked, poll_token_hash IS NOT NULL AS v2 FROM agent_sessions"
```

Expected: one row — `pending | f | t`.

---

## Task 4 (HUMAN): Authorize, prove redelivery over raw HTTP, then CLI claim

**Step 1 (HUMAN):** Open the `auth_url` from `~/.opslane/smoke/setup-start.json` in a browser logged in as `abhishekray07`. GitHub shows one combined install+authorize screen for `opslane-spike-a-e196`. Grant **only** the smoke repo and approve. Note what the final page shows (success page vs plain response) for the evidence table.

**Step 2: Prove the redelivery contract over raw HTTP** — the exact session (`$POLL_ID`), payloads captured and compared, key never printed:

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
POLL_TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.opslane/pending/$POLL_ID.json')))['poll_token'])")
for i in 1 2; do
  curl -s -H "X-Opslane-Poll-Token: $POLL_TOKEN" \
    "http://localhost:8082/api/v1/agent/poll/$POLL_ID" > "$HOME/.opslane/smoke/poll-$i.json"
done
python3 - <<'EOF'
import hashlib, json, os
h = []
for i in (1, 2):
    d = json.load(open(os.path.expanduser(f'~/.opslane/smoke/poll-{i}.json')))
    assert d.get('status') == 'completed', f'poll {i}: status={d.get("status")}'
    assert d.get('api_key'), f'poll {i}: no api_key delivered'
    h.append(hashlib.sha256(d['api_key'].encode()).hexdigest()[:16])
assert h[0] == h[1], f'keys differ: {h}'
print(f'redelivery OK — both polls completed, identical key (sha256 prefix {h[0]})')
EOF
```

Expected: `redelivery OK — both polls completed, identical key (sha256 prefix …)`. This proves the server-side contract; `key_claimed_at` stamped on the first poll only.

**Step 3: CLI claim** (uses the same exact session)

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT/test-fixtures/react-app"
node "$REPO_ROOT/cli/dist/index.js" setup --poll "$POLL_ID" --api-url http://localhost:8082
```

Expected JSON: `status: "completed"` with `org_id`, `project_id`, `api_key` (**redact — hash prefix only in evidence**). Credentials saved to `~/.opslane/agent-credentials.json`; the pending file `~/.opslane/pending/$POLL_ID.json` is deleted.

**Step 4: Second CLI poll — client-side exactly-once** (expected to FAIL with exit 1)

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT/test-fixtures/react-app"
set +e
node "$REPO_ROOT/cli/dist/index.js" setup --poll "$POLL_ID" --api-url http://localhost:8082
RC=$?
set -e
echo "second CLI poll exit code: $RC (expected 1)"
[ "$RC" = "1" ]
```

Expected: JSON `status: "not_found"` (local — the pending file is gone; the server was not asked), exit code 1.

**Step 5: DB checkpoint**

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
"$PSQL" "$SMOKE_DB" -c "SELECT status, auth_clicked_at IS NOT NULL, key_claimed_at IS NOT NULL, failure_reason FROM agent_sessions"
```

Expected: `completed | t | t | (null)`.

---

## Task 5: Snippet like an agent, run the fixture, trigger a real error

**Step 1: Strip the fixture's pre-baked init** (otherwise the codemod no-ops and the smoke is vacuous). Edit `test-fixtures/react-app/src/main.tsx`: delete the `import { init } from '@opslane/sdk';` line and the entire `init({ ... });` block (`main.tsx:2,6-11`). Keep `OpslaneErrorBoundary` and everything else. This file is restored by cleanup via `git checkout --`.

**Step 2: Get patches** — framework is **`react-vite`**, not `react`:

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT/test-fixtures/react-app"
node "$REPO_ROOT/cli/dist/index.js" snippet --framework react-vite --api-url http://localhost:8082 --repo "$SMOKE_REPO" | tee "$HOME/.opslane/smoke/snippet.json"
python3 -c "
import json, os
d = json.load(open(os.path.expanduser('~/.opslane/smoke/snippet.json')))
patches = d.get('patches', [])
# Field is file_path (verified in execution — file/path are wrong keys)
assert patches and any('main.tsx' in str(p.get('file_path') or '') for p in patches), 'EMPTY/WRONG patches — Step 1 skipped or codemod regressed'
assert 'localhost:8082' in json.dumps(d), 'endpoint override missing'
print('snippet ok:', len(patches), 'patch(es), endpoint present')
"
```

Expected: `snippet ok: … patch(es), endpoint present`, plus an `env` descriptor `{ var, value, file: '.env.local', gitignore: true }` carrying the real API key.

**Step 3: Apply exactly as printed** — apply the `main.tsx` patch, write `.env.local` with the env var. Files touched: `src/main.tsx` (tracked — restored by git) and `.env.local` (untracked — deleted in cleanup).

**Step 4: Run Vite in the background** (strict port; managed PID)

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT/test-fixtures/react-app"
lsof -nP -iTCP:5199 -sTCP:LISTEN && { echo "5199 BUSY"; exit 1; } || true
nohup pnpm exec vite --port 5199 --strictPort > "$HOME/.opslane/smoke/vite.log" 2>&1 &
echo $! > "$HOME/.opslane/smoke/vite.pid"
for i in $(seq 1 30); do curl -sf http://localhost:5199/ >/dev/null && break; sleep 1; done
curl -sf -o /dev/null http://localhost:5199/ && echo "vite up (strict 5199)"
```

(No fixture-local `pnpm install` — the root frozen install in Task 3 already prepared the workspace. `--strictPort` means a busy port fails loudly instead of silently moving.)

**Step 5: Trigger the crash with network capture** (executable — runs from `test-e2e` so `@playwright/test` resolves):

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cat > "$HOME/.opslane/smoke/capture-event.mjs" <<'EOF'
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage();
const captured = [];
page.on('response', async (r) => {
  if (r.url().includes('/api/v1/events') && r.request().method() === 'POST') {
    captured.push({ url: r.url(), status: r.status(), body: await r.json().catch(() => null) });
  }
});
await page.goto('http://localhost:5199');
await page.click('[data-testid="nav-profile"]');
await page.click('[data-testid="load-profile-btn"]');
await page.waitForSelector('[data-testid="boundary-fallback"]');
await page.waitForTimeout(12000);  // SDK error flush is ~5-10s — 4s missed it in execution
await browser.close();
console.log(JSON.stringify(captured, null, 2));
const ok = captured.some(c => c.status === 202 && c.body?.event_id && c.body?.group_id);
if (!ok) { console.error('FAIL: no 202 /api/v1/events with event_id+group_id'); process.exit(1); }
console.error('CAPTURE OK');
EOF
# ESM resolves imports from the SCRIPT's location, not cwd — the script must
# live inside test-e2e/ for @opslane's @playwright/test to resolve (execution finding).
cp "$HOME/.opslane/smoke/capture-event.mjs" "$REPO_ROOT/test-e2e/.smoke-capture.mjs"
cd "$REPO_ROOT/test-e2e"
node .smoke-capture.mjs; RC=$?
rm -f .smoke-capture.mjs
exit $RC
```

Expected: `CAPTURE OK` with a JSON array showing `POST …/api/v1/events` → status **202**, body with `event_id` + `group_id`. Paste that (sanitized) into evidence — the DB count alone doesn't prove the HTTP contract. (First run may need `cd test-e2e && pnpm exec playwright install chromium`.)

**Step 6: DB checkpoint**

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
"$PSQL" "$SMOKE_DB" -c "SELECT count(*) FROM error_events"
```

Expected: ≥ 1.

---

## Task 6: `verify` + funnel — the two green lights

**Step 1: verify**

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT/test-fixtures/react-app"
node "$REPO_ROOT/cli/dist/index.js" verify --api-url http://localhost:8082 --repo "$SMOKE_REPO"
```

Expected JSON: `has_events: true`.

**Step 2: Funnel** — mint the admin JWT (dev secret, compose line 57) and read the overview:

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
TOKEN=$(python3 - <<'EOF'
import hmac, hashlib, base64, json, time
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
secret=b"opslane-dev-jwt-secret-key-minimum-32-bytes-long"
h=b64(b'{"alg":"HS256","typ":"JWT"}'); now=int(time.time())
p=b64(json.dumps({"sub":"00000000-0000-0000-0000-000000010000","org_id":"00000000-0000-0000-0000-000000000001","email":"admin@e2e.test","iat":now,"exp":now+3600}).encode())
print(h+"."+p+"."+b64(hmac.new(secret,(h+"."+p).encode(),hashlib.sha256).digest()))
EOF
)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8082/api/v1/admin/overview \
  | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['onboarding'], indent=2))"
```

Expected — **exactly**:

```json
{
  "started": 1,
  "auth_clicked": 1,
  "completed": 1,
  "key_claimed": 1,
  "first_event_received": 1,
  "failed": 0,
  "by_failure_reason": {}
}
```

Any other numbers = a real finding. Diagnose before touching anything (`superpowers:systematic-debugging`); fixes land as separate, minimal commits on this branch.

---

## Task 7: Cleanup (ordered — teardown before drop, unset before restore)

```bash
set -euo pipefail
source "$HOME/.opslane/smoke/pr6.env"
cd "$REPO_ROOT"
# 1. Stop Vite
[ -f "$HOME/.opslane/smoke/vite.pid" ] && kill "$(cat "$HOME/.opslane/smoke/vite.pid")" 2>/dev/null || true
rm -f "$HOME/.opslane/smoke/vite.pid"
# 2. Restore ONLY the recorded fixture files; remove generated ones
git checkout -- test-fixtures/react-app/src/main.tsx
rm -f test-fixtures/react-app/.env.local
git status --porcelain -- test-fixtures/react-app | grep . && echo "WARNING: fixture still dirty — inspect" || echo "fixture restored"
# 3. Stop ingestion BEFORE dropping its database (drop fails on live connections)
docker compose stop ingestion
"$PSQL" "$PG_ADMIN" -c "DROP DATABASE IF EXISTS opslane_smoke WITH (FORCE)"
# 4. Remove smoke capture files holding secrets (poll token, key material, snippet key)
rm -f "$HOME/.opslane/smoke/setup-start.json" "$HOME/.opslane/smoke/poll-1.json" "$HOME/.opslane/smoke/poll-2.json" "$HOME/.opslane/smoke/snippet.json"
```

Then restore the default stack from a **fresh shell that has NOT sourced the env file** (re-upping with smoke vars exported would silently keep App A creds, the admin allowlist, and the dead DB URL):

```bash
set -euo pipefail
cd /Users/abhishekray/orca/workspaces/opslane-oss/CLI-onboarding
unset OPSLANE_COMPOSE_DATABASE_URL OPSLANE_ADMIN_EMAILS GITHUB_APP_ID GITHUB_APP_CLIENT_ID \
      GITHUB_APP_CLIENT_SECRET GITHUB_APP_PRIVATE_KEY GITHUB_APP_SLUG INGESTION_PORT \
      AUTH_CALLBACK_ORIGIN AUTH_PROVIDER POLL_ID 2>/dev/null || true
docker compose up -d --wait --force-recreate ingestion
curl -sf http://localhost:8082/health
```

Local CLI leftovers: the smoke's record in `~/.opslane/agent-credentials.json` now holds a key pointing at a dropped database — remove it with the same surgical script as Task 3 Step 2.

**HUMAN (per design doc):** delete spike App B (`opslane-spike-b-2075`) at <https://github.com/settings/apps>; optionally uninstall App A from the smoke repo and delete the repo. App A and its preserved credentials stay (standing dev App — see policy decision in Context).

---

## Task 8: Evidence, docs, ship

**Step 1: Fill in the Evidence section below** — paste actual JSON (redact `poll_token` and `api_key` — hash prefixes only) for every row.

**Step 2: Design-doc updates** (`2026-07-18-agent-first-onboarding-design.md`):
- Mark the PR 6 section `**Status: done (2026-MM-DD)** — see 2026-07-18-agent-onboarding-pr6-live-smoke-plan.md`.
- Fix the stale header (line ~4): it still says only PR 1 landed — update to reflect PRs 1/2/4/5 merged (+6 when done); add status lines to the PR 2/4/5 sections pointing at their merged PRs (#112, #115, #117).
- In §Assets (line ~74), replace "delete after PR 6 or regenerate" with the standing-dev-App policy from this plan.

**Step 3: Gate + commit + PR**

Docs-only gate (plus any touched package's focused gate if fixes landed):

```bash
node scripts/check-docs-drift.mjs && node scripts/check-docs-scope.mjs
```

```bash
git add docs/plans/2026-07-18-agent-onboarding-pr6-live-smoke-plan.md docs/plans/2026-07-18-agent-first-onboarding-design.md
git commit -m "docs: PR 6 live end-to-end smoke — runbook + evidence, design status"
```

Push: agents are hook-blocked in this repo. In a Claude Code session the founder types `! git push -u origin abhishekray07/agent-live-smoke` (the `!` is Claude Code's run-in-session prefix, not shell syntax); in a plain terminal it's just `git push -u origin abhishekray07/agent-live-smoke`. Then `gh pr create` from the repo root.

PR body: link the loop steps to the evidence, state the funnel numbers, list any fixes that fell out.

---

## Evidence (execution of 2026-07-19 PDT / 2026-07-20 UTC)

| Step | Expected | Actual | Timestamp (UTC) |
| --- | --- | --- | --- |
| `setup --start` | 201 `auth_required`, `auth_url`, `poll_id` | ✅ `{"status":"auth_required","auth_url":"http://localhost:8082/agent/auth/3c8486d2-…","poll_id":"3c8486d2-138f-441b-9d15-224e2c3f113d","poll_token":"<redacted>"}`; DB: `pending \| clicked=f \| v2=t` | 04:49 |
| Human authorization | combined screen → success page | ✅ after one real retry (see Finding 1): "Done! Opslane is set up for **abhishekray07/opslane-smoke-fixture**." All four params (`code`, `installation_id=147720013`, `setup_action=install`, `state`) arrived at `/auth/github/callback` — Phase 0 contract held live | 04:57 |
| Raw HTTP poll ×2 | both `completed`, identical key (hash prefix) | ✅ `redelivery OK — both polls completed, identical key (sha256 prefix 565035a342683f19)` | 04:58 |
| CLI `setup --poll` | `completed`, credentials saved | ✅ `{"status":"completed","org_id":"32a46237-…","project_id":"92cfbff6-…","api_key":"<redacted sha256:565035a342683f19>"}` — same key hash as raw polls | 04:58 |
| Second CLI poll | local `not_found`, exit 1 | ✅ `{"status":"not_found","poll_id":"3c8486d2-…"}`, exit code 1 | 04:58 |
| Snippet | non-empty `main.tsx` patch + endpoint + `.env.local` | ✅ 1 patch, `file_path: "src/main.tsx"`, init uses `import.meta.env.VITE_OPSLANE_API_KEY` + `endpoint: 'http://localhost:8082'`; env → `.env.local` (`VITE_OPSLANE_API_KEY`, `<redacted>`) | 04:59 |
| Events POST | **202**, `event_id` + `group_id` (Playwright capture) | ✅ `[{"url":"http://localhost:8082/api/v1/events","status":202,"body":{"event_id":"31f1b337-…","group_id":"62532ffd-…","error_group_id":"62532ffd-…"}}]` — `CAPTURE OK` | 05:06 |
| `verify` | `has_events: true` | ✅ `{"status":"ok","api_reachable":true,"has_events":true,"message":"Connected. Events received."}` | 05:07 |
| Funnel | 1/1/1/1/1, failed 0 | ✅ `{"started":1,"auth_clicked":1,"completed":1,"key_claimed":1,"first_event_received":1,"failed":0,"by_failure_reason":{}}` — exact | 05:07 |

### Execution findings

1. **[Real catch] App A lacked the "Email addresses: Read-only" account permission.** First authorization attempt: code exchange succeeded, then the mandatory-identity email check failed → 502 and the human saw "GitHub check failed — could not load your GitHub email addresses. Reopen the authorization link to retry." The session correctly stayed `pending` (PR 1's transient-vs-definitive threat rule, observed working live). Fix: grant the permission in App settings, approve the permission update on the installation, reopen the same auth link — succeeded within the same session's 15-minute window. **Consequence: the production App's required-permissions list must include Email addresses: read; Appendix A already encodes it (`emails: read`).**
2. **[Runbook, fixed inline] Playwright capture script must live inside `test-e2e/`** — Node ESM resolves `@playwright/test` from the script's own directory, not cwd. And the SDK's error flush is ~5-10s, so the capture wait is 12s (4s missed the POST while `sessions/init` proved the SDK was alive).
3. **[Runbook, fixed inline] Snippet patch objects use `file_path`**, not `file`/`path`.
4. **[Environment quirk, out of scope] Replay chunk blob upload failed** (`POST http://localhost:9012/opslane-replays/ → ERR_ABORTED`): the MinIO presigned URL says port 9012 but this worktree's MinIO container was mapped to 19012 by an older session's override. Error-event ingestion and chunk `commit` (200) were unaffected. Worth a separate look at how the presign origin is derived for non-default MinIO ports.
5. **Fresh-install proof:** the smoke ran against installation `147720013`, newly created during the run (the stale spike installation `147489201` was deleted via the App API beforehand).

## Appendix A — Regenerating a dev App (only if App A's credentials are lost)

Manifest-flow, ~5 minutes, one human step. The Phase 0 capture server is preserved at `~/.opslane/dev-apps/manifest-capture.mjs` (copied by Task 0; it serves the manifest form and logs the redirect `code`). If that copy is also gone, any localhost HTTP server that (a) serves an auto-submitting form POSTing `manifest=<json>` to `https://github.com/settings/apps/new?state=<nonce>` and (b) logs the `code` query param on `/manifest-redirect` works.

Manifest JSON (note the field is **`default_permissions`**, and the callback identity check reads the user's email, so `emails: read` is required):

```json
{
  "name": "opslane-dev-<suffix>",
  "url": "http://localhost:8082",
  "redirect_url": "http://localhost:<capture-port>/manifest-redirect",
  "callback_urls": ["http://localhost:8082/auth/github/callback"],
  "hook_attributes": { "url": "https://example.com/opslane-dev-hook", "active": false },
  "request_oauth_on_install": true,
  "public": false,
  "default_permissions": { "contents": "read", "metadata": "read", "emails": "read" }
}
```

`hook_attributes.url` **must be a public URL even when inactive** — localhost is rejected (Phase 0 finding 3). The founder opens the form page, GitHub converts the manifest and redirects with a `code`; exchange within 1 hour: `curl -X POST https://api.github.com/app-manifests/<code>/conversions` → response contains `id`, `slug`, `client_id`, `client_secret`, `pem`, `webhook_secret`. Save that JSON to `~/.opslane/dev-apps/<slug>.json` (0600), update `~/.opslane/smoke/pr6.env` (Task 0 Step 2 regenerates it from the new file), and continue from Task 1 with the new slug in the settings URL.

## Out of scope (explicit)

- Failure-path smokes (`expired`, `repo_not_granted`, `installation_not_yours`, …) — covered by PR 1/2 automated tests; a live failure sweep is future work if the success loop exposes doubt.
- The worker/investigation pipeline — separate smoke (root `AGENTS.md` pipeline smoke).
- CI automation of this loop — it requires a human GitHub authorization by design.
