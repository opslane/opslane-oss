import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { engineOptions, runOnboardingAgent, type QueryFn } from '../engine.js';

const originalApiKey = process.env.ANTHROPIC_API_KEY;

const stub = (messages: unknown[]): ReturnType<QueryFn> => ({
  [Symbol.asyncIterator]: async function* () {
    for (const message of messages) yield message as never;
  },
});

describe('onboarding agent engine', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-only';
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('locks the SDK permission and configuration gates', () => {
    const options = engineOptions({
      cwd: '/r',
      canUseTool: async () => ({ behavior: 'allow' }),
      hook: async () => ({}),
      mcpServers: {},
      abortController: new AbortController(),
    });

    expect(options.permissionMode).toBe('default');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools).toEqual(['mcp__onboard__ask_user']);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Grep', 'WebFetch', 'WebSearch']),
    );
    expect(options.disallowedTools).not.toContain('Read');
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });

  it('maps a clean terminal result to success and forwards every message', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));
    const seen: unknown[] = [];

    const result = await runOnboardingAgent({
      cwd,
      onMessage: (message) => seen.push(message),
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => stub([{ type: 'assistant', message: { content: [] } }, { type: 'result', subtype: 'success' }]),
    });

    expect(result).toMatchObject({ ok: true, aborted: false, subtype: 'success' });
    expect(seen).toHaveLength(2);
  });

  it.each([
    ['an error result', [{ type: 'result', subtype: 'error_max_turns' }], 'error_max_turns'],
    ['a missing result', [], undefined],
  ])('maps %s to failure', async (_name, messages, subtype) => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));

    const result = await runOnboardingAgent({
      cwd,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => stub(messages),
    });

    expect(result.ok).toBe(false);
    expect(result.subtype).toBe(subtype);
  });

  it('handles an already-aborted caller signal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));
    const controller = new AbortController();
    controller.abort();

    const result = await runOnboardingAgent({
      cwd,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: controller.signal,
      queryFn: () => stub([]),
    });

    expect(result).toMatchObject({ ok: false, aborted: true });
  });

  it('propagates a caller abort that happens during iteration', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));
    const controller = new AbortController();

    const result = await runOnboardingAgent({
      cwd,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: controller.signal,
      queryFn: () => ({
        [Symbol.asyncIterator]: async function* () {
          controller.abort();
          yield { type: 'result', subtype: 'success' } as never;
        },
      }),
    });

    expect(result).toMatchObject({ ok: false, aborted: true });
  });

  it('fails cleanly before querying when the API key is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));
    delete process.env.ANTHROPIC_API_KEY;
    let queried = false;

    const result = await runOnboardingAgent({
      cwd,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => {
        queried = true;
        return stub([]);
      },
    });
    process.env.ANTHROPIC_API_KEY = 'test-only';

    expect(result).toMatchObject({ ok: false, aborted: false, reason: 'no_api_key' });
    expect(queried).toBe(false);
  });

  it('maps query failures without throwing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));

    const result = await runOnboardingAgent({
      cwd,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => {
        throw new Error('subprocess failed');
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'subprocess failed' });
  });

  it('maps mid-stream iterator failures without throwing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));

    const result = await runOnboardingAgent({
      cwd,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'assistant', message: { content: [] } } as never;
          throw new Error('iterator failed');
        },
      }),
    });

    expect(result).toMatchObject({ ok: false, reason: 'iterator failed' });
  });

  it('accepts the intentional ask_user allowlist shadow warning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));
    const warning = Object.assign(
      new Error(
        'canUseTool will not be invoked for: mcp__onboard__ask_user. Bare allowedTools entries auto-approve this tool.',
      ),
      { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' },
    );

    const result = await runOnboardingAgent({
      cwd,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => ({
        [Symbol.asyncIterator]: async function* () {
          process.emit('warning', warning);
          yield { type: 'result', subtype: 'success' } as never;
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, aborted: false });
  });

  it('aborts on any unexpected canUseTool shadow warning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opslane-engine-'));
    const warning = Object.assign(
      new Error('canUseTool will not be invoked for: Edit. Bare allowedTools entries auto-approve this tool.'),
      { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' },
    );

    const result = await runOnboardingAgent({
      cwd,
      onMessage: () => undefined,
      onReport: () => undefined,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      queryFn: () => ({
        [Symbol.asyncIterator]: async function* () {
          process.emit('warning', warning);
          yield { type: 'result', subtype: 'success' } as never;
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/shadowed/i);
  });
});
