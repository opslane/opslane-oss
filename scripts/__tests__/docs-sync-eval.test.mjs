import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EVAL_MODELS, REPEATED_RUN_POLICY, THRESHOLDS } from '../docs-sync/eval/config.mjs';
import {
  aggregateRuns,
  buildReport,
  compareToBaseline,
  loadCorpus,
  scoreRun,
  thresholdResults,
} from '../docs-sync/eval/evaluate.mjs';
import { runLiveEvaluation } from '../docs-sync/eval/live-eval.mjs';
import { validateEvalOutput } from '../docs-sync/eval/validate-output.mjs';
import { CLAUDE_MODEL } from '../docs-sync/plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(HERE, '../docs-sync/eval/reports/2026-07-17-baseline.json');

function successfulValidation(fixture) {
  return {
    runnableSnippetPass: Boolean(fixture.expected.runnableManifest),
    commandValidityPass: Boolean(fixture.expected.commandFences),
    mermaidParsePass: Boolean(fixture.expected.expectMermaid),
    diagramMatchesProse: Boolean(fixture.expected.diagramGoldenExact),
    normativeWordingPreserved: Boolean(fixture.expected.normativeLines),
  };
}

function idealOutput(fixture) {
  return {
    changed: fixture.expected.changed,
    content: fixture.expected.exactContent ?? fixture.recordedOutput.content,
  };
}

test('evaluation config pins the editor and predeclares thresholds and repetition', () => {
  assert.equal(EVAL_MODELS.editor, CLAUDE_MODEL);
  assert.equal(EVAL_MODELS.judge, null);
  assert.deepEqual(REPEATED_RUN_POLICY, {
    runsPerCase: 3,
    safetyAggregation: 'worst-of-N',
    qualityAggregation: 'mean-of-N',
  });
  assert.equal(THRESHOLDS.shared.staleFixRate.minimum, 1);
  assert.equal(THRESHOLDS.shared.falseEditRate.maximum, 0);
  assert.equal(THRESHOLDS.setup.runnableSnippetPassRate.minimum, 1);
  assert.equal(THRESHOLDS.internals.mermaidParsePassRate.minimum, 1);
  assert.equal(THRESHOLDS.contract.normativeWordingPreservedRate.minimum, 1);
});

test('recorded issue #83 outputs capture one asserted fix and two forbidden false edits', () => {
  const corpus = loadCorpus();
  const recordedCases = corpus.cases.filter((fixture) => fixture.recordedOutput);
  const recordedCorpus = { ...corpus, cases: recordedCases };
  const outputs = Object.fromEntries(recordedCases.map((fixture) => [fixture.id, fixture.recordedOutput]));
  const validations = {
    'react-on-error': { runnableSnippetPass: true, commandValidityPass: true },
    'overview-no-change': { mermaidParsePass: true, diagramMatchesProse: false },
    'trust-no-change': {},
  };
  const scores = scoreRun(recordedCorpus, outputs, validations);

  assert.equal(scores.find((score) => score.id === 'react-on-error').staleFixed, true);
  assert.equal(scores.find((score) => score.id === 'overview-no-change').falseEdit, true);
  assert.equal(scores.find((score) => score.id === 'overview-no-change').forbiddenAssertionPass, false);
  assert.equal(scores.find((score) => score.id === 'trust-no-change').falseEdit, true);

  const checks = thresholdResults(aggregateRuns([scores]));
  assert.equal(checks.find((check) => check.metric === 'falseEditRate').pass, false);
});

test('exact/required/forbidden fixture assertions pass for ideal outputs', () => {
  const corpus = loadCorpus();
  const idealOutputs = Object.fromEntries(corpus.cases.map((fixture) => [fixture.id, idealOutput(fixture)]));
  const validations = Object.fromEntries(corpus.cases.map((fixture) => [
    fixture.id,
    successfulValidation(fixture),
  ]));
  const scores = scoreRun(corpus, idealOutputs, validations);
  assert.ok(scores.every((score) => score.exactAssertionPass));
  assert.ok(scores.every((score) => score.requiredAssertionPass));
  assert.ok(scores.every((score) => score.forbiddenAssertionPass));

  const report = buildReport({
    corpus,
    scoredRuns: [scores, scores, scores],
    generatedAt: '2026-07-17T00:00:00.000Z',
    source: { kind: 'test' },
  });
  assert.equal(report.repeatedRunPolicySatisfied, true);
  assert.equal(report.promotionEligible, true);
});

