import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const createFn = vi.fn();
  return {
    default: vi.fn(() => ({
      messages: { create: createFn },
    })),
    __mockCreate: createFn,
  };
});

import { runAgentLoop } from '../harness/agent-loop.js';
import type { AgentLoopConfig, AgentState, ToolDefinition } from '../harness/types.js';

// Access the mock for assertions
const { __mockCreate: mockCreate } = await import('@anthropic-ai/sdk') as unknown as { __mockCreate: ReturnType<typeof vi.fn> };

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    apiKey: 'test-key',
    maxTurns: 5,
    systemPrompt: 'You are a test agent.',
    tools: [],
    onEvent: vi.fn(),
    ...overrides,
  };
}

describe('runAgentLoop', () => {
  it('returns success when model responds with text only (no tool calls)', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I fixed the bug.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const result = await runAgentLoop(makeConfig(), 'Fix the bug');
    expect(result.success).toBe(true);
    expect(result.summary).toBe('I fixed the bug.');
    expect(result.turnCount).toBe(1);
  });

  it('executes tool calls and continues the loop', async () => {
    const readTool: ToolDefinition = {
      name: 'read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: vi.fn().mockResolvedValue('file content here'),
    };

    // Turn 1: model calls read tool
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'Let me read the file.' },
        { type: 'tool_use', id: 'tc1', name: 'read', input: { path: 'src/foo.ts' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    // Turn 2: model responds with text
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Fixed it.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const result = await runAgentLoop(makeConfig({ tools: [readTool] }), 'Fix the bug');
    expect(result.success).toBe(true);
    expect(result.turnCount).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(readTool.execute).toHaveBeenCalledWith({ path: 'src/foo.ts' });
  });

  it('returns failure when max turns exceeded', async () => {
    // Every turn returns a tool call, never stops
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'tc', name: 'bash', input: { command: 'echo hi' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const bashTool: ToolDefinition = {
      name: 'bash',
      description: 'Run command',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: vi.fn().mockResolvedValue('hi'),
    };

    const result = await runAgentLoop(makeConfig({ tools: [bashTool], maxTurns: 3 }), 'Fix');
    expect(result.success).toBe(false);
    expect(result.turnCount).toBe(3);
  });

  it('stops early when budget exceeded', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Working on it...' }, { type: 'tool_use', id: 'tc1', name: 'bash', input: { command: 'echo' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 500_000, output_tokens: 200_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const bashTool: ToolDefinition = {
      name: 'bash',
      description: 'Run command',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: vi.fn().mockResolvedValue('ok'),
    };

    const result = await runAgentLoop(makeConfig({ tools: [bashTool], budgetUsd: 0.01 }), 'Fix');
    expect(result.success).toBe(false);
  });

  it('invokes preCompletion middleware and injects message', async () => {
    // Turn 1: model tries to finish without running tests
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    // Turn 2: model finishes after middleware injection
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Now I ran tests. Done.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 150, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    let injected = false;
    const middleware = {
      preCompletion: vi.fn().mockImplementation(async () => {
        if (!injected) {
          injected = true;
          return { inject: 'Run tests first!' };
        }
      }),
    };

    const result = await runAgentLoop(makeConfig({ middleware }), 'Fix');
    expect(result.success).toBe(true);
    expect(result.turnCount).toBe(2);
    expect(middleware.preCompletion).toHaveBeenCalledTimes(2);
  });

  it('uses externalState when provided (shared with tool bridge)', async () => {
    const externalState: AgentState = {
      turnCount: 0, toolCallCount: 0, editCounts: new Map(),
      testsRan: false, gaveUp: false,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stackTraceFiles: [], scopeReviewDone: false, toolHistoryEntries: [],
    };

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const result = await runAgentLoop(makeConfig({ externalState }), 'Fix');
    expect(result.success).toBe(true);
    // External state should be mutated
    expect(externalState.turnCount).toBe(1);
    expect(externalState.tokenUsage.input).toBe(100);
  });

  it('returns testsRan from state in result', async () => {
    const externalState: AgentState = {
      turnCount: 0, toolCallCount: 0, editCounts: new Map(),
      testsRan: true, gaveUp: false,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stackTraceFiles: [], scopeReviewDone: false, toolHistoryEntries: [],
    };

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const result = await runAgentLoop(makeConfig({ externalState }), 'Fix');
    expect(result.testsRan).toBe(true);
  });
});
