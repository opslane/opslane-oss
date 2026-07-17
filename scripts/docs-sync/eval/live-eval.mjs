#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_MODELS, REPEATED_RUN_POLICY } from './config.mjs';
import { buildReport, compareToBaseline, loadBaseline, loadCorpus, scoreRun } from './evaluate.mjs';
import { validateEvalOutput } from './validate-output.mjs';
import { defaultRunClaude, promptForDocument } from '../plan.mjs';

export async function runLiveEvaluation({
  corpus = loadCorpus(),
  baseline = loadBaseline(),
  runClaude = defaultRunClaude,
  validateOutput = validateEvalOutput,
  now = new Date(),
} = {}) {
  const scoredRuns = [];
  const outputRuns = [];
  const validationRuns = [];
  for (let run = 0; run < REPEATED_RUN_POLICY.runsPerCase; run += 1) {
    const outputs = {};
    const validations = {};
    for (const fixture of corpus.cases) {
      outputs[fixture.id] = await runClaude({
        prompt: promptForDocument(fixture.docPath, fixture.original, fixture.diff),
        docPath: fixture.docPath,
        original: fixture.original,
        diff: fixture.diff,
      });
      validations[fixture.id] = await validateOutput(fixture, outputs[fixture.id]);
    }
    outputRuns.push(outputs);
    validationRuns.push(validations);
    scoredRuns.push(scoreRun(corpus, outputs, validations));
  }
  const report = buildReport({
    corpus,
    scoredRuns,
    generatedAt: now.toISOString(),
    source: { kind: 'live-claude-cli', models: EVAL_MODELS },
  });
  report.baseline = {
    generatedAt: baseline.generatedAt,
    source: baseline.source,
    comparison: compareToBaseline(report.metrics, baseline.metrics),
  };
  report.outputs = outputRuns;
  report.validations = validationRuns;
  report.promotionEligible = report.promotionEligible &&
    report.baseline.comparison.hasImprovement &&
    !report.baseline.comparison.hasRegression;
  return report;
}

export function writeDatedReport(report, outputDirectory) {
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');
  const destination = resolve(outputDirectory, `${timestamp}-live.json`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return destination;
}

async function main() {
  const outputDirectory = resolve(process.argv[2] ?? new URL('./reports', import.meta.url).pathname);
  const report = await runLiveEvaluation();
  const destination = writeDatedReport(report, outputDirectory);
  process.stdout.write(`${destination}\n`);
  if (!report.promotionEligible) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
