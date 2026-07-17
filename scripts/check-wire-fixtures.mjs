#!/usr/bin/env node
/**
 * Enforce that frozen wire fixtures under test-fixtures/wire/ are append-only.
 * Fails if a change modifies, deletes, renames, or type-changes an existing
 * fixture. Additions (and copies that preserve the source) are allowed. A
 * `contract-change` PR label bypasses this at the workflow level.
 *
 * Two input sources, one rule:
 *   - CI (PR_NUMBER set): read the PR's changed-file list from the GitHub API
 *     (`gh api repos/<repo>/pulls/<n>/files`). This is strictly metadata — the
 *     PR head is never fetched, checked out, or executed, so the check stays
 *     safe to run from the trusted base under pull_request_target.
 *   - Local (no PR_NUMBER): diff BASE_SHA...HEAD_SHA (defaults origin/main...HEAD)
 *     plus uncommitted changes under the guarded prefix.
 *
 * Usage: node scripts/check-wire-fixtures.mjs
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const GUARDED_PREFIX = 'test-fixtures/wire/';

// GitHub file statuses that never touch an existing frozen path: a new file, a
// copy (source preserved), or an unchanged entry. Anything else is inspected.
const SAFE_API_STATUSES = new Set(['added', 'copied', 'unchanged']);

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

/**
 * Pure: given the GitHub PR-files API shape (`[{status, filename,
 * previous_filename}]`), return the same human-readable violations. A rename is
 * a violation only when the *old* path was frozen (a frozen file disappearing);
 * a rename that lands a new file inside the prefix from outside is an addition.
 * Unknown statuses on a guarded path fail closed.
 */
export function findViolationsFromFiles(files, guarded = GUARDED_PREFIX) {
  const problems = [];
  for (const file of files) {
    const status = file.status;
    if (SAFE_API_STATUSES.has(status)) continue;

    if (status === 'renamed') {
      const from = file.previous_filename || '';
      if (from.startsWith(guarded)) problems.push(`${from} was renamed (fixtures are append-only)`);
      continue;
    }

    const path = file.filename || '';
    if (!path.startsWith(guarded)) continue;
    const verb = { modified: 'modified', removed: 'deleted', changed: 'type-changed' }[status] ?? `changed (${status})`;
    problems.push(`${path} was ${verb} (fixtures are append-only)`);
  }
  return problems;
}

function problemsFromApi(repo, prNumber) {
  // `--jq '.[]'` streams one compact JSON object per line across paginated
  // pages, avoiding any assumption about how gh concatenates array pages.
  const raw = execFileSync(
    'gh',
    ['api', '--paginate', `repos/${repo}/pulls/${prNumber}/files`, '--jq', '.[]'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const files = raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  return findViolationsFromFiles(files);
}

function problemsFromGit() {
  const base = process.env.BASE_SHA || 'origin/main';
  const head = process.env.HEAD_SHA || 'HEAD';
  let output = execFileSync('git', ['diff', '--name-status', `${base}...${head}`], { encoding: 'utf8' });
  if (!process.env.BASE_SHA && !process.env.HEAD_SHA) {
    output += execFileSync('git', ['diff', '--name-status', 'HEAD', '--', GUARDED_PREFIX], { encoding: 'utf8' });
  }
  return findViolations(output);
}

function main() {
  const prNumber = process.env.PR_NUMBER;
  const repo = process.env.GITHUB_REPOSITORY;
  let problems;
  try {
    problems = prNumber && repo ? problemsFromApi(repo, prNumber) : problemsFromGit();
  } catch (error) {
    if (prNumber && repo) {
      console.error(`Wire-fixture check could not read PR files (${repo}#${prNumber}): ${error.message}`);
      console.error('Ensure the workflow grants pull-requests: read and sets GH_TOKEN.');
    } else {
      console.error(`Wire-fixture check could not run git diff: ${error.message}`);
      console.error('In CI ensure PR_NUMBER and GITHUB_REPOSITORY are set for the API path.');
    }
    process.exit(1);
  }

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
