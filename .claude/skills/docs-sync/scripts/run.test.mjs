import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { globToRegExp } from '../../../../scripts/docs-map.mjs';
import { diffForDoc, resolveBase, runClaude, runMapper } from './run.mjs';

test('resolveBase prefers the remote default branch over a feature upstream', () => {
  const calls = [];
  const fakeGit = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'merge-base' && args[1] === '@{upstream}') return 'feature-base\n';
    if (args[0] === 'symbolic-ref') return 'origin/trunk\n';
    if (args[0] === 'merge-base' && args[1] === 'origin/trunk') return 'default-base\n';
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };

  assert.equal(resolveBase('/repo', fakeGit), 'default-base');
  assert.deepEqual(calls.slice(0, 3), [
    'merge-base @{upstream} HEAD',
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD',
    'merge-base origin/trunk HEAD',
  ]);
});

test('runMapper passes the deterministic changed-path list to the shared mapper', () => {
  const mapped = runMapper('/repo', ['packages/sdk/src/react.tsx'], (_command, _args, options) => {
    assert.equal(options.input, 'packages/sdk/src/react.tsx\n');
    return {
      status: 0,
      stdout: '{"matched":["docs/guides/react.md"],"uncovered":[]}',
      stderr: '',
    };
  });

  assert.deepEqual(mapped, {
    matched: ['docs/guides/react.md'],
    uncovered: [],
  });
});

test('diffForDoc includes matched untracked file contents as added-file context', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-sync-test-'));
  try {
    mkdirSync(join(root, 'packages/sdk/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/sdk/src/new-feature.ts'),
      "export const newFeature = 'wip';\n",
    );
    const diff = diffForDoc(
      root,
      'base-sha',
      'docs/architecture/overview.md',
      ['packages/sdk/src/new-feature.ts'],
      [{ path: 'docs/architecture/overview.md', covers: ['packages/sdk/**'] }],
      globToRegExp,
      () => 'tracked diff',
    );

    assert.match(diff, /tracked diff/);
    assert.match(diff, /new file \(untracked working tree\)/);
    assert.match(diff, /packages\/sdk\/src\/new-feature\.ts/);
    assert.match(diff, /export const newFeature = 'wip'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runClaude disables all tools and returns schema-validated content', () => {
  let invocation;
  const content = runClaude('docs/guides/react.md', '# React\n', '+ changed code', (command, args, options) => {
    invocation = { command, args, options };
    return {
      status: 0,
      stdout: JSON.stringify({
        is_error: false,
        structured_output: { content: '# React updated\n', changed: true },
      }),
    };
  });

  assert.equal(invocation.command, 'claude');
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf('--tools'), invocation.args.indexOf('--tools') + 2),
    ['--tools', ''],
  );
  assert.equal(invocation.args.some((arg) => arg.includes('Bash')), false);
  assert.equal(invocation.args.includes('--safe-mode'), true);
  assert.equal(invocation.args.includes('--strict-mcp-config'), true);
  assert.equal(invocation.args.includes('--setting-sources'), true);
  assert.match(invocation.options.input, /<document>\n# React/);
  assert.match(invocation.options.input, /<code_diff>\n\+ changed code/);
  assert.equal(content, '# React updated\n');
});
