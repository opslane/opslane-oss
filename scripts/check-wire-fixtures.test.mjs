import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations, findViolationsFromFiles } from './check-wire-fixtures.mjs';

test('additions are allowed', () => {
  const diff = 'A\ttest-fixtures/wire/events/v1.1.0-minimal.json';
  assert.deepEqual(findViolations(diff), []);
});

test('modifying an existing fixture fails', () => {
  const diff = 'M\ttest-fixtures/wire/events/v1.0.0-minimal.json';
  assert.equal(findViolations(diff).length, 1);
  assert.match(findViolations(diff)[0], /was modified/);
});

test('deleting an existing fixture fails', () => {
  const diff = 'D\ttest-fixtures/wire/events/v1.0.0-full.json';
  assert.match(findViolations(diff)[0], /was deleted/);
});

test('renaming an existing fixture fails', () => {
  const diff = 'R100\ttest-fixtures/wire/events/v1.0.0-full.json\ttest-fixtures/wire/events/renamed.json';
  assert.match(findViolations(diff)[0], /was renamed/);
});

test('type-changing an existing fixture fails', () => {
  const diff = 'T\ttest-fixtures/wire/events/v1.0.0-full.json';
  assert.match(findViolations(diff)[0], /was type-changed/);
});

test('changes outside the guarded prefix are ignored', () => {
  const diff = 'M\tpackages/sdk/src/core.ts\nA\ttest-fixtures/wire/events/v1.2.0-full.json';
  assert.deepEqual(findViolations(diff), []);
});

// --- API path (GitHub PR-files shape) ---

const F = (status, filename, previous_filename) => ({ status, filename, previous_filename });

test('API: added / copied / unchanged fixtures are allowed', () => {
  const files = [
    F('added', 'test-fixtures/wire/events/v1.1.0-minimal.json'),
    F('copied', 'test-fixtures/wire/events/v1.1.0-full.json', 'test-fixtures/wire/events/v1.0.0-full.json'),
    F('unchanged', 'test-fixtures/wire/events/v1.0.0-minimal.json'),
  ];
  assert.deepEqual(findViolationsFromFiles(files), []);
});

test('API: modifying an existing fixture fails', () => {
  const problems = findViolationsFromFiles([F('modified', 'test-fixtures/wire/events/v1.0.0-minimal.json')]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /was modified/);
});

test('API: removing an existing fixture fails', () => {
  assert.match(findViolationsFromFiles([F('removed', 'test-fixtures/wire/events/v1.0.0-full.json')])[0], /was deleted/);
});

test('API: renaming a frozen file away fails (old path was frozen)', () => {
  const files = [F('renamed', 'test-fixtures/wire/events/renamed.json', 'test-fixtures/wire/events/v1.0.0-full.json')];
  assert.match(findViolationsFromFiles(files)[0], /v1\.0\.0-full\.json was renamed/);
});

test('API: renaming an outside file INTO the prefix is an addition, allowed', () => {
  const files = [F('renamed', 'test-fixtures/wire/events/v2.0.0-full.json', 'drafts/candidate.json')];
  assert.deepEqual(findViolationsFromFiles(files), []);
});

test('API: type-changed frozen fixture fails', () => {
  assert.match(findViolationsFromFiles([F('changed', 'test-fixtures/wire/events/v1.0.0-full.json')])[0], /was type-changed/);
});

test('API: changes outside the guarded prefix are ignored', () => {
  const files = [F('modified', 'packages/sdk/src/core.ts'), F('added', 'test-fixtures/wire/events/v1.2.0-full.json')];
  assert.deepEqual(findViolationsFromFiles(files), []);
});

test('API: unknown status on a guarded path fails closed', () => {
  const problems = findViolationsFromFiles([F('mangled', 'test-fixtures/wire/events/v1.0.0-full.json')]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /changed \(mangled\)/);
});
