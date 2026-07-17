# Python SDK Batch 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold `packages/sdk-python` (PyPI package `opslane`) with CI + TestPyPI publishing, and run the E2B Python template spike that validates Batch 3's install-timeout budget. Closes issue #86.

**Architecture:** A stdlib-only Python package living beside the pnpm workspace (not a member of it), tested by a new SHA-pinned CI job on a 3.9/3.12 matrix and published via PyPI trusted publishing (OIDC, mirroring `release-npm.yml`). The spike builds the repo's first custom E2B template and benchmarks `pip install` for a representative Flask app committed as a fixture.

**Tech Stack:** Python 3.9+, hatchling (build backend), pytest, GitHub Actions, E2B CLI + `e2b` JS SDK (already a worker dependency).

**Design doc:** `docs/plans/2026-07-17-python-sdk-design.md`

**Two steps need the user (they hold the accounts):**
- Task 5: creating the TestPyPI "pending publisher" for the `opslane` project name
- Task 7: an `E2B_API_KEY` for building the template
Everything else is autonomous. `git push` is also user-run (repo hook blocks agent pushes).

---

### Task 1: Package skeleton with a failing smoke test

**Files:**
- Create: `packages/sdk-python/pyproject.toml`
- Create: `packages/sdk-python/LICENSE` (copy of `packages/sdk/LICENSE` — MIT)
- Create: `packages/sdk-python/README.md`
- Create: `packages/sdk-python/opslane/__init__.py`
- Create: `packages/sdk-python/opslane/client.py`
- Create: `packages/sdk-python/opslane/transport.py`
- Create: `packages/sdk-python/opslane/context.py`
- Create: `packages/sdk-python/opslane/breadcrumbs.py`
- Create: `packages/sdk-python/opslane/integrations/__init__.py`
- Create: `packages/sdk-python/opslane/integrations/flask.py`
- Create: `packages/sdk-python/tests/test_package.py`

**Step 1: Create the venv and install pytest**

```bash
cd packages/sdk-python 2>/dev/null || mkdir -p packages/sdk-python && cd packages/sdk-python
python3 -m venv .venv
.venv/bin/pip install pytest
```

**Step 2: Write the failing smoke test**

`packages/sdk-python/tests/test_package.py`:

```python
"""Batch 0 smoke tests: the package exists, imports, and exposes the public API.

Behavior tests arrive in Batch 1; these only pin the surface so the scaffold
can be published and CI has something real to run.
"""
import importlib


def test_package_imports():
    mod = importlib.import_module("opslane")
    assert mod.__version__


def test_public_api_surface():
    import opslane

    for name in ("init", "set_user", "clear_user", "capture_exception", "flush"):
        assert callable(getattr(opslane, name)), f"opslane.{name} missing"


def test_flask_integration_importable():
    from opslane.integrations.flask import OpslaneFlask

    assert OpslaneFlask.__init__


def test_zero_runtime_dependencies():
    # The design guarantees stdlib-only. Importing opslane must not pull in
    # anything outside the standard library.
    import sys
    import opslane  # noqa: F401

    third_party = [
        m for m in sys.modules
        if m.split(".")[0] in {"requests", "urllib3", "flask", "httpx"}
    ]
    assert third_party == []
```

**Step 3: Run the test to verify it fails**

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

