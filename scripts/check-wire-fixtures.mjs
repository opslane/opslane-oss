#!/usr/bin/env node
/**
 * Enforce that frozen wire fixtures under test-fixtures/wire/ are append-only.
 * Fails if a diff changes or removes an existing fixture. Additions are allowed.
 * A `contract-change` PR label bypasses this at the workflow level.
 *
 * Diffs BASE_SHA...HEAD_SHA (three-dot = merge base). Defaults suit local runs.
 *
 * Usage: node scripts/check-wire-fixtures.mjs
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const GUARDED_PREFIX = 'test-fixtures/wire/';

/**
 * Pure: given `git diff --name-status` output, return human-readable violations.
 * Any status other than an addition changes or removes at least one frozen path.
 */
export function findViolations(diffOutput, guarded = GUARDED_PREFIX) {
  const problems = [];
  for (const line of diffOutput.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0];
    const affected = parts.slice(1).filter((path) => path.startsWith(guarded));
    if (affected.length === 0 || status === 'A') continue;

    const verb = { M: 'modified', D: 'deleted', R: 'renamed', T: 'type-changed' }[status] ?? `changed (${parts[0]})`;
    for (const path of affected) {
      problems.push(`${path} was ${verb} (fixtures are append-only)`);
    }
  }
  return problems;
}

function main() {
  const base = process.env.BASE_SHA || 'origin/main';
  const head = process.env.HEAD_SHA || 'HEAD';
  let output;
  try {
    output = execFileSync('git', ['diff', '--name-status', `${base}...${head}`], { encoding: 'utf8' });
    if (!process.env.BASE_SHA && !process.env.HEAD_SHA) {
      output += execFileSync('git', ['diff', '--name-status', 'HEAD', '--', GUARDED_PREFIX], { encoding: 'utf8' });
    }
  } catch (error) {
    console.error(`Wire-fixture check could not run git diff (${base}...${head}): ${error.message}`);
    console.error('In CI ensure fetch-depth: 0 and that BASE_SHA/HEAD_SHA are set.');
    process.exit(1);
  }

  const problems = findViolations(output);
  if (problems.length > 0) {
    console.error('Wire-fixture immutability check FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    console.error('Frozen fixtures under test-fixtures/wire/ may only be ADDED, never');
    console.error('changed. If this edit is a deliberate, reviewed contract change, add');
    console.error('the `contract-change` label to the PR. See docs/contracts/events.md.');
    process.exit(1);
  }

  console.log(`Wire-fixture check OK: no changed fixtures under ${GUARDED_PREFIX}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
