import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentState } from '../tool-loop.js';
import { toolLoop } from '../tool-loop.js';
import type { ModelPort, ModelResponse, ToolSpec } from '../model-port.js';

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const pricing = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

describe('toolLoop', () => {
  it('executes tools, preserves event order, and round-trips results', async () => {
    const requests: Parameters<ModelPort['generate']>[0][] = [];
    const responses: ModelResponse[] = [
      {
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
        usage: zeroUsage,
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        usage: zeroUsage,
        stopReason: 'end_turn',
      },
    ];
    const port: ModelPort = { generate: vi.fn(async (request) => {
      requests.push(structuredClone(request));
      return responses.shift()!;
    }) };
    const events: AgentEvent[] = [];
    const tool: ToolSpec = { name: 'read', description: 'read', schema: {}, execute: async () => 'contents' };

    const result = await toolLoop(port, {
      model: 'm', systemPrompt: 's', userMessage: 'go', maxTurns: 3,
      tools: [tool], onEvent: (event) => events.push(event), pricing,
    });

    expect(result.success).toBe(true);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', output: 'contents', isError: false }],
    });
    expect(events.map((event) => event.type)).toEqual([
      'turn_start', 'tool_call', 'tool_result', 'turn_end',
      'turn_start', 'message', 'completed', 'turn_end',
    ]);
  });

  it('uses injected cached-token pricing for budget enforcement', async () => {
    const port: ModelPort = { generate: vi.fn(async (): Promise<ModelResponse> => ({
      content: [{ type: 'text', text: 'done' }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
      stopReason: 'end_turn',
    })) };
    const result = await toolLoop(port, {
      model: 'm', systemPrompt: 's', userMessage: 'go', maxTurns: 1, tools: [],
      onEvent: vi.fn(), pricing: { input: 0, output: 0, cacheRead: 9, cacheWrite: 0 }, budgetUsd: 8,
    });
    expect(result).toMatchObject({ success: false, summary: 'Budget exceeded' });
  });

  it('redacts events, model history, middleware, and trace attributes', async () => {
    const secret = 'top-secret';
    const responses: ModelResponse[] = [
      {
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: secret } }],
        usage: zeroUsage,
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: `done ${secret}` }], usage: zeroUsage, stopReason: 'end_turn' },
    ];
    const generate = vi.fn(async () => responses.shift()!);
    const events: AgentEvent[] = [];
    const traceTool = vi.fn(async (_name, input: Record<string, unknown>, execute: () => Promise<string>) => {
      expect(JSON.stringify(input)).not.toContain(secret);
      return execute();
    });
    const postTool = vi.fn(async (_call, result) => expect(result.output).not.toContain(secret));
    const result = await toolLoop({ generate }, {
      model: 'm', systemPrompt: secret, userMessage: secret, maxTurns: 2,
      tools: [{ name: 'read', description: 'r', schema: {}, execute: async () => secret }],
      onEvent: (event) => events.push(event), pricing, traceTool, middleware: { postTool },
      redact: (text) => text.replaceAll(secret, '[REDACTED]'),
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(generate.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('redacts a thrown tool error before tracing observes it', async () => {
    const secret = 'trace-secret';
    const tracedErrors: string[] = [];
    const port: ModelPort = { generate: vi.fn(async (): Promise<ModelResponse> => ({
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
      usage: zeroUsage,
      stopReason: 'tool_use',
    })) };

    await toolLoop(port, {
      model: 'm', systemPrompt: 's', userMessage: 'go', maxTurns: 1,
      tools: [{ name: 'read', description: 'r', schema: {}, execute: async () => {
        throw new Error(`failed with ${secret}`);
      } }],
      onEvent: vi.fn(), pricing,
      redact: (text) => text.replaceAll(secret, '[REDACTED]'),
      traceTool: async (_name, _input, execute) => {
        try {
          return await execute();
        } catch (error) {
          tracedErrors.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });

    expect(tracedErrors).toEqual(['failed with [REDACTED]']);
  });

  it('classifies cancellation and API errors', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelledEvents: AgentEvent[] = [];
    const cancelled = await toolLoop({ generate: vi.fn() }, {
      model: 'm', systemPrompt: 's', userMessage: 'u', maxTurns: 1, tools: [], pricing,
      signal: controller.signal, onEvent: (event) => cancelledEvents.push(event),
    });
    expect(cancelled.success).toBe(false);
    expect(cancelledEvents).toContainEqual({ type: 'error', code: 'CANCELLED', message: 'Run was cancelled' });

    const apiEvents: AgentEvent[] = [];
    await toolLoop({ generate: vi.fn(async () => { throw new Error('429 rate limit'); }) }, {
      model: 'm', systemPrompt: 's', userMessage: 'u', maxTurns: 1, tools: [], pricing,
      onEvent: (event) => apiEvents.push(event),
    });
    expect(apiEvents).toContainEqual({ type: 'error', code: 'API_RATE_LIMITED', message: '429 rate limit' });
  });
});
