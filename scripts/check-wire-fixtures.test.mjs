import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations } from './check-wire-fixtures.mjs';

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
