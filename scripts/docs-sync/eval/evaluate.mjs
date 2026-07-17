import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedLineCount } from '../validation.mjs';
import { REPEATED_RUN_POLICY, THRESHOLDS } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS_PATH = resolve(HERE, 'fixtures/issue-83.json');
export const DEFAULT_BASELINE_PATH = resolve(HERE, 'reports/2026-07-17-baseline.json');

const JARGON = /\b(?:best-in-class|cutting-edge|game-changing|leverage|seamless|synergy|utilize)\b|it is important to note/iu;

export function loadCorpus(path = DEFAULT_CORPUS_PATH) {
  const corpus = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new Error('evaluation corpus must contain cases');
  }
  return corpus;
}

export function loadBaseline(path = DEFAULT_BASELINE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function allIncluded(content, values = []) {
  return values.every((value) => content.includes(value));
}

function allExcluded(content, values = []) {
  return values.every((value) => !content.includes(value));
}

// Structured-output transports can preserve one final newline as two. Treat
// that serialization-only difference as the same document, while still
// catching wrapper text or any non-whitespace edit from the #83 regression.
function normalizeTrailingNewlines(content) {
  return content.endsWith('\n') ? `${content.replace(/\n+$/, '')}\n` : content;
}

export function scoreCase(fixture, output, validation = {}) {
  if (!output || typeof output.content !== 'string' || typeof output.changed !== 'boolean') {
    throw new Error(`invalid output for evaluation case ${fixture.id}`);
  }
  const expected = fixture.expected;
  const exactAssertionPass = expected.exactContent === undefined ||
    normalizeTrailingNewlines(output.content) === normalizeTrailingNewlines(expected.exactContent);
  const requiredAssertionPass = allIncluded(output.content, expected.required);
  const forbiddenAssertionPass = allExcluded(output.content, expected.forbidden);
  const contentAssertionsPass = exactAssertionPass && requiredAssertionPass && forbiddenAssertionPass;
  const verdictMatches = output.changed === expected.changed;

  return {
    id: fixture.id,
    docType: fixture.docType,
    verdictMatches,
    exactAssertionPass,
    requiredAssertionPass,
    forbiddenAssertionPass,
    staleFixed: expected.changed ? verdictMatches && contentAssertionsPass : null,
    falseEdit: expected.changed ? null : output.changed ||
      normalizeTrailingNewlines(output.content) !== normalizeTrailingNewlines(fixture.original),
    changedLines: changedLineCount(fixture.original, output.content),
    readabilityJargonPass: !JARGON.test(output.content) && forbiddenAssertionPass,
    runnableSnippetPass: expected.runnableManifest
      ? validation.runnableSnippetPass === true
      : null,
    commandValidityPass: expected.commandFences
      ? validation.commandValidityPass === true
      : null,
    mermaidParsePass: expected.expectMermaid
      ? validation.mermaidParsePass === true
      : null,
    diagramMatchesProse: expected.diagramGoldenExact
      ? validation.diagramMatchesProse === true
      : null,
    normativeWordingPreserved: expected.normativeLines
      ? validation.normativeWordingPreserved === true
      : null,
  };
}

export function scoreRun(corpus, outputs, validations = {}) {
  const byId = outputs instanceof Map ? outputs : new Map(Object.entries(outputs));
  const validationsById = validations instanceof Map
    ? validations
    : new Map(Object.entries(validations));
  return corpus.cases.map((fixture) => {
    if (!byId.has(fixture.id)) throw new Error(`missing output for evaluation case ${fixture.id}`);
    return scoreCase(fixture, byId.get(fixture.id), validationsById.get(fixture.id));
  });
}

function values(scores, key, docType) {
  return scores
    .filter((score) => !docType || score.docType === docType)
    .map((score) => score[key])
    .filter((value) => value !== null);
}

function rate(scores, key, docType) {
  const found = values(scores, key, docType);
  return found.length === 0 ? null : found.filter(Boolean).length / found.length;
}

function maximum(scores, key, docType) {
  const found = values(scores, key, docType);
  return found.length === 0 ? null : Math.max(...found);
}

export function metricsForRun(scores) {
  const group = (docType) => ({
    staleFixRate: rate(scores, 'staleFixed', docType),
    falseEditRate: rate(scores, 'falseEdit', docType),
    exactAssertionPassRate: rate(scores, 'exactAssertionPass', docType),
    requiredAssertionPassRate: rate(scores, 'requiredAssertionPass', docType),
    forbiddenAssertionPassRate: rate(scores, 'forbiddenAssertionPass', docType),
    readabilityJargonPassRate: rate(scores, 'readabilityJargonPass', docType),
    maximumChangedLines: maximum(scores, 'changedLines', docType),
    runnableSnippetPassRate: rate(scores, 'runnableSnippetPass', docType),
    commandValidityPassRate: rate(scores, 'commandValidityPass', docType),
    mermaidParsePassRate: rate(scores, 'mermaidParsePass', docType),
    diagramMatchesProseRate: rate(scores, 'diagramMatchesProse', docType),
    normativeWordingPreservedRate: rate(scores, 'normativeWordingPreserved', docType),
  });
  return {
    shared: group(null),
    setup: group('setup'),
    internals: group('internals'),
    contract: group('contract'),
  };
}

function aggregate(valuesToCombine, aggregation, bound) {
  const present = valuesToCombine.filter((value) => value !== null);
  if (present.length === 0) return null;
  if (aggregation === 'mean-of-N') {
    return present.reduce((sum, value) => sum + value, 0) / present.length;
  }
  return bound === 'minimum' ? Math.min(...present) : Math.max(...present);
}

export function aggregateRuns(scoredRuns) {
  const runMetrics = scoredRuns.map(metricsForRun);
  const metrics = {};
  for (const [group, thresholds] of Object.entries(THRESHOLDS)) {
    metrics[group] = {};
    for (const [metric, threshold] of Object.entries(thresholds)) {
      const bound = Object.hasOwn(threshold, 'minimum') ? 'minimum' : 'maximum';
      metrics[group][metric] = aggregate(
        runMetrics.map((run) => run[group][metric]),
        threshold.aggregation,
        bound,
      );
    }
  }
  return metrics;
}

export function thresholdResults(metrics) {
  const results = [];
  for (const [group, thresholds] of Object.entries(THRESHOLDS)) {
    for (const [metric, threshold] of Object.entries(thresholds)) {
      const value = metrics[group][metric];
      if (value === null) continue;
      const pass = Object.hasOwn(threshold, 'minimum')
        ? value >= threshold.minimum
        : value <= threshold.maximum;
      results.push({ group, metric, value, ...threshold, pass });
    }
  }
  return results;
}

export function compareToBaseline(metrics, baselineMetrics) {
  const comparisons = [];
  for (const [group, thresholds] of Object.entries(THRESHOLDS)) {
    for (const [metric, threshold] of Object.entries(thresholds)) {
      const current = metrics[group][metric];
      const baseline = baselineMetrics[group]?.[metric] ?? null;
      if (current === null || baseline === null) continue;
      const direction = Object.hasOwn(threshold, 'minimum') ? 'higher' : 'lower';
      const delta = current - baseline;
      comparisons.push({
        group,
        metric,
        baseline,
        current,
        delta,
        direction,
        improved: direction === 'higher' ? delta > 0 : delta < 0,
        regressed: direction === 'higher' ? delta < 0 : delta > 0,
      });
    }
  }
  return {
    metrics: comparisons,
    hasImprovement: comparisons.some(({ improved }) => improved),
    hasRegression: comparisons.some(({ regressed }) => regressed),
  };
}

export function buildReport({ corpus, scoredRuns, generatedAt, source }) {
  const metrics = aggregateRuns(scoredRuns);
  const thresholdChecks = thresholdResults(metrics);
  const repeatedRunPolicySatisfied = scoredRuns.length === REPEATED_RUN_POLICY.runsPerCase;
  return {
    version: 1,
    generatedAt,
    source,
    corpus: corpus.corpus,
    provenance: corpus.provenance,
    repeatedRunPolicy: REPEATED_RUN_POLICY,
    runCount: scoredRuns.length,
    repeatedRunPolicySatisfied,
    thresholds: THRESHOLDS,
    metrics,
    thresholdChecks,
    promotionEligible: repeatedRunPolicySatisfied && thresholdChecks.every((check) => check.pass),
    cases: scoredRuns,
  };
}
