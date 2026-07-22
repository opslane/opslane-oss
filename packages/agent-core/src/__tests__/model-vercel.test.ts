import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { createVercelModelPort } from '../model-vercel.js';

describe('createVercelModelPort', () => {
  it('resolves the requested model and maps tools, messages, signal, calls, and usage', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'read',
          input: JSON.stringify({ path: 'package.json' }),
        }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 13, noCache: 8, cacheRead: 5, cacheWrite: undefined },
          outputTokens: { total: 3, text: 0, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const resolve = vi.fn(() => model);
    const signal = new AbortController().signal;
    const port = createVercelModelPort({ resolve });

    const result = await port.generate({
      model: 'proxy-model',
      system: [{ text: 'system', cache: true }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'search', input: { pattern: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', output: 'found', isError: false }] },
      ],
      tools: [{ name: 'read', description: 'Read a file', schema: { type: 'object' } }],
      signal,
    });

    expect(resolve).toHaveBeenCalledWith('proxy-model');
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0]!;
    expect(call.abortSignal).toBe(signal);
    expect(call.tools).toEqual([expect.objectContaining({ name: 'read', description: 'Read a file' })]);
    expect(call.prompt).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't0', toolName: 'search', input: { pattern: 'x' } }] },
      { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 't0', toolName: 'search',
        output: { type: 'text', value: 'found' },
      }] },
    ]);
    expect(result).toEqual({
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'package.json' } }],
      usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0 },
      stopReason: 'tool_use',
    });
  });

  it('maps omitted usage fields to zero and stop to end_turn', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'done' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      },
    });
    const result = await createVercelModelPort({ resolve: () => model }).generate({
      model: 'm', system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [],
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'done' }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: 'end_turn',
    });
  });
});
