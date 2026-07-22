import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  traceSpan: vi.fn(async (
    _name: string,
    _attributes: Record<string, string | number | boolean>,
    fn: () => Promise<unknown>,
  ) => fn()),
  getToolSpanAttributes: vi.fn((name: string) => ({ 'tool.name': name })),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mocks.create } })),
}));

vi.mock('../tracing.js', () => ({
  traceSpan: mocks.traceSpan,
  getToolSpanAttributes: mocks.getToolSpanAttributes,
}));

import { runAgentLoop } from '../harness/agent-loop.js';
import type { AgentLoopConfig, ToolDefinition } from '../harness/types.js';

const usage = {
  input_tokens: 100,
  output_tokens: 25,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 5,
};

function makeConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    apiKey: 'test-key',
    maxTurns: 3,
    systemPrompt: 'You are a test agent.',
    tools: [],
    onEvent: vi.fn(),
    ...overrides,
  };
}

function readTool(execute = vi.fn().mockResolvedValue('file contents')): ToolDefinition {
  return {
    name: 'read',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute,
  };
}

describe('agent loop characterization', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.traceSpan.mockClear();
    mocks.getToolSpanAttributes.mockClear();
  });

  it('serializes a two-turn tool exchange with both cache markers and stable event order', async () => {
    const execute = vi.fn().mockResolvedValue('file contents');
    const events: string[] = [];
    const requests: unknown[] = [];

    mocks.create
      .mockImplementationOnce(async (params: unknown) => {
        requests.push(structuredClone(params));
        return {
          content: [
            { type: 'text', text: 'I will inspect it.' },
            { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'src/index.ts' } },
          ],
          stop_reason: 'tool_use',
          usage,
        };
      })
      .mockImplementationOnce(async (params: unknown) => {
        requests.push(structuredClone(params));
        return {
          content: [{ type: 'text', text: 'Inspection complete.' }],
          stop_reason: 'end_turn',
          usage,
        };
      });

    const result = await runAgentLoop(makeConfig({
      tools: [readTool(execute)],
      onEvent: (event) => events.push(event.type),
    }), 'Inspect the failure');

    expect(result).toMatchObject({ success: true, summary: 'Inspection complete.', turnCount: 2, toolCallCount: 1 });
    expect(execute).toHaveBeenCalledWith({ path: 'src/index.ts' });

    const firstParams = requests[0];
    expect(firstParams).toMatchObject({
      model: 'claude-sonnet-4-6',
      max_tokens: 16384,
      system: [{
        type: 'text',
        text: 'You are a test agent.',
        cache_control: { type: 'ephemeral' },
      }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        input_schema: expect.objectContaining({ type: 'object' }),
      }],
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: 'Inspect the failure',
          cache_control: { type: 'ephemeral' },
        }],
      }],
    });

    const secondParams = requests[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(secondParams.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect it.' },
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'src/index.ts' } },
      ],
    });
    expect(secondParams.messages[2]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'file contents',
        is_error: false,
        cache_control: { type: 'ephemeral' },
      }],
    });

    expect(events).toEqual([
      'turn_start',
      'message',
      'tool_call',
      'tool_result',
      'turn_end',
      'turn_start',
      'message',
      'completed',
      'turn_end',
    ]);
    expect(mocks.getToolSpanAttributes).toHaveBeenCalledWith('read', { path: 'src/index.ts' });
    expect(mocks.traceSpan).toHaveBeenCalledWith(
      'tool:read',
      { 'tool.name': 'read' },
      expect.any(Function),
    );
  });

  it('forwards the AbortSignal to Anthropic', async () => {
    const signal = new AbortController().signal;
    mocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      usage,
    });

    await runAgentLoop(makeConfig({ abortSignal: signal }), 'Fix it');

    expect(mocks.create).toHaveBeenCalledWith(expect.any(Object), { signal });
  });

  it('emits CANCELLED without calling the model when already aborted', async () => {
    const controller = new AbortController();
    const onEvent = vi.fn();
    controller.abort();

    const result = await runAgentLoop(makeConfig({
      abortSignal: controller.signal,
      onEvent,
    }), 'Fix it');

    expect(result).toMatchObject({ success: false, summary: 'Cancelled', turnCount: 1 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenNthCalledWith(1, { type: 'turn_start', turnNumber: 1 });
    expect(onEvent).toHaveBeenNthCalledWith(2, {
      type: 'error',
      code: 'CANCELLED',
      message: 'Run was cancelled',
    });
  });

  it.each([
    ['Anthropic API rate limited', 'API_RATE_LIMITED'],
    ['401 invalid API key', 'API_KEY_INVALID'],
    ['request timed out', 'TIMEOUT'],
    ['socket closed', 'AGENT_CRASHED'],
  ])('classifies %s as %s', async (message, code) => {
    const onEvent = vi.fn();
    mocks.create.mockRejectedValueOnce(new Error(message));

    const result = await runAgentLoop(makeConfig({ onEvent }), 'Fix it');

    expect(result).toMatchObject({ success: false, summary: message });
    expect(onEvent).toHaveBeenCalledWith({ type: 'error', code, message });
  });

  it('prices cache reads and cache writes at their distinct model rates', async () => {
    mocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Within budget.' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
      },
    });

    const cacheReadResult = await runAgentLoop(makeConfig({ budgetUsd: 1 }), 'Fix it');
    expect(cacheReadResult.success).toBe(true);

    mocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Over budget.' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
      },
    });

    const cacheWriteResult = await runAgentLoop(makeConfig({ budgetUsd: 1 }), 'Fix it');
    expect(cacheWriteResult).toMatchObject({
      success: false,
      summary: 'Budget exceeded',
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
    });
  });
});
