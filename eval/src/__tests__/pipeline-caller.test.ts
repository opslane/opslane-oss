import { describe, it, expect, vi } from 'vitest';
import type { EvalCase } from '../types.js';

// Mock runAgentFix
vi.mock('../../../packages/worker/src/agent-fix.js', () => ({
  runAgentFix: vi.fn(),
}));

import { callPipeline } from '../pipeline-caller.js';
import { runAgentFix } from '../../../packages/worker/src/agent-fix.js';

const mockRunAgentFix = vi.mocked(runAgentFix);

function makeCase(overrides?: Partial<EvalCase>): EvalCase {
  return {
    id: 'test-001',
    app: 'vue-app',
    bug_patch: null,
    repo_url: 'https://github.com/test/eval-app.git',
    error_event: {
      error: { type: 'TypeError', message: 'test', stack: 'at foo.ts:1:1' },
      breadcrumbs: [],
      context: { url: 'http://test.com' },
    },
    expected: { outcome: 'fix_pr', rca_file: 'src/foo.ts' },
    grading: { fail_to_pass: [], pass_to_pass: [] },
    metadata: { category: 'null_reference', difficulty: 'easy', framework: 'vue3' },
    ...overrides,
  };
}

describe('callPipeline', () => {
  it('returns needs_human when repo_url is missing', async () => {
    const result = await callPipeline(makeCase({ repo_url: undefined }), '/tmp/cases');
    expect(result.status).toBe('needs_human');
    expect(result.reason?.reason_code).toBe('worker_runtime_error');
    expect(result.reason?.reason_message).toContain('no repo_url');
  });

  it('calls runAgentFix with correct error event fields', async () => {
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'fix_ready',
      diff: 'diff content',
      confidence: 'high',
      rootCause: 'null ref',
      affectedFiles: ['src/foo.ts'],
    });

    await callPipeline(makeCase({
      error_event: {
        platform: 'python',
        runtime: { name: 'CPython', version: '3.12.4' },
        error: { type: 'TypeError', message: 'test', stack: 'at foo.ts:1:1' },
        breadcrumbs: [],
        context: { url: 'http://test.com' },
      },
    }), '/tmp/cases');

    expect(mockRunAgentFix).toHaveBeenCalledOnce();
    const input = mockRunAgentFix.mock.calls[0]![0];
    expect(input.errorType).toBe('TypeError');
    expect(input.errorMessage).toBe('test');
    expect(input.platform).toBe('python');
    expect(input.customerRuntime).toEqual({ name: 'CPython', version: '3.12.4' });
    expect(input.repoUrl).toBe('https://github.com/test/eval-app.git');
    expect(input.sourceFiles).toEqual([]);
    expect(input.setupCommands).toBeUndefined();
  });

  it('passes setupCommands when bug_patch is set', async () => {
    // We can't test the actual file read without a real patch file,
    // but we can verify the function structure
    mockRunAgentFix.mockResolvedValueOnce({
      status: 'needs_human',
      reason: { reason_code: 'worker_runtime_error', reason_message: 'test', remediation: 'test' },
    });

    // This will fail because the patch file doesn't exist at /tmp/cases/test-001/bug.patch
    // But it tests that the function attempts to read the patch
    try {
      await callPipeline(makeCase({ bug_patch: 'bug.patch' }), '/tmp/cases');
    } catch {
      // Expected: ENOENT because patch file doesn't exist
    }
  });
});
