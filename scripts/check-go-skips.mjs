#!/usr/bin/env node
/**
 * Enforce hard Go test results from `go test ./... -v` output:
 *   - no failed tests
 *   - no skipped tests except those matching an explicit allowlist
 *   - a minimum total test count (guards against building nothing)
 *
 * `go test` prints "ok" for a package in which every test called t.Skip, and
 * exits 0. The integration tests here skip when DATABASE_URL or
 * REPLAY_STORE_ENDPOINT is unset, so a misconfigured job reports success while
 * running nothing -- which is how the #47 and #48 regression guards sat unrun.
 * This makes that state loud. Mirrors scripts/check-e2e-results.mjs.
 *
 * Usage: node scripts/check-go-skips.mjs <go-test-verbose.log>
 * Env:
 *   GO_ALLOWED_SKIP_PATTERN  regex of test names allowed to skip (default: none)
 *   GO_MIN_TESTS             minimum passing tests (default: 100)
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: check-go-skips.mjs <go-test-verbose.log>');
  process.exit(2);
}

const log = readFileSync(file, 'utf8');
const allowedPattern = process.env.GO_ALLOWED_SKIP_PATTERN;
const allowed = allowedPattern ? new RegExp(allowedPattern) : null;
const minTests = Number(process.env.GO_MIN_TESTS ?? '100');

// `--- PASS: TestFoo (0.01s)` / `    --- SKIP: TestFoo/sub (0.00s)`
const RESULT = /^\s*--- (PASS|FAIL|SKIP): (\S+)/gm;

const problems = [];
let passed = 0;
let allowedSkips = 0;

for (const [, status, name] of log.matchAll(RESULT)) {
  if (status === 'PASS') {
    passed += 1;
  } else if (status === 'FAIL') {
    problems.push(`FAILED: ${name}`);
  } else if (allowed && allowed.test(name)) {
    allowedSkips += 1;
  } else {
    problems.push(`UNEXPECTED SKIP: ${name}`);
  }
}

if (passed < minTests) {
  problems.push(`Only ${passed} tests passed; expected at least ${minTests}`);
}

if (problems.length > 0) {
  console.error('Go result check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nA skip here usually means a service is missing (DATABASE_URL / REPLAY_STORE_ENDPOINT).\n' +
      'Fix the job so the test runs; do not add it to the allowlist to make this pass.'
  );
  process.exit(1);
}

console.log(
  `Go OK: ${passed} passed, ${allowedSkips} allowlisted skip(s), no failures, no unexpected skips.`
);