test('live harness applies the repeated-run policy without requiring network in tests', async () => {
  const corpus = loadCorpus();
  let calls = 0;
  const report = await runLiveEvaluation({
    corpus,
    now: new Date('2026-07-17T12:00:00.000Z'),
    runClaude: async ({ docPath, prompt }) => {
      calls += 1;
      const fixture = corpus.cases.find((candidate) => candidate.docPath === docPath);
      assert.match(prompt, /public documentation site/);
      return idealOutput(fixture);
    },
    validateOutput: async (fixture) => successfulValidation(fixture),
  });
  assert.equal(calls, corpus.cases.length * REPEATED_RUN_POLICY.runsPerCase);
  assert.equal(report.runCount, 3);
  assert.equal(report.baseline.comparison.hasImprovement, true);
  assert.equal(report.baseline.comparison.hasRegression, false);
  assert.equal(report.promotionEligible, true);
});

test('stored dated baseline is explicit about the historical unpinned single run', () => {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const corpus = loadCorpus();
  const recordedCases = corpus.cases.filter((fixture) => fixture.recordedOutput);
  const recordedCorpus = { ...corpus, cases: recordedCases };
  const recordedScores = scoreRun(
    recordedCorpus,
    Object.fromEntries(recordedCases.map((fixture) => [fixture.id, fixture.recordedOutput])),
    {
      'react-on-error': { runnableSnippetPass: true, commandValidityPass: true },
      'overview-no-change': { mermaidParsePass: true, diagramMatchesProse: false },
      'trust-no-change': {},
    },
  );
  assert.equal(baseline.corpus, 'issue-83');
  assert.equal(baseline.source.kind, 'recorded-issue-83');
  assert.equal(baseline.repeatedRunPolicySatisfied, false);
  assert.equal(baseline.metrics.shared.falseEditRate, 1);
  assert.deepEqual(baseline.metrics, aggregateRuns([recordedScores]));
  assert.equal(baseline.promotionEligible, false);
});

test('baseline comparison rejects regressions even when another metric improves', () => {
  const baseline = {
    shared: { staleFixRate: 0.5, falseEditRate: 0.5 },
    setup: {}, internals: {}, contract: {},
  };
  const comparison = compareToBaseline({
    shared: { staleFixRate: 1, falseEditRate: 1 },
    setup: {}, internals: {}, contract: {},
  }, baseline);
  assert.equal(comparison.hasImprovement, true);
  assert.equal(comparison.hasRegression, true);
});

test('a changed:false transport-only trailing newline is not a false edit', () => {
  const corpus = loadCorpus();
  const fixture = corpus.cases.find(({ id }) => id === 'trust-no-change');
  const scores = scoreRun(
    { ...corpus, cases: [fixture] },
    { [fixture.id]: { changed: false, content: `${fixture.original}\n` } },
  );
  assert.equal(scores[0].falseEdit, false);
  assert.equal(scores[0].exactAssertionPass, true);
});

test('output validation executes commands and runnable setup snippets', async () => {
  const corpus = loadCorpus();
  const fixture = corpus.cases.find(({ id }) => id === 'react-on-error');
  const valid = await validateEvalOutput(fixture, fixture.recordedOutput);
  assert.equal(valid.commandValidityPass, true);
  assert.equal(valid.runnableSnippetPass, true);

  const invalid = await validateEvalOutput(fixture, {
    ...fixture.recordedOutput,
    content: fixture.recordedOutput.content.replace(
      "import { OpslaneErrorBoundary } from '@opslane/sdk/react';",
      "import { MissingExport } from '@opslane/sdk/react';",
    ),
  });
  assert.equal(invalid.runnableSnippetPass, false);

  const badCommandFixture = structuredClone(fixture);
  badCommandFixture.expected.commandFences = ['if then'];
  const badCommand = await validateEvalOutput(badCommandFixture, {
    ...fixture.recordedOutput,
    content: fixture.recordedOutput.content.replace(
      'npm install @opslane/sdk',
      'if then',
    ),
  });
  assert.equal(badCommand.commandValidityPass, false);
});

test('output validation parses Mermaid and compares the diagram with its golden prose contract', async () => {
  const corpus = loadCorpus();
  const fixture = corpus.cases.find(({ id }) => id === 'overview-no-change');
  const valid = await validateEvalOutput(fixture, idealOutput(fixture));
  assert.equal(valid.mermaidParsePass, true);
  assert.equal(valid.diagramMatchesProse, true);

  const invalid = await validateEvalOutput(fixture, {
    changed: true,
    content: fixture.original.replace('ING --> PG', 'ING -->'),
  });
  assert.equal(invalid.mermaidParsePass, false);
  assert.equal(invalid.diagramMatchesProse, false);
});

test('output validation preserves exact normative contract lines', async () => {
  const corpus = loadCorpus();
  const fixture = corpus.cases.find(({ id }) => id === 'events-contract-no-change');
  const valid = await validateEvalOutput(fixture, idealOutput(fixture));
  assert.equal(valid.normativeWordingPreserved, true);

  const weakened = await validateEvalOutput(fixture, {
    changed: true,
    content: fixture.original.replace('must never become required', 'should remain optional'),
  });
  assert.equal(weakened.normativeWordingPreserved, false);
});
