import { describe, it, expect } from 'vitest';
import { gradeCase } from '../grader.js';
import type { EvalCase, JudgeResult } from '../types.js';
import type { AgentFixResult } from '../../../packages/worker/src/agent-fix.js';
import type { TestResult } from '../test-executor.js';

const fixableCase: EvalCase = {
  id: 'test-001',
  app: 'vue-app',
  bug_patch: 'bug.patch',
  error_event: { error: { type: 'TypeError', message: 'm', stack: 's' }, breadcrumbs: [], context: {} },
  expected: { outcome: 'fix_pr', rca_file: 'src/foo.vue' },
  grading: { fail_to_pass: ['test-a'], pass_to_pass: ['test-b'] },
  metadata: { category: 'null_ref', difficulty: 'easy', framework: 'vue3' },
};

const needsHumanCase: EvalCase = {
  id: 'test-007',
  app: 'vue-app',
  bug_patch: null,
  error_event: { error: { type: 'Error', message: 'CDN down', stack: '' }, breadcrumbs: [], context: {} },
  expected: { outcome: 'needs_human', reason_code: 'worker_runtime_error' },
  grading: { fail_to_pass: [], pass_to_pass: [] },
  metadata: { category: 'infra_issue', difficulty: 'easy', framework: 'vue3' },
};

describe('gradeCase', () => {
  it('passes when outcome, RCA, and all tests are correct', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'diff content',
      confidence: 'high',
      rootCause: 'null ref',
      affectedFiles: ['src/foo.vue'],
    };
    const f2p: TestResult[] = [{ test: 'test-a', passed: true }];
    const p2p: TestResult[] = [{ test: 'test-b', passed: true }];

    const result = gradeCase(fixableCase, pipelineResult, true, f2p, p2p, 1000);
    expect(result.passed).toBe(true);
    expect(result.outcome_correct).toBe(true);
    expect(result.rca_file_correct).toBe(true);
  });

  it('fails when pipeline returns needs_human for a fixable case', () => {
    const pipelineResult: AgentFixResult = {
      status: 'needs_human',
      reason: { reason_code: 'malformed_diff', reason_message: 'x', remediation: 'y' },
    };
    const result = gradeCase(fixableCase, pipelineResult, false, [], [], 1000);
    expect(result.passed).toBe(false);
    expect(result.outcome_correct).toBe(false);
  });

  it('fails when FAIL_TO_PASS test still fails after fix', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'diff',
      confidence: 'high',
      rootCause: 'null',
      affectedFiles: ['src/foo.vue'],
    };
    const f2p: TestResult[] = [{ test: 'test-a', passed: false }];
    const p2p: TestResult[] = [{ test: 'test-b', passed: true }];

    const result = gradeCase(fixableCase, pipelineResult, true, f2p, p2p, 1000);
    expect(result.passed).toBe(false);
  });

  it('fails when PASS_TO_PASS test regresses', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'diff',
      confidence: 'high',
      rootCause: 'null',
      affectedFiles: ['src/foo.vue'],
    };
    const f2p: TestResult[] = [{ test: 'test-a', passed: true }];
    const p2p: TestResult[] = [{ test: 'test-b', passed: false }];

    const result = gradeCase(fixableCase, pipelineResult, true, f2p, p2p, 1000);
    expect(result.passed).toBe(false);
  });

  it('passes needs_human case when outcome and reason_code match', () => {
    const pipelineResult: AgentFixResult = {
      status: 'needs_human',
      reason: { reason_code: 'worker_runtime_error', reason_message: 'infra', remediation: 'check CDN' },
    };
    const result = gradeCase(needsHumanCase, pipelineResult, false, [], [], 500);
    expect(result.passed).toBe(true);
    expect(result.outcome_correct).toBe(true);
    expect(result.reason_code_correct).toBe(true);
  });

  it('fails needs_human case when pipeline returns fix_ready (false positive)', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'diff',
      confidence: 'low',
      rootCause: 'guess',
      affectedFiles: [],
    };
    const result = gradeCase(needsHumanCase, pipelineResult, true, [], [], 500);
    expect(result.passed).toBe(false);
    expect(result.outcome_correct).toBe(false);
  });

  it('fails when test results are empty (no tests matched filter)', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'diff',
      confidence: 'high',
      rootCause: 'null',
      affectedFiles: ['src/foo.vue'],
    };
    // Empty arrays — vitest matched zero tests but exited 0
    const result = gradeCase(fixableCase, pipelineResult, true, [], [], 1000);
    expect(result.passed).toBe(false);
  });

  it('fails when patch does not apply', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'bad diff',
      confidence: 'high',
      rootCause: 'null',
      affectedFiles: ['src/foo.vue'],
    };
    const result = gradeCase(fixableCase, pipelineResult, false, [], [], 1000);
    expect(result.passed).toBe(false);
    expect(result.patch_applies).toBe(false);
  });

  it('fails when tests pass but judge quality fails', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'diff',
      confidence: 'high',
      rootCause: 'null ref',
      affectedFiles: ['src/foo.vue'],
    };
    const f2p: TestResult[] = [{ test: 'test-a', passed: true }];
    const p2p: TestResult[] = [{ test: 'test-b', passed: true }];
    const judgeResult: JudgeResult = {
      scope: 0, correctness: 2, preservation: 2,
      explanation: 'Over-scoped', total: 4, quality_passed: false,
    };

    const result = gradeCase(fixableCase, pipelineResult, true, f2p, p2p, 1000, judgeResult);
    expect(result.passed).toBe(false);
    expect(result.judge_result).toEqual(judgeResult);
  });

  it('passes when tests pass and judge quality passes', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'diff',
      confidence: 'high',
      rootCause: 'null ref',
      affectedFiles: ['src/foo.vue'],
    };
    const f2p: TestResult[] = [{ test: 'test-a', passed: true }];
    const p2p: TestResult[] = [{ test: 'test-b', passed: true }];
    const judgeResult: JudgeResult = {
      scope: 2, correctness: 2, preservation: 2,
      explanation: 'Clean fix', total: 6, quality_passed: true,
    };

    const result = gradeCase(fixableCase, pipelineResult, true, f2p, p2p, 1000, judgeResult);
    expect(result.passed).toBe(true);
    expect(result.judge_result).toEqual(judgeResult);
  });

  it('passes when judge is absent (backwards compat)', () => {
    const pipelineResult: AgentFixResult = {
      status: 'fix_ready',
      diff: 'diff',
      confidence: 'high',
      rootCause: 'null ref',
      affectedFiles: ['src/foo.vue'],
    };
    const f2p: TestResult[] = [{ test: 'test-a', passed: true }];
    const p2p: TestResult[] = [{ test: 'test-b', passed: true }];

    const result = gradeCase(fixableCase, pipelineResult, true, f2p, p2p, 1000);
    expect(result.passed).toBe(true);
    expect(result.judge_result).toBeUndefined();
  });
});
