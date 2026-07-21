# E2B Python Template Spike Findings

**Status:** Complete — authenticated template builds and live benchmark runs
passed on 2026-07-17 and 2026-07-20.

This document records the evidence required to decide whether Batch 3 can use a
300-second `pip install` budget. The template was built and exercised with the
Opslane team's E2B credential, the same team scope the production worker must
use.

## Template

- Template name: `opslane-python`
- Template ID: `84c1j5abpjvqq2g5n5va`
- Current build ID: `c598ecc8-8d68-4b4c-a610-d776729c9235`
- Original 2026-07-17 build ID: `73c60796-1e6d-4cd2-9371-3bc689162e81`
- Owning E2B team: **Opslane**
  (`824cf00b-6c58-49e6-ae5f-a8419069a091`)
- Ownership proof: the selected Opslane team built the template, and its team
  API key successfully created all three live sandboxes by template name.

The pinned build command is documented in
`packages/worker/e2b-python/README.md`. The generated
`packages/worker/e2b-python/e2b.toml` records the same team and template IDs.

## Live runs

Run `node scripts/spike-python-sandbox.mjs` from `packages/worker` three times
with the production team's E2B credential. Each run uses a fresh sandbox.

| Run | Sandbox boot | `pip install` | Imports | pytest gate |
| --- | ---: | ---: | --- | --- |
| 1 | 3,048 ms | 21,921 ms | passed | pytest 8.2.2; 1 passed |
| 2 | 1,021 ms | 14,870 ms | passed | pytest 8.2.2; 1 passed |
| 3 | 1,203 ms | 15,148 ms | passed | pytest 8.2.2; 1 passed |

Evidence from every run:

- sandbox boot is below 60 seconds;
- Flask, SQLAlchemy, and psycopg2 import successfully;
- the fixture application imports successfully;
- the template reports pytest 8.2.2;
- the fixture test passes; and
- the script exits successfully after printing `SPIKE PASSED`.

## Batch 3 republish verification

The template was rebuilt and published on 2026-07-20 after adding `xz-utils`.
A fresh live sandbox created from `opslane-python` produced this evidence:

- sandbox boot: 794 ms;
- `pip install`: 18,646 ms;
- runtime: Python 3.12.13;
- pytest 8.2.2 collected and passed the fixture test;
- xz 5.8.1 was present; and
- pytest wrote `/tmp/opslane-junit.xml`, which was read back successfully.

The live script ended with `SPIKE PASSED`.

## Failures and fixes

The first benchmark invocation failed before sandbox creation because the E2B
CLI login and the JavaScript SDK have separate credential inputs: CLI auth was
valid, but `e2b@2.33.1` correctly required `E2B_API_KEY`. Rerunning with the
selected team's key injected into the benchmark process fixed the issue. The
key was neither printed nor persisted in the repository.

The pinned CLI also warned that its v1 Dockerfile/`e2b.toml` build flow is
deprecated in favor of E2B's v2 template builder. The planned v1 flow still
built and ran successfully; migration is a future maintenance concern, not a
Batch 0 blocker.

## Batch 3 verdict

**300 seconds covers `pip install` with substantial headroom.** The slowest of
three installs was 21.921 seconds, leaving about 278 seconds (over 12x the
observed maximum) before the proposed timeout. Reality landed well below the
design's assumed 2–5 minute range even with the fixture's C-extension and large
wheel dependencies. The slowest sandbox boot was 3.048 seconds, also far below
the 60-second acceptance limit.