Batch 0 scaffold: the public API surface exists but does nothing yet.
Batch 1 (opslane-oss#87) implements capture, context, and transport.
"""

__version__ = "0.1.0a1"

__all__ = ["init", "set_user", "clear_user", "capture_exception", "flush"]


def init(**kwargs):
    """Configure the SDK. No-op until Batch 1."""


def set_user(user):
    """Attach user context to subsequent events. No-op until Batch 1."""


def clear_user():
    """Clear user context. No-op until Batch 1."""


def capture_exception(exc):
    """Capture a handled exception. No-op until Batch 1."""


def flush(timeout=5.0):
    """Drain the event queue. Returns True when the queue is empty.

    No-op until Batch 1; the empty queue is trivially drained.
    """
    return True
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
            "OpslaneFlask arrives in Batch 1 (opslane-oss#87)"
        )
```

`README.md`: name, one-paragraph description, "alpha — API not yet implemented, see opslane-oss#86–89", install command, MIT notice.

**Step 6: Install editable and run tests to verify they pass**

```bash
cd packages/sdk-python && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest tests/ -v
```

Expected: 4 passed

**Step 7: Keep the venv out of git**

Check root `.gitignore`; if `.venv/` isn't covered, add to `packages/sdk-python/.gitignore`:

```
.venv/
dist/
*.egg-info/
__pycache__/
```

**Step 8: Commit**

```bash
git add packages/sdk-python
git commit -m "feat(sdk-python): scaffold opslane package (Batch 0, #86)"
```

---

### Task 2: Sanity-check the 3.9 floor locally

CI is the real 3.9 gate, but catch syntax issues before pushing.

**Step 1: Try for a local 3.9**

```bash
command -v python3.9 || command -v uv
```

If `uv` exists: `uv venv --python 3.9 /tmp/ops39 && uv pip install --python /tmp/ops39/bin/python -e 'packages/sdk-python[dev]' && /tmp/ops39/bin/pytest packages/sdk-python/tests -v`
If neither exists: skip — note it, CI covers 3.9.

Expected: 4 passed (or documented skip)

No commit (nothing changed).

---

### Task 3: CI job on the 3.9/3.12 matrix

**Files:**
- Modify: `.github/workflows/ci.yml` (add `sdk-python` job; add it to `ci-ok.needs`)

**Step 1: Resolve the pinned SHA for actions/setup-python v6**

```bash
gh api repos/actions/setup-python/commits/v6 --jq .sha
```

Save the 40-char SHA. (`scripts/check-action-pins.mjs` fails CI on unpinned actions.)

**Step 2: Add the job**

After the `js:` job in `.github/workflows/ci.yml` (checkout SHA copied from the existing jobs):

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
```

**Step 3: Gate the merge on it**

In the `ci-ok` job, extend:

```yaml
    needs: [go, js, compose, docker, e2e-keyless, reliability-system, security, sdk-python]
```

**Step 4: Verify pinning locally**

```bash
node scripts/check-action-pins.mjs
```

Expected: exits 0.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run Python SDK pytest on 3.9 and 3.12 (#86)"
```

---

### Task 4: `release-pypi.yml` (TestPyPI via trusted publishing)

**Files:**
- Create: `.github/workflows/release-pypi.yml`

**Step 1: Resolve pinned SHAs**

```bash
gh api repos/actions/setup-python/commits/v6 --jq .sha           # reuse from Task 3
gh api repos/pypa/gh-action-pypi-publish/commits/release/v1 --jq .sha
```

**Step 2: Write the workflow**

Manual trigger for now (Batch 0 only proves the path; cadence comes later). Defaults to TestPyPI; `pypi` is an explicit choice.

```yaml
name: PyPI release

# Batch 0 (#86): manual publishes only, TestPyPI by default. Uses PyPI
# Trusted Publishing (OIDC) — no token exists anywhere, mirroring
# release-npm.yml. Automated cadence is a later decision.

on:
  workflow_dispatch:
    inputs:
      index:
        description: Target index
        type: choice
        options: [testpypi, pypi]
        default: testpypi

permissions:
  contents: read

jobs:
  publish:
    name: Build and publish to ${{ inputs.index }}
    if: github.repository == 'opslane/opslane-oss'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      id-token: write # PyPI Trusted Publishing (OIDC)
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false
      - uses: actions/setup-python@<SHA> # v6
        with:
          python-version: '3.12'
      - name: Build sdist and wheel
        working-directory: packages/sdk-python
        run: |
          python -m pip install build
          python -m build
      - name: Publish to TestPyPI
        if: inputs.index == 'testpypi'
        uses: pypa/gh-action-pypi-publish@<SHA> # release/v1
        with:
          repository-url: https://test.pypi.org/legacy/
          packages-dir: packages/sdk-python/dist
      - name: Publish to PyPI
        if: inputs.index == 'pypi'
        uses: pypa/gh-action-pypi-publish@<SHA> # release/v1
        with:
          packages-dir: packages/sdk-python/dist
```

**Step 3: Verify pinning + local build**

```bash
node scripts/check-action-pins.mjs
cd packages/sdk-python && .venv/bin/pip install build && .venv/bin/python -m build
ls dist/   # expect opslane-0.1.0a1.tar.gz and opslane-0.1.0a1-py3-none-any.whl
```

**Step 4: Commit**

```bash
git add .github/workflows/release-pypi.yml
git commit -m "ci: add manual PyPI release workflow with trusted publishing (#86)"
```

---

### Task 5: Publish to TestPyPI and verify clean-venv install

**USER ACTIONS required — ask, in order:**

1. Create the pending publisher on TestPyPI (needs their account): https://test.pypi.org/manage/account/publishing/ → project `opslane`, owner `opslane`, repo `opslane-oss`, workflow `release-pypi.yml`, environment blank. (Same later on pypi.org for the real index — not needed for Batch 0.)
2. `! git push` (repo hook blocks agent pushes), then merge the branch or run the workflow off this branch.
3. Trigger it: `gh workflow run release-pypi.yml --ref <branch> -f index=testpypi` (agent can run this once pushed).

**Verify (agent, after the run goes green):**

```bash
python3 -m venv /tmp/opslane-verify
/tmp/opslane-verify/bin/pip install -i https://test.pypi.org/simple/ opslane
/tmp/opslane-verify/bin/python -c "import opslane; print(opslane.__version__)"
```

Expected: `0.1.0a1`  ← acceptance criterion #1 of issue #86. (TestPyPI can lag a minute after upload; retry once before diagnosing.)

---

### Task 6: Representative Flask fixture app

The spike's benchmark target, committed so the numbers are reproducible — and reused by Batch 1 as the error-generating fixture.

**Files:**
- Create: `test-fixtures/flask-app/app.py`
- Create: `test-fixtures/flask-app/requirements.txt`
- Create: `test-fixtures/flask-app/README.md`

**Step 1: Write the fixture**

`requirements.txt` — deliberately includes C-extension packages (`psycopg2` non-binary builds against libpq; `cryptography` pulls a large wheel) because that's what the 300s budget must survive:

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
"""Fixture Flask app for the E2B install benchmark (Batch 0, #86) and the
Batch 1 (#87) SDK smoke test. /boom raises deliberately."""
from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/boom")
def boom():
    raise ValueError("seeded failure for SDK testing")
```

`README.md`: two lines — what it's for, and that `requirements.txt` versions are pinned on purpose (benchmark reproducibility); don't bump casually.

**Step 2: Sanity-check it imports** (venv from Task 1 lacks Flask — use a throwaway):

```bash
python3 -m venv /tmp/flask-fix && /tmp/flask-fix/bin/pip install flask==3.0.3 && cd test-fixtures/flask-app && /tmp/flask-fix/bin/python -c "import app; print('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add test-fixtures/flask-app
git commit -m "test: add Flask fixture app for E2B benchmark and SDK testing (#86)"
```

---### Task 7: Build the custom E2B Python template

**USER ACTION required:** an E2B API key with template-build rights (`E2B_API_KEY` env var, or `e2b auth login`). The worker's `.env` may already have one — ask.

**Files:**
- Create: `packages/worker/e2b-python/e2b.Dockerfile`
- Create: `packages/worker/e2b-python/README.md`
- Created by the CLI: `packages/worker/e2b-python/e2b.toml` (commit it — it records the template ID)

**Step 1: Write the Dockerfile**

```dockerfile
# Custom E2B template for the Python fix pipeline (Batch 3, opslane-oss#89).
# Python 3.12 + the system deps the design names: build-essential (C
# extensions), libpq-dev (psycopg2), libffi-dev (cffi). git for repo clones.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev libffi-dev git curl \
    && rm -rf /var/lib/apt/lists/*
```

**Step 2: Build the template**

```bash
cd packages/worker/e2b-python
pnpm dlx @e2b/cli@latest template build --name opslane-python --dockerfile e2b.Dockerfile
```

Expected: build succeeds, `e2b.toml` appears containing the template ID. If the CLI errors on auth, stop and ask the user for the key — don't retry blind.

**Step 3: Commit**

```bash
git add packages/worker/e2b-python
git commit -m "feat(worker): custom E2B Python template for the fix pipeline (#86)"
```

---

### Task 8: Benchmark spike — sandbox boot + pip install

**Files:**
- Create: `packages/worker/scripts/spike-python-sandbox.mjs`
- Create: `docs/plans/2026-07-17-e2b-python-spike-findings.md` (results)

**Step 1: Write the spike script**

Plain ESM, uses the worker's existing `e2b` dependency. Run from `packages/worker` so imports resolve.

```javascript
// Batch 0 spike (#86): measure E2B Python sandbox boot and pip install time
// for the fixture Flask app. Findings gate Batch 3's 300s install budget.
import { Sandbox } from 'e2b';
import { readFileSync } from 'node:fs';

const TEMPLATE = 'opslane-python';
const requirements = readFileSync(
  new URL('../../../test-fixtures/flask-app/requirements.txt', import.meta.url),
  'utf8',
);

const t0 = Date.now();
const sbx = await Sandbox.create(TEMPLATE);
const bootMs = Date.now() - t0;
console.log(`sandbox boot: ${bootMs}ms`);

await sbx.files.write('/tmp/requirements.txt', requirements);

const t1 = Date.now();
const result = await sbx.commands.run(
  'pip install --no-cache-dir -r /tmp/requirements.txt',
  { timeoutMs: 600_000 },
);
const installMs = Date.now() - t1;
console.log(`pip install: ${installMs}ms (exit ${result.exitCode})`);
if (result.exitCode !== 0) console.error(result.stderr.slice(-3000));

const check = await sbx.commands.run(
  'python -c "import flask, sqlalchemy, psycopg2; print(\'imports ok\')"',
);
console.log(check.stdout.trim());

await sbx.kill();
```

**Step 2: Run it three times** (cold cache each time — E2B sandboxes are fresh):

```bash
cd packages/worker && node scripts/spike-python-sandbox.mjs
```

Expected per run: boot < 60000ms, install exit 0, `imports ok`. Record all three boot/install times.

**Step 3: Write the findings doc**

`docs/plans/2026-07-17-e2b-python-spike-findings.md` — template ID (from `e2b.toml`), the three boot times, the three install times, any failures and their fixes, and the verdict line the Batch 3 plan will cite: whether 300s covers `pip install` with headroom (design assumed 2–5 min for C extensions; say which end reality landed on).

**Step 4: Commit**

```bash
git add packages/worker/scripts/spike-python-sandbox.mjs docs/plans/2026-07-17-e2b-python-spike-findings.md
git commit -m "docs: E2B Python template spike findings (#86)"
```

---

### Task 9: Close out issue #86

**Step 1: Verify every acceptance criterion**

- [ ] TestPyPI install works in a clean venv (Task 5 output)
- [ ] CI pytest green on 3.9 and 3.12 (check the pushed branch's checks: `gh pr checks` or `gh run list`)
- [ ] Sandbox boot < 60s (Task 8 numbers)
- [ ] Benchmark documented with template ID (findings doc)

**Step 2: Comment results on #86 and close**

```bash
gh issue comment 86 --repo opslane/opslane-oss --body "Batch 0 complete: <boot times>, <install times>, template <id>, TestPyPI publish verified. Findings: docs/plans/2026-07-17-e2b-python-spike-findings.md"
gh issue close 86 --repo opslane/opslane-oss
```

Only after everything above is actually green — evidence before assertions.
