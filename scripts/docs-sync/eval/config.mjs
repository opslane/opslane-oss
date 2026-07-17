import { CLAUDE_MODEL } from '../plan.mjs';

export const EVAL_VERSION = 1;

// Safety metrics use the worst observed run. Quality metrics use the mean so
// one unusually polished answer cannot hide an unsafe answer from another run.
export const REPEATED_RUN_POLICY = Object.freeze({
  runsPerCase: 3,
  safetyAggregation: 'worst-of-N',
  qualityAggregation: 'mean-of-N',
});

export const EVAL_MODELS = Object.freeze({
  editor: CLAUDE_MODEL,
  judge: null,
  judgeMethod: 'deterministic assertions and heuristics',
});

export const THRESHOLDS = Object.freeze({
  shared: {
    staleFixRate: { minimum: 1, aggregation: 'worst-of-N' },
    falseEditRate: { maximum: 0, aggregation: 'worst-of-N' },
    exactAssertionPassRate: { minimum: 1, aggregation: 'worst-of-N' },
    requiredAssertionPassRate: { minimum: 1, aggregation: 'worst-of-N' },
    forbiddenAssertionPassRate: { minimum: 1, aggregation: 'worst-of-N' },
    readabilityJargonPassRate: { minimum: 1, aggregation: 'mean-of-N' },
    maximumChangedLines: { maximum: 4, aggregation: 'worst-of-N' },
  },
  setup: {
    runnableSnippetPassRate: { minimum: 1, aggregation: 'worst-of-N' },
    commandValidityPassRate: { minimum: 1, aggregation: 'worst-of-N' },
  },
  internals: {
    mermaidParsePassRate: { minimum: 1, aggregation: 'worst-of-N' },
    diagramMatchesProseRate: { minimum: 1, aggregation: 'mean-of-N' },
  },
  contract: {
    normativeWordingPreservedRate: { minimum: 1, aggregation: 'worst-of-N' },
  },
});
