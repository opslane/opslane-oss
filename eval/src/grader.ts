import type { AgentFixResult } from '../../packages/worker/src/agent-fix.js';
import type { EvalCase, EvalCaseResult, JudgeResult } from './types.js';
import type { TestResult } from './test-executor.js';

export function gradeCase(
  evalCase: EvalCase,
  pipelineResult: AgentFixResult,
  patchApplied: boolean,
  failToPassResults: TestResult[],
  passToPassResults: TestResult[],
  durationMs: number,
  judgeResult?: JudgeResult,
  judgeSkipped?: boolean,
): EvalCaseResult {
  const actualOutcome = pipelineResult.status === 'fix_ready' ? 'fix_pr' : 'needs_human';
  const outcomeCorrect = actualOutcome === evalCase.expected.outcome;

  // RCA file check (only for fix_pr cases)
  let rcaFileCorrect: boolean | undefined;
  let actualRcaFile: string | undefined;
  if (pipelineResult.status === 'fix_ready' && evalCase.expected.rca_file) {
    actualRcaFile = pipelineResult.affectedFiles?.[0];
    rcaFileCorrect = pipelineResult.affectedFiles?.includes(evalCase.expected.rca_file) ?? false;
  }

  // Reason code check (only for needs_human cases)
  let reasonCodeCorrect: boolean | undefined;
  let actualReasonCode: string | undefined;
  if (pipelineResult.status === 'needs_human' && evalCase.expected.reason_code && pipelineResult.reason) {
    actualReasonCode = pipelineResult.reason.reason_code;
    reasonCodeCorrect = pipelineResult.reason.reason_code === evalCase.expected.reason_code;
  }

  // Overall pass: outcome correct + all tests correct
  // Guard: every() on empty array returns true — require non-empty results for fix_pr cases
  const allF2PPassed = failToPassResults.length > 0 && failToPassResults.every(r => r.passed);
  const allP2PPassed = passToPassResults.length === 0 || passToPassResults.every(r => r.passed);

  let passed: boolean;
  if (evalCase.expected.outcome === 'fix_pr') {
    const testsPassed = outcomeCorrect && patchApplied && allF2PPassed && allP2PPassed;
    // No judge = pass (backwards compat), but track judge_skipped
    const qualityPassed = judgeResult ? judgeResult.quality_passed : true;
    passed = testsPassed && qualityPassed;
  } else {
    // For needs_human: outcome match is sufficient. reason_code is tracked
    // but not required to match — the agent harness uses different codes
    // (budget_exhausted, infrastructure_outage) than the legacy pipeline.
    passed = outcomeCorrect;
  }

  return {
    case_id: evalCase.id,
    passed,
    outcome_correct: outcomeCorrect,
    actual_outcome: actualOutcome,
    rca_file_correct: rcaFileCorrect,
    actual_rca_file: actualRcaFile,
    patch_applies: evalCase.expected.outcome === 'fix_pr' ? patchApplied : undefined,
    fail_to_pass_results: failToPassResults.length > 0
      ? failToPassResults.map(r => ({ test: r.test, passed: r.passed }))
      : undefined,
    pass_to_pass_results: passToPassResults.length > 0
      ? passToPassResults.map(r => ({ test: r.test, passed: r.passed }))
      : undefined,
    reason_code_correct: reasonCodeCorrect,
    actual_reason_code: actualReasonCode,
    confidence: pipelineResult.confidence,
    root_cause: pipelineResult.rootCause,
    duration_ms: durationMs,
    token_usage: pipelineResult.tokenUsage,
    judge_result: judgeResult,
    judge_skipped: judgeSkipped,
  };
}
