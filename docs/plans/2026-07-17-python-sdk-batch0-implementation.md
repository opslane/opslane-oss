# Python SDK Batch 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold `packages/sdk-python` (PyPI package `opslane`) with CI + TestPyPI publishing, and run the E2B Python template spike that validates Batch 3's install-timeout budget. Closes issue #86.

**Architecture:** A stdlib-only Python package living beside the pnpm workspace (not a member of it), tested by a new SHA-pinned CI job on a 3.9/3.12 matrix and published via PyPI trusted publishing (OIDC) with build and publish in **separate jobs** — build-backend code never runs with the OIDC token, per PyPI's trusted-publisher security guidance. The spike builds the repo's first custom E2B template (with pytest preinstalled — Batch 3's test gate depends on it) and benchmarks sandbox boot + `pip install` + pytest against a complete fixture Flask app committed to the repo.

**Tech Stack:** Python 3.9+, hatchling (build backend), pytest, twine, GitHub Actions, E2B CLI (pinned) + `e2b@2.33.1` JS SDK (already a worker dependency).

**Design doc:** `docs/plans/2026-07-17-python-sdk-design.md`

**Steps that need the user (they hold the accounts):**
- Task 5: TestPyPI "pending publisher" for the `opslane` name, and merging the PR (workflow_dispatch only works once the workflow exists on `main`)
- Task 5: the production-PyPI name-claim decision (explicit risk, see task)
- Task 7: the E2B API key **for the team the production worker uses** (template names are team-local)
- `git push` throughout (repo hook blocks agent pushes)

---

### Task 1: Package skeleton with failing smoke tests

**Files:**
- Create: `packages/sdk-python/pyproject.toml`
- Create: `packages/sdk-python/LICENSE` (copy of `packages/sdk/LICENSE` — MIT)
- Create: `packages/sdk-python/README.md`
- Create: `packages/sdk-python/.gitignore`
- Create: `packages/sdk-python/opslane/__init__.py`
- Create: `packages/sdk-python/opslane/client.py`
- Create: `packages/sdk-python/opslane/transport.py`
- Create: `packages/sdk-python/opslane/context.py`
- Create: `packages/sdk-python/opslane/breadcrumbs.py`
- Create: `packages/sdk-python/opslane/integrations/__init__.py`
- Create: `packages/sdk-python/opslane/integrations/flask.py`
- Create: `packages/sdk-python/tests/test_package.py`

**Step 1: Create the directory and venv, install pytest**

```bash
mkdir -p packages/sdk-python && cd packages/sdk-python
python3 -m venv .venv
.venv/bin/pip install pytest
```

**Step 2: Write the failing smoke tests**

The public API **fails loudly** until Batch 1 — a silent no-op `init()` would let early adopters believe monitoring is active when nothing is captured.

`packages/sdk-python/tests/test_package.py`:

```python
"""Batch 0 smoke tests: the package exists, imports, exposes the public API,
and refuses to pretend it works. Behavior tests arrive in Batch 1."""
import importlib
import importlib.metadata

import pytest


def test_package_imports():
    mod = importlib.import_module("opslane")
    assert mod.__version__


def test_version_matches_distribution_metadata():
    import opslane

    assert opslane.__version__ == importlib.metadata.version("opslane")


def test_public_api_surface():
    import opslane

    for name in ("init", "set_user", "clear_user", "capture_exception", "flush"):
        assert callable(getattr(opslane, name)), f"opslane.{name} missing"


def test_api_fails_loudly_until_implemented():
    # Batch 0 publishes a scaffold. A silent no-op init() would give users a
    # false sense that monitoring is active; every entry point must raise.
    import opslane

    with pytest.raises(NotImplementedError):
        opslane.init(api_key="x")
    with pytest.raises(NotImplementedError):
        opslane.capture_exception(ValueError("x"))


def test_flask_integration_fails_loudly():
    from opslane.integrations.flask import OpslaneFlask

    with pytest.raises(NotImplementedError):
        OpslaneFlask(object())


def test_zero_runtime_dependencies():
    # The design guarantees stdlib-only. Assert it from distribution metadata
    # (module-import sniffing is weaker and affected by pytest plugins).
    reqs = importlib.metadata.requires("opslane") or []
    runtime = [r for r in reqs if "extra ==" not in r]
    assert runtime == [], f"unexpected runtime dependencies: {runtime}"
```

**Step 3: Run the tests to verify they fail**

```bash
cd packages/sdk-python && .venv/bin/pytest tests/ -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'opslane'`

**Step 4: Write `pyproject.toml`**

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "opslane"
version = "0.1.0a1"
description = "Opslane Python SDK: backend error capture for the Opslane error-resolution engine"
readme = "README.md"
license = "MIT"
license-files = ["LICENSE"]
requires-python = ">=3.9"
authors = [{ name = "Opslane" }]
classifiers = [
  "Development Status :: 3 - Alpha",
  "Intended Audience :: Developers",
  "Programming Language :: Python :: 3",
  "Programming Language :: Python :: 3.9",
  "Programming Language :: Python :: 3.10",
  "Programming Language :: Python :: 3.11",
  "Programming Language :: Python :: 3.12",
  "Topic :: Software Development :: Debuggers",
]
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8"]

[project.urls]
Homepage = "https://github.com/opslane/opslane-oss"
Repository = "https://github.com/opslane/opslane-oss"

[tool.hatch.build.targets.wheel]
packages = ["opslane"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

**Step 5: Write the module stubs**

`packages/sdk-python/opslane/__init__.py`:

```python
"""Opslane Python SDK.

Batch 0 scaffold: the public API surface exists but is NOT implemented.
Every entry point raises NotImplementedError so nobody ships this alpha
believing errors are being captured. Batch 1 (opslane-oss#87) implements
capture, context, and transport.
"""

__version__ = "0.1.0a1"

__all__ = ["init", "set_user", "clear_user", "capture_exception", "flush"]

_NOT_IMPLEMENTED = (
    "The opslane SDK is a pre-release scaffold; error capture is not "
    "implemented yet. Track progress: "
    "https://github.com/opslane/opslane-oss/issues/87"
)


def init(**kwargs):
    """Configure the SDK. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)


def set_user(user):
    """Attach user context to subsequent events. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)


def clear_user():
    """Clear user context. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)


def capture_exception(exc):
    """Capture a handled exception. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)


def flush(timeout=5.0):
    """Drain the event queue. Not implemented until Batch 1."""
    raise NotImplementedError(_NOT_IMPLEMENTED)
```

`client.py`, `transport.py`, `context.py`, `breadcrumbs.py` — each a one-line docstring stub, e.g.:

```python
"""Core client: builds payloads, manages state. Implemented in Batch 1 (#87)."""
```

`opslane/integrations/__init__.py`: empty.

`opslane/integrations/flask.py`:

```python
"""Flask integration. Implemented in Batch 1 (opslane-oss#87)."""


class OpslaneFlask:
    """Wraps a Flask app with Opslane error capture. Not yet implemented."""

    def __init__(self, app):
        raise NotImplementedError(
            "OpslaneFlask arrives in Batch 1: "
            "https://github.com/opslane/opslane-oss/issues/87"
        )
```

`README.md`: name, one-paragraph description, a prominent "**pre-release scaffold — every API raises NotImplementedError**, see opslane-oss#86–89", install command, MIT notice.

`packages/sdk-python/.gitignore`:

```
.venv/
dist/
*.egg-info/
__pycache__/
```

**Step 6: Install editable and run tests to verify they pass**

```bash
cd packages/sdk-python && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest tests/ -v
```

Expected: 6 passed

**Step 7: Commit**

```bash
git add packages/sdk-python
git commit -m "feat(sdk-python): scaffold opslane package (Batch 0, #86)"
```

---

### Task 2: Sanity-check the 3.9 floor locally

CI is the real 3.9 gate, but catch syntax issues before pushing.

**Step 1: Find a 3.9 interpreter and run the suite under it**

```bash
if command -v python3.9 >/dev/null; then
  python3.9 -m venv /tmp/ops39
  /tmp/ops39/bin/pip install -e 'packages/sdk-python[dev]'
  /tmp/ops39/bin/pytest packages/sdk-python/tests -v
elif command -v uv >/dev/null; then
  uv venv --python 3.9 /tmp/ops39
  uv pip install --python /tmp/ops39/bin/python -e 'packages/sdk-python[dev]'
  /tmp/ops39/bin/pytest packages/sdk-python/tests -v
else
  echo "no local 3.9 — CI matrix covers it"
fi
```

Expected: 6 passed (or the documented skip message)

No commit (nothing changed).

---

### Task 3: CI job — test matrix plus built-artifact validation

**Files:**
- Modify: `.github/workflows/ci.yml` (add `sdk-python` job; add it to `ci-ok.needs`)

**Step 1: Resolve the pinned SHA for actions/setup-python v6**

```bash
gh api repos/actions/setup-python/commits/v6 --jq .sha
```

Save the 40-char SHA. (`scripts/check-action-pins.mjs` fails CI on unpinned actions.)

**Step 2: Add the job**

After the `js:` job in `.github/workflows/ci.yml` (checkout SHA copied from the existing jobs). The 3.12 leg also validates the **built artifacts** — sdist and wheel build, `twine check` metadata, clean-venv installs from both, version/metadata equality — so packaging breaks surface in CI, not at publish time:

```yaml
  sdk-python:
    name: Python SDK tests (${{ matrix.python-version }})
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        python-version: ['3.9', '3.12']
    defaults:
      run:
        working-directory: packages/sdk-python
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false
      - uses: actions/setup-python@<SHA-FROM-STEP-1> # v6
        with:
          python-version: ${{ matrix.python-version }}
      - run: python -m pip install -e '.[dev]'
      - run: python -m pytest -v
      - name: Build and validate artifacts
        if: matrix.python-version == '3.12'
        run: |
          python -m pip install build twine
          python -m build
          python -m twine check --strict dist/*
          python -m venv /tmp/wheelcheck
          /tmp/wheelcheck/bin/pip install dist/*.whl
          /tmp/wheelcheck/bin/python -c "import opslane, importlib.metadata as md; assert opslane.__version__ == md.version('opslane'); print('wheel ok', opslane.__version__)"
          python -m venv /tmp/sdistcheck
          /tmp/sdistcheck/bin/pip install dist/*.tar.gz
          /tmp/sdistcheck/bin/python -c "import opslane; print('sdist ok', opslane.__version__)"
```

**Step 3: Gate the merge on it**

In the `ci-ok` job, extend:

```yaml
    needs: [go, js, compose, docker, e2e-keyless, reliability-system, security, sdk-python]
```

**Step 4: Verify pinning locally, and rehearse the artifact validation**

```bash
node scripts/check-action-pins.mjs
cd packages/sdk-python && .venv/bin/pip install build twine && .venv/bin/python -m build && .venv/bin/twine check --strict dist/*
```

Expected: pins pass; `dist/` contains `opslane-0.1.0a1.tar.gz` + `opslane-0.1.0a1-py3-none-any.whl`; twine reports PASSED for both.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: test and validate Python SDK on 3.9/3.12 (#86)"
```

---

### Task 4: `release-pypi.yml` — build and publish in separate jobs

The build backend (hatchling, plus anything `pyproject.toml` ever grows) is code we execute. It must never run in a job holding the OIDC token — PyPI's trusted-publisher security model explicitly recommends a two-job split. Batch 0 targets **TestPyPI only**; there is no production dropdown. The production path, when something real ships, gets its own workflow with a protected `pypi` environment.

**Files:**
- Create: `.github/workflows/release-pypi.yml`

**Step 1: Resolve pinned SHAs**

```bash
gh api repos/actions/setup-python/commits/v6 --jq .sha            # reuse from Task 3
gh api repos/actions/upload-artifact/commits/v4 --jq .sha
gh api repos/actions/download-artifact/commits/v4 --jq .sha
gh api repos/pypa/gh-action-pypi-publish/commits/release/v1 --jq .sha
```

**Step 2: Write the workflow**

```yaml
name: TestPyPI release

# Batch 0 (#86): manual publishes to TestPyPI only. Two-job split per PyPI's
# trusted-publisher security model: the build job executes the build backend
# with NO credentials; the publish job holds the OIDC token and runs nothing
# but artifact download + the publish action. Production PyPI will get its own
# workflow with a protected environment when there is something real to ship.

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    name: Build artifacts (credential-free)
    if: github.repository == 'opslane/opslane-oss'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false
      - uses: actions/setup-python@<SHA> # v6
        with:
          python-version: '3.12'
      - name: Build and validate sdist + wheel
        working-directory: packages/sdk-python
        run: |
          python -m pip install build twine
          python -m build
          python -m twine check --strict dist/*
      - uses: actions/upload-artifact@<SHA> # v4
        with:
          name: dist
          path: packages/sdk-python/dist/
          if-no-files-found: error

  publish:
    name: Publish to TestPyPI
    needs: [build]
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: testpypi
    permissions:
      id-token: write # PyPI Trusted Publishing (OIDC)
    steps:
      - uses: actions/download-artifact@<SHA> # v4
        with:
          name: dist
          path: dist/
      - uses: pypa/gh-action-pypi-publish@<SHA> # release/v1
        with:
          repository-url: https://test.pypi.org/legacy/
          packages-dir: dist/
```

**Step 3: Verify pinning**

```bash
node scripts/check-action-pins.mjs
```

Expected: exits 0.

**Step 4: Commit**

```bash
git add .github/workflows/release-pypi.yml
git commit -m "ci: TestPyPI release workflow, credential-isolated build (#86)"
```

---

### Task 5: Merge, publish to TestPyPI, verify — and decide on the production name

**Ordering constraint:** `workflow_dispatch` only works for workflows that exist on the **default branch**. So the PR merges first, then the workflow runs from `main`.

**USER ACTIONS — ask, in order:**

1. Create the pending publisher on TestPyPI (their account): https://test.pypi.org/manage/account/publishing/ → project `opslane`, owner `opslane`, repo `opslane-oss`, workflow `release-pypi.yml`, environment `testpypi` (must match the workflow's `environment:` exactly).
2. `! git push`, open the PR, confirm the `sdk-python` checks pass, merge.

**Agent, after merge:**

```bash
gh workflow run release-pypi.yml --ref main
gh run watch  # or poll gh run list --workflow=release-pypi.yml
```

Then verify the clean-venv install (TestPyPI can lag a minute after upload; retry once):

```bash
python3 -m venv /tmp/opslane-verify
/tmp/opslane-verify/bin/pip install -i https://test.pypi.org/simple/ opslane
/tmp/opslane-verify/bin/python -c "import opslane; print(opslane.__version__)"
```

Expected: `0.1.0a1`  ← acceptance criterion #1 of issue #86.

**Production name-claim decision (explicit, not accidental):** TestPyPI and PyPI are independent registries — completing this task does **not** reserve `opslane` on the real index; anyone can still take it. Options, to put to the user:
- **Accept the risk** until Batch 1 ships a real 0.1.0 (days-to-weeks of exposure), or
- **Claim it deliberately now**: add the production pending publisher, create a protected `pypi` environment (required reviewer: the user), add a separate `release-pypi-prod.yml`, and publish `0.1.0a1`. Safe to hold the name precisely because every API raises `NotImplementedError` — nobody can mistake it for a working SDK. Pip won't install pre-releases by default.

Record the choice in the PR or issue; don't resolve it by silently adding production publishing.

---

### Task 6: Representative Flask fixture app

The spike's benchmark target, committed so the numbers are reproducible — and reused by Batch 1 as the error-generating fixture and Batch 3 as the eval seed. It includes a real (tiny) pytest suite because Batch 3's test gate runs pytest, so the spike must too.

**Files:**
- Create: `test-fixtures/flask-app/app.py`
- Create: `test-fixtures/flask-app/requirements.txt`
- Create: `test-fixtures/flask-app/tests/test_health.py`
- Create: `test-fixtures/flask-app/README.md`

**Step 1: Write the fixture**

`requirements.txt` — deliberately includes C-extension packages (`psycopg2` non-binary builds against libpq; `cryptography` is a large wheel) because that's what the 300s budget must survive:

```
flask==3.0.3
flask-sqlalchemy==3.1.1
sqlalchemy==2.0.30
psycopg2==2.9.9
gunicorn==22.0.0
cryptography==42.0.8
alembic==1.13.1
python-dotenv==1.0.1
```

`app.py`:

```python
"""Fixture Flask app for the E2B install benchmark (Batch 0, #86), the
Batch 1 (#87) SDK smoke test, and Batch 3 (#89) evals. /boom raises
deliberately."""
from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/boom")
def boom():
    raise ValueError("seeded failure for SDK testing")
```

`tests/test_health.py`:

```python
from app import app


def test_health():
    client = app.test_client()
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}
```

`README.md`: two lines — what it's for, and that `requirements.txt` versions are pinned on purpose (benchmark reproducibility); don't bump casually.

**Step 2: Sanity-check app + tests in a throwaway venv**

```bash
python3 -m venv /tmp/flask-fix && /tmp/flask-fix/bin/pip install flask==3.0.3 pytest
cd test-fixtures/flask-app && /tmp/flask-fix/bin/python -m pytest -v
```

Expected: 1 passed

**Step 3: Commit**

```bash
git add test-fixtures/flask-app
git commit -m "test: add Flask fixture app for E2B benchmark and SDK testing (#86)"
```

---

### Task 7: Build the custom E2B Python template

**USER ACTION required — ownership matters, not just access:** E2B template names are **team-local**. A template built under a personal/dev team will not resolve for the production worker's credential. Ask the user:
1. Which E2B team does the production worker's `E2B_API_KEY` belong to?
2. Provide a key for **that team** (may be the same key), via `E2B_API_KEY` env or `e2b auth login`.

All template operations below run with that key, and Task 8's spike runs with the same key — which doubles as the proof that the worker's principal can create sandboxes from the template.

**Files:**
- Create: `packages/worker/e2b-python/e2b.Dockerfile`
- Create: `packages/worker/e2b-python/README.md`
- Created by the CLI: `packages/worker/e2b-python/e2b.toml` (commit it — it records the template ID)

**Step 1: Write the Dockerfile**

pytest is preinstalled and pinned: Batch 3's `runTestGate()` runs `pytest` after installing only the target repo's **runtime** requirements, which frequently omit test tooling. The template guarantees it exists.

```dockerfile
# Custom E2B template for the Python fix pipeline (Batch 3, opslane-oss#89).
# Python 3.12 + system deps from the design: build-essential (C extensions),
# libpq-dev (psycopg2), libffi-dev (cffi), git for repo clones.
# pytest is preinstalled because the Batch 3 test gate runs it against repos
# whose runtime requirements don't declare it.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev libffi-dev git curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pytest==8.2.2
```

`README.md`: what the template is for, which E2B team owns it, how to rebuild (the exact command below), and that `e2b.toml` holds the template ID Batch 3 will reference.

**Step 2: Build the template (pinned CLI, deliberate choice)**

The CLI is pinned — `@latest` in a build path is a supply-chain and repeatability hazard. We deliberately use the classic CLI + `e2b.toml` flow rather than E2B's newer SDK-based `Template` builder (which `e2b@2.33.1` also ships): the CLI flow leaves a committed `e2b.toml` artifact and needs no build script. Revisit if the CLI fights us — the SDK path is the documented successor.

```bash
cd packages/worker/e2b-python
pnpm dlx @e2b/cli@2.7.2 template build --name opslane-python --dockerfile e2b.Dockerfile
```

Expected: build succeeds; `e2b.toml` appears containing the template ID. If the CLI errors on auth or team, stop and resolve the team question with the user — don't retry blind.

**Step 3: Commit**

```bash
git add packages/worker/e2b-python
git commit -m "feat(worker): custom E2B Python template for the fix pipeline (#86)"
```

---

### Task 8: Benchmark spike — boot, install, import, pytest

**Files:**
- Create: `packages/worker/scripts/spike-python-sandbox.mjs`
- Create: `docs/plans/2026-07-17-e2b-python-spike-findings.md` (results)

**Step 1: Write the spike script**

Plain ESM using the worker's installed `e2b@2.33.1`. Three corrections baked in from review: the sandbox lifetime is set **above** the command timeout (default is 5 min — shorter than the 10-min install allowance, so the sandbox would die mid-install); `commands.run` **throws** `CommandExitError` on non-zero exit (a `result.exitCode !== 0` check is unreachable), so failures are handled in `catch`; and `kill()` lives in `finally` so no path leaks a sandbox.

```javascript
// Batch 0 spike (#86): measure E2B Python sandbox boot, pip install for the
// complete fixture Flask app, and the pytest gate Batch 3 will run.
// Findings gate Batch 3's 300s install budget.
// Run from packages/worker with the SAME E2B_API_KEY the production worker
// uses — this doubles as the template-ownership check (names are team-local).
import { Sandbox } from 'e2b';
import { readFileSync } from 'node:fs';

const TEMPLATE = 'opslane-python';
const FIXTURE = new URL('../../../test-fixtures/flask-app/', import.meta.url);
const FILES = ['app.py', 'requirements.txt', 'tests/test_health.py'];

let sbx;
try {
  const t0 = Date.now();
  // Lifetime must exceed the longest command timeout below (600s).
  sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 900_000 });
  console.log(`sandbox boot: ${Date.now() - t0}ms`);

  await sbx.commands.run('mkdir -p /home/user/fixture/tests');
  for (const f of FILES) {
    await sbx.files.write(
      `/home/user/fixture/${f}`,
      readFileSync(new URL(f, FIXTURE), 'utf8'),
    );
  }

  const t1 = Date.now();
  await sbx.commands.run(
    'cd /home/user/fixture && pip install --no-cache-dir -r requirements.txt',
    { timeoutMs: 600_000 },
  );
  console.log(`pip install: ${Date.now() - t1}ms`);

  for (const cmd of [
    'python -c "import flask, sqlalchemy, psycopg2; print(\'imports ok\')"',
    'cd /home/user/fixture && python -c "import app; print(\'app ok\')"',
    'python -m pytest --version',
    'cd /home/user/fixture && python -m pytest -v',
  ]) {
    const r = await sbx.commands.run(cmd, { timeoutMs: 120_000 });
    console.log(`$ ${cmd}\n${r.stdout.trim()}${r.stderr ? '\n' + r.stderr.trim() : ''}`);
  }
  console.log('SPIKE PASSED');
} catch (err) {
  // CommandExitError carries stdout/stderr/exitCode from the failed command.
  console.error('SPIKE FAILED:', err?.message ?? err);
  if (err?.stderr) console.error(String(err.stderr).slice(-3000));
  process.exitCode = 1;
} finally {
  await sbx?.kill();
}
```

**Step 2: Run it three times** (cold cache each time — E2B sandboxes are fresh):

```bash
cd packages/worker && node scripts/spike-python-sandbox.mjs
```

Expected per run: boot < 60000ms; install completes; `imports ok`, `app ok`, `pytest 8.2.2`, `1 passed`, `SPIKE PASSED`, exit code 0. Record all three boot/install times.

**Step 3: Write the findings doc**

`docs/plans/2026-07-17-e2b-python-spike-findings.md` — template ID (from `e2b.toml`) and owning E2B team, the three boot times, the three install times, pytest gate result, any failures and their fixes, and the verdict line the Batch 3 plan will cite: whether 300s covers `pip install` with headroom (design assumed 2–5 min for C extensions; say which end reality landed on).

**Step 4: Commit**

```bash
git add packages/worker/scripts/spike-python-sandbox.mjs docs/plans/2026-07-17-e2b-python-spike-findings.md
git commit -m "docs: E2B Python template spike findings (#86)"
```

---

### Task 9: Close out issue #86

**Step 1: Verify every acceptance criterion — after merge, not just branch-green**

The scaffold only counts as landed when it's on `main` with `main`'s checks green:

- [ ] PR merged; `sdk-python` job green on `main` for 3.9 and 3.12 (`gh run list --branch main --workflow CI`)
- [ ] TestPyPI install verified in a clean venv (Task 5 output — the publish itself already required merge)
- [ ] Sandbox boot < 60s across Task 8's three runs
- [ ] Benchmark + template ID + owning team documented (findings doc)
- [ ] Production name-claim decision recorded (Task 5)

**Step 2: Comment results on #86 and close**

```bash
gh issue comment 86 --repo opslane/opslane-oss --body "Batch 0 complete: boot <times>, install <times>, pytest gate passes in-template, template <id> (team <team>), TestPyPI publish verified from main. Findings: docs/plans/2026-07-17-e2b-python-spike-findings.md. Name-claim decision: <decision>."
gh issue close 86 --repo opslane/opslane-oss
```

Only after everything above is actually green — evidence before assertions.
