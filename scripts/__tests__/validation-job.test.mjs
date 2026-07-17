import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { validateProposedDocs } from '../docs-sync/validation-job.mjs';

const HEAD_SHA = 'c'.repeat(40);
const DOC = 'docs/guides/react.md';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'docs-sync-pr-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stagingDir = join(root, 'staging');
  const checkoutRoot = join(root, 'pr');
  mkdirSync(join(stagingDir, dirname(DOC)), { recursive: true });
  mkdirSync(join(checkoutRoot, dirname(DOC)), { recursive: true });
  writeFileSync(join(stagingDir, DOC), '# Edited\n');
  writeFileSync(join(checkoutRoot, DOC), '# Original\n');
  return { root, stagingDir, checkoutRoot };
}

function inputs() {
  return {
    map: { matched: [DOC] },
    artifact: { headSha: HEAD_SHA, changed: [DOC], secretFingerprints: [] },
    headSha: HEAD_SHA,
    snippetManifest: { version: 1, documents: { [DOC]: { fences: [] } } },
    reportWarning: () => {},
  };
}

test('read-only validation overlays edits and uses PR-head SDK, fixtures, and site', (t) => {
  const dirs = fixture(t);
  const calls = [];
  const result = validateProposedDocs({
    ...dirs,
    ...inputs(),
    runner(command, args) {
      calls.push([command, ...args]);
      return '';
    },
    snippetRunner(options) {
      calls.push(['snippets']);
      assert.equal(options.checkoutRoot, dirs.checkoutRoot);
      assert.equal(options.fixtureRepoRoot, dirs.checkoutRoot);
      assert.equal(readFileSync(join(options.checkoutRoot, DOC), 'utf8'), '# Edited\n');
    },
    siteValidator({ checkoutRoot }) {
      calls.push(['site']);
      assert.equal(checkoutRoot, dirs.checkoutRoot);
    },
  });
  assert.equal(result.validated, true);
  assert.deepEqual(calls[0], ['pnpm', '--dir', dirs.checkoutRoot, '--filter', '@opslane/sdk', 'build']);
  assert.deepEqual(calls.slice(1), [['snippets'], ['site']]);
});

test('a PR-head validation failure rejects the job result', (t) => {
  const dirs = fixture(t);
  assert.throws(() => validateProposedDocs({
    ...dirs,
    ...inputs(),
    runner: () => '',
    snippetRunner: () => {},
    siteValidator: () => { throw new Error('broken PR-head link'); },
  }), /broken PR-head link/);
});

test('publish workflow depends on successful read-only validation', () => {
  const workflow = readFileSync(resolve('.github/workflows/docs-sync.yml'), 'utf8');
  assert.match(workflow, /validate:\n[\s\S]*?permissions:\n\s+contents: read/);
  assert.match(workflow, /publish:\n\s+needs: \[plan, validate\]/);
  assert.match(workflow, /needs\.validate\.result == 'success'/);
});
