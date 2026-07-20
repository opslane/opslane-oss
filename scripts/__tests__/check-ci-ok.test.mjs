import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verify, GATED, ALWAYS } from '../check-ci-ok.mjs';

const CLI = fileURLToPath(new URL('../check-ci-ok.mjs', import.meta.url));

const outputs = (over = {}) => ({
  go: 'false', js: 'false', python: 'false', e2e: 'false', reliability: 'false', ...over,
});

/** Builds a `needs` object where gated jobs skip unless their area is on. */
function needs({ areas = {}, results = {} } = {}) {
  const o = outputs(areas);
  const n = { changes: { result: 'success', outputs: o } };
  for (const [job, area] of Object.entries(GATED)) {
    n[job] = { result: results[job] ?? (o[area] === 'true' ? 'success' : 'skipped') };
  }
  for (const job of ALWAYS) {
    if (job === 'changes') continue;
    n[job] = { result: results[job] ?? 'success' };
  }
  return n;
}

const allOn = { go: 'true', js: 'true', python: 'true', e2e: 'true', reliability: 'true' };

// --- happy paths ---

test('all areas off, everything skipped as expected -> pass', () => {
  assert.deepEqual(verify(needs()), []);
});

test('all areas on and green -> pass', () => {
  assert.deepEqual(verify(needs({ areas: allOn })), []);
});

test('js-only (a docs PR) -> pass', () => {
  assert.deepEqual(verify(needs({ areas: { js: 'true' } })), []);
});

// --- both directions of the expectation check ---

test('a job that should have run but skipped -> fail', () => {
  const problems = verify(needs({ areas: { go: 'true' }, results: { go: 'skipped' } }));
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('job `go` was expected to run (go=true) but its result was skipped'), problems[0]);
});

test('a job that should have skipped but ran -> fail (filter drift)', () => {
  const problems = verify(needs({ results: { go: 'success' } }));
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('job `go` was expected to skip (go=false) but its result was success'), problems[0]);
});

test('a failing gated job -> fail', () => {
  const problems = verify(needs({ areas: { js: 'true' }, results: { js: 'failure' } }));
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('job `js` was expected to run'), problems[0]);
});

test('a cancelled gated job -> fail', () => {
  const problems = verify(needs({ areas: { e2e: 'true' }, results: { 'e2e-keyless': 'cancelled' } }));
  assert.ok(problems[0].includes('job `e2e-keyless` was expected to run'), problems[0]);
});

test('multiple problems are all reported, not just the first', () => {
  assert.equal(verify(needs({ results: { go: 'success', js: 'success' } })).length, 2);
});

// --- always-on jobs ---

test('an always-on job that skipped -> fail', () => {
  const problems = verify(needs({ results: { 'repo-checks': 'skipped' } }));
  assert.ok(problems[0].includes('always-on job `repo-checks` must succeed'), problems[0]);
});

test('a missing always-on job -> fail', () => {
  const n = needs();
  delete n.security;
  assert.ok(verify(n)[0].includes('always-on job `security` is missing from needs'), verify(n)[0]);
});

// --- the classifier itself must be trustworthy ---

test('a missing changes job -> fail', () => {
  const n = needs();
  delete n.changes;
  const problems = verify(n);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('needs is missing the `changes` job'), problems[0]);
});

test('a non-object needs value -> fail cleanly', () => {
  assert.deepEqual(verify(null), ['NEEDS must be a JSON object']);
  assert.deepEqual(verify([]), ['NEEDS must be a JSON object']);
});

test('a failed changes job -> fail, and nothing else is interpreted', () => {
  const n = needs();
  n.changes.result = 'failure';
  const problems = verify(n);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('`changes` did not succeed'), problems[0]);
});

for (const [label, value] of [['missing', undefined], ['empty', ''], ['non-literal', 'False']]) {
  test(`a ${label} area output -> fail`, () => {
    const n = needs();
    if (value === undefined) delete n.changes.outputs.go;
    else n.changes.outputs.go = value;
    const problems = verify(n);
    assert.ok(
      problems[0].includes('the `changes` output for area `go` must be the literal "true" or "false"'),
      problems[0],
    );
  });
}

// --- drift between ci.yml and this script ---

test('a missing gated job -> fail', () => {
  const n = needs();
  delete n.go;
  assert.ok(verify(n)[0].includes('gated job `go` is missing from needs'), verify(n)[0]);
});

test('an unknown job in needs -> fail', () => {
  const n = needs();
  n['brand-new-job'] = { result: 'success' };
  assert.ok(
    verify(n)[0].includes('job `brand-new-job` is in ci-ok.needs but check-ci-ok.mjs does not know it'),
    verify(n)[0],
  );
});

// --- the CLI wrapper ---

test('CLI exits 1 when NEEDS is unset', () => {
  const run = () => execFileSync(process.execPath, [CLI], { env: { ...process.env, NEEDS: '' }, encoding: 'utf8' });
  assert.throws(run, (error) => error.status === 1 && error.stderr.includes('NEEDS is not set'));
});

test('CLI exits 1 on malformed JSON', () => {
  const run = () => execFileSync(process.execPath, [CLI], { env: { ...process.env, NEEDS: '{oops' }, encoding: 'utf8' });
  assert.throws(run, (error) => error.status === 1 && error.stderr.includes('NEEDS is not valid JSON'));
});

test('CLI exits 1 on valid non-object JSON', () => {
  const run = () => execFileSync(process.execPath, [CLI], { env: { ...process.env, NEEDS: 'null' }, encoding: 'utf8' });
  assert.throws(run, (error) => error.status === 1 && error.stderr.includes('NEEDS must be a JSON object'));
});

test('CLI exits 1 and lists problems when verification fails', () => {
  const NEEDS = JSON.stringify(needs({ results: { go: 'success' } }));
  const run = () => execFileSync(process.execPath, [CLI], { env: { ...process.env, NEEDS }, encoding: 'utf8' });
  assert.throws(run, (error) => error.status === 1 && error.stderr.includes('was expected to skip'));
});

test('CLI exits 0 and says so when everything matches', () => {
  const NEEDS = JSON.stringify(needs({ areas: allOn }));
  const out = execFileSync(process.execPath, [CLI], { env: { ...process.env, NEEDS }, encoding: 'utf8' });
  assert.match(out, /ran or skipped exactly as/);
});
