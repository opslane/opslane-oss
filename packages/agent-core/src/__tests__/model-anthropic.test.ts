import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicModelPort } from '../model-anthropic.js';

describe('createAnthropicModelPort', () => {
  it('maps a cached multi-turn request and response without constructing the client', async () => {
    const signal = new AbortController().signal;
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      },
    });
    const client = { messages: { create } } as unknown as Anthropic;
    const port = createAnthropicModelPort(client);

    const result = await port.generate({
      model: 'claude-test',
      system: [{ text: 'system', cache: true }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'search', input: { pattern: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', output: 'found', isError: false }] },
      ],
      tools: [{ name: 'read', description: 'Read', schema: { type: 'object' } }],
      signal,
    });

    const [params, requestOptions] = create.mock.calls[0] as [Record<string, unknown>, { signal?: AbortSignal }];
    expect(params['system']).toEqual([{
      type: 'text',
      text: 'system',
      cache_control: { type: 'ephemeral' },
    }]);
    expect(params['tools']).toEqual([{
      name: 'read',
      description: 'Read',
      input_schema: { type: 'object' },
    }]);
    const messages = params['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]).not.toHaveProperty('cache_control');
    expect(messages[2]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't0',
      content: 'found',
      is_error: false,
      cache_control: { type: 'ephemeral' },
    });
    expect(requestOptions.signal).toBe(signal);
    expect(result).toEqual({
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 },
    });
  });

  it('defaults omitted cache usage to zero and preserves text', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    const port = createAnthropicModelPort({ messages: { create } } as unknown as Anthropic);
    const result = await port.generate({
      model: 'm', system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [],
    });
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
  });
});
