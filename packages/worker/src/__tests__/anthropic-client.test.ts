import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAnthropicClient,
  getAnthropicBaseUrl,
  getAnthropicClientOptions,
} from '../anthropic-client.js';

describe('Anthropic client configuration', () => {
  const originalBaseUrl = process.env['ANTHROPIC_BASE_URL'];

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env['ANTHROPIC_BASE_URL'];
    else process.env['ANTHROPIC_BASE_URL'] = originalBaseUrl;
  });

  it('uses the SDK default endpoint when no override is configured', () => {
    delete process.env['ANTHROPIC_BASE_URL'];

    expect(getAnthropicClientOptions('test-key')).toEqual({ apiKey: 'test-key' });
    expect(getAnthropicBaseUrl()).toBe('https://api.anthropic.com');
  });

  it('routes through the configured protocol-compatible endpoint', () => {
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:9099';

    expect(getAnthropicClientOptions('test-key')).toEqual({
      apiKey: 'test-key',
      baseURL: 'http://127.0.0.1:9099',
    });
    expect(getAnthropicBaseUrl()).toBe('http://127.0.0.1:9099');
  });

  it('ignores a whitespace-only override', () => {
    process.env['ANTHROPIC_BASE_URL'] = '   ';

    expect(getAnthropicClientOptions('test-key')).toEqual({ apiKey: 'test-key' });
    expect(getAnthropicBaseUrl()).toBe('https://api.anthropic.com');
  });

  it('keeps the real Anthropic protocol when routed to a deterministic endpoint', async () => {
    let requestPath = '';
    let requestApiKey = '';
    let requestBody: unknown;

    const server = createServer((req, res) => {
      requestPath = req.url ?? '';
      requestApiKey = String(req.headers['x-api-key'] ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'scripted response' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
    process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${address.port}`;

    try {
      const client = createAnthropicClient('deterministic-test-key');
      const response = await client.messages.create({
        model: 'claude-test',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'run the scripted scenario' }],
      });

      expect(response.content).toEqual([{ type: 'text', text: 'scripted response' }]);
      expect(requestPath).toBe('/v1/messages');
      expect(requestApiKey).toBe('deterministic-test-key');
      expect(requestBody).toEqual(expect.objectContaining({
        model: 'claude-test',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'run the scripted scenario' }],
      }));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
