import { describe, expect, it } from 'vitest';
import type { ModelPort } from '../model-port.js';

describe('ModelPort', () => {
  it('round-trips tool calls and tool results across turns', async () => {
    const signal = new AbortController().signal;
    const port: ModelPort = {
      async generate(req) {
        expect(req.model).toBe('m');
        expect(req.signal).toBe(signal);
        expect(req.messages).toEqual([
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'search', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', output: 'done', isError: false }] },
        ]);
        return {
          content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: 'tool_use',
        };
      },
    };

    const out = await port.generate({
      model: 'm',
      system: [{ text: 's', cache: true }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'search', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', output: 'done', isError: false }] },
      ],
      tools: [{ name: 'read', description: 'r', schema: {} }],
      signal,
    });

    expect(out.content[0]).toMatchObject({ type: 'tool_use', name: 'read' });
  });
});
