#!/usr/bin/env node
/**
 * Enforce hard E2E results from a vitest JSON report:
 *   - no failed tests
 *   - no skipped/todo tests except those matching an explicit allowlist
 *   - a minimum total test count (guards against filtering everything out)
 *
 * Usage: node scripts/check-e2e-results.mjs <vitest-results.json>
 * Env:
 *   E2E_ALLOWED_SKIP_PATTERN  regex of fully-qualified test names allowed to
 *                             skip (default: none)
 *   E2E_MIN_TESTS             minimum numTotalTests (default: 10)
 *   E2E_REQUIRED_PATTERNS     newline-separated regexes; each must match at
 *                             least one PASSED fully-qualified test name, so
 *                             named suites cannot be deleted or filtered out
 *                             without failing the check (default: none)
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: check-e2e-results.mjs <vitest-results.json>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, 'utf8'));
const allowedPattern = process.env.E2E_ALLOWED_SKIP_PATTERN;
const allowed = allowedPattern ? new RegExp(allowedPattern) : null;
const minTests = Number(process.env.E2E_MIN_TESTS ?? '10');
const requiredPatterns = (process.env.E2E_REQUIRED_PATTERNS ?? '')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => new RegExp(p));

const problems = [];
const passedNames = [];
let passed = 0;
let allowedSkips = 0;

for (const tf of report.testResults ?? []) {
  for (const t of tf.assertionResults ?? []) {
    const name = [...(t.ancestorTitles ?? []), t.title].join(' > ');
    if (t.status === 'passed') {
      passed += 1;
      passedNames.push(name);
    } else if (t.status === 'failed') {
      problems.push(`FAILED: ${name}`);
    } else if (allowed && allowed.test(name)) {
      allowedSkips += 1;
    } else {
      problems.push(`UNEXPECTED ${String(t.status).toUpperCase()}: ${name}`);
    }
  }
}

const total = report.numTotalTests ?? 0;
if (total < minTests) {
  problems.push(`Only ${total} tests were collected; expected at least ${minTests}`);
}
for (const re of requiredPatterns) {
  if (!passedNames.some((name) => re.test(name))) {
    problems.push(`REQUIRED TEST MISSING: no passed test matches ${re}`);
  }
}
if (report.success === false && problems.length === 0) {
  problems.push('vitest reported overall failure');
}

if (problems.length > 0) {
  console.error('E2E result check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `E2E OK: ${passed}/${total} passed, ${allowedSkips} allowlisted skip(s), no failures, no unexpected skips.`
);
