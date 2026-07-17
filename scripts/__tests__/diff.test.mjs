import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseNameStatusZ } from '../docs-sync/diff.mjs';

test('parseNameStatusZ handles modifies, adds, deletes, and renames', () => {
  const stream =
    [
      'M',
      'packages/sdk/src/core.ts',
      'A',
      'packages/sdk/src/new.ts',
      'D',
      'packages/sdk/src/gone.ts',
      'R096',
      'packages/sdk/src/old.ts',
      'packages/sdk/src/renamed.ts',
    ].join('\0') + '\0';

  assert.deepEqual(parseNameStatusZ(stream).sort(), [
    'packages/sdk/src/core.ts',
    'packages/sdk/src/gone.ts',
    'packages/sdk/src/new.ts',
    'packages/sdk/src/old.ts',
    'packages/sdk/src/renamed.ts',
  ]);
});

test('parseNameStatusZ includes both copy paths and removes duplicates', () => {
  const stream =
    [
      'C100',
      'packages/sdk/src/core.ts',
      'packages/sdk/src/core-copy.ts',
      'M',
      'packages/sdk/src/core.ts',
    ].join('\0') + '\0';

  assert.deepEqual(parseNameStatusZ(stream), [
    'packages/sdk/src/core.ts',
    'packages/sdk/src/core-copy.ts',
  ]);
});

test('parseNameStatusZ accepts a Buffer and an empty diff', () => {
  assert.deepEqual(parseNameStatusZ(Buffer.from('M\0path with spaces.ts\0')), [
    'path with spaces.ts',
  ]);
  assert.deepEqual(parseNameStatusZ(''), []);
});

test('parseNameStatusZ rejects truncated or unknown records', () => {
  assert.throws(() => parseNameStatusZ('M\0'), /missing path/i);
  assert.throws(() => parseNameStatusZ('R100\0old.ts\0'), /missing path/i);
  assert.throws(() => parseNameStatusZ('Q\0file.ts\0'), /unknown git status/i);
});
