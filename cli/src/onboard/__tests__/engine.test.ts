import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectOptions, runDetect, type QueryFn } from '../engine.js';
import type { OnboardingPlan, ReportPlanInput } from '../tools.js';

const originalApiKey = process.env.ANTHROPIC_API_KEY;

const stub = (messages: unknown[]): ReturnType<QueryFn> => ({
  [Symbol.asyncIterator]: async function* () {
    for (const message of messages) yield message as never;
  },
});

function fixture(): { root: string; report: ReportPlanInput; plan: OnboardingPlan } {
  const root = mkdtempSync(join(tmpdir(), 'opslane-engine-'));
  mkdirSync(join(root, 'src'));
  const contents = "createApp(App).mount('#app');\n";
  writeFileSync(join(root, 'src', 'main.ts'), contents);
  const plan: OnboardingPlan = {
    app_dir: '.',
    framework: 'vue-vite',
    package_manager: 'pnpm',
    env_prefix: 'VITE_',
    dependency: { name: '@opslane/sdk', version: '^1.0.0' },
    env_vars: {
      api_key: 'VITE_OPSLANE_API_KEY',
      endpoint: 'VITE_OPSLANE_ENDPOINT',
    },
    edit: {
      file: 'src/main.ts',
      entry_hash: createHash('sha256').update(contents).digest('hex'),
      import_line: "import { init } from '@opslane/sdk';",
      init_block:
        'init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY, endpoint: import.meta.env.VITE_OPSLANE_ENDPOINT });',
      anchor: "createApp(App).mount('#app');",
      position: 'before',
      occurrence: 0,
    },
    existing_sdk: { action: 'keep', name: null },
    rationale: 'Initialize before the application mount.',
  };
  return { root, plan, report: { status: 'ok', plan } };
}

type RegisteredTool = {
  handler: (input: unknown, extra: unknown) => Promise<unknown>;
};

function reportQuery(
  input: ReportPlanInput,
  {
    duplicateRejectedAttempt = false,
    terminalSubtype = 'success',
  }: {
    duplicateRejectedAttempt?: boolean;
    terminalSubtype?: string;
  } = {},
): QueryFn {
  return (request) => ({
    [Symbol.asyncIterator]: async function* () {
      const onboardServer = request.options?.mcpServers?.onboard as unknown as {
        instance: { _registeredTools: Record<string, RegisteredTool> };
      };
      await onboardServer.instance._registeredTools.report_plan!.handler(input, {});
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'report-1', name: 'mcp__onboard__report_plan', input },
          ],
        },
      } as never;
      yield {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'report-1', is_error: false }],
        },
      } as never;
      if (duplicateRejectedAttempt) {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'report-2', name: 'mcp__onboard__report_plan', input },
            ],
          },
        } as never;
        await expect(
          onboardServer.instance._registeredTools.report_plan!.handler(input, {}),
        ).rejects.toThrow(/already/i);
        yield {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'report-2', is_error: true }],
          },
        } as never;
      }
      yield { type: 'result', subtype: terminalSubtype } as never;
    },
  });
}

describe('detect-stage engine', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-only';
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('locks the SDK permission and configuration gates', async () => {
    const options = detectOptions({
      cwd: '/r',
      hook: async () => ({}),
      mcpServers: {},
      abortController: new AbortController(),
    });

    expect(options.permissionMode).toBe('default');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools).toEqual([
      'mcp__onboard__report_plan',
      'mcp__onboard__ask_user',
    ]);
    expect(options.tools).toEqual(['Read', 'Glob']);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining([
        'Grep',
        'Write',
        'Edit',
        'MultiEdit',
        'Bash',
        'WebFetch',
        'WebSearch',
      ]),
    );
    expect(options.disallowedTools).not.toContain('Read');
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(options.maxTurns).toBe(50);
    await expect(options.canUseTool?.('Read', {}, {} as never)).resolves.toMatchObject({
      behavior: 'allow',
    });
    await expect(
      options.canUseTool?.('mcp__onboard__search', {}, {} as never),
    ).resolves.toMatchObject({ behavior: 'allow' });
    await expect(options.canUseTool?.('Bash', {}, {} as never)).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('maps one validated plan and a clean result to success', async () => {
    const { root, report, plan } = fixture();
    const captured: OnboardingPlan[] = [];
    const seen: unknown[] = [];

    const result = await runDetect({
      cwd: root,
      onMessage: (message) => seen.push(message),
      onPlan: (accepted) => captured.push(accepted),
      signal: new AbortController().signal,
      queryFn: reportQuery(report),
    });

    expect(result).toEqual({ ok: true, aborted: false, subtype: 'success' });
    expect(captured).toEqual([plan]);
    expect(seen).toHaveLength(3);
  });

  it('rejects a clean result with no validated plan', async () => {
    const { root } = fixture();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: () => stub([{ type: 'result', subtype: 'success' }]),
    });

    expect(result).toMatchObject({ ok: false, reason: 'no_plan' });
  });

  it('rejects a second report attempt after a plan was accepted', async () => {
    const { root, report } = fixture();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: reportQuery(report, { duplicateRejectedAttempt: true }),
    });

    expect(result).toMatchObject({ ok: false, reason: 'multiple_plans' });
  });

  it('allows a rejected invalid report to be corrected once', async () => {
    const { root, report, plan } = fixture();
    const invalid = {
      status: 'ok',
      plan: { ...plan, framework: '' },
    } as ReportPlanInput;
    const queryFn: QueryFn = (request) => ({
      [Symbol.asyncIterator]: async function* () {
        const onboardServer = request.options?.mcpServers?.onboard as unknown as {
          instance: { _registeredTools: Record<string, RegisteredTool> };
        };
        const reportTool = onboardServer.instance._registeredTools.report_plan!;

        await expect(reportTool.handler(invalid, {})).rejects.toThrow(/non-empty/i);
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'invalid-report',
                name: 'mcp__onboard__report_plan',
                input: invalid,
              },
            ],
          },
        } as never;
        yield {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'invalid-report', is_error: true },
            ],
          },
        } as never;

        await reportTool.handler(report, {});
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'valid-report',
                name: 'mcp__onboard__report_plan',
                input: report,
              },
            ],
          },
        } as never;
        yield {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'valid-report', is_error: false },
            ],
          },
        } as never;
        yield { type: 'result', subtype: 'success' } as never;
      },
    });

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('maps unsupported as a distinct non-error outcome without calling onPlan', async () => {
    const { root } = fixture();
    let plans = 0;

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => {
        plans += 1;
      },
      signal: new AbortController().signal,
      queryFn: reportQuery({
        status: 'unsupported',
        reason: 'no web app: only Go services and documentation',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      aborted: false,
      subtype: 'success',
      reason: 'unsupported',
    });
    expect(plans).toBe(0);
  });

  it.each([
    ['an error result', [{ type: 'result', subtype: 'error_max_turns' }], 'error_max_turns'],
    ['a missing result', [], 'missing_result'],
  ])('maps %s to failure', async (_name, messages, reason) => {
    const { root } = fixture();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: () => stub(messages),
    });

    expect(result).toMatchObject({ ok: false, reason });
  });

  it('handles an already-aborted caller signal without querying', async () => {
    const { root } = fixture();
    const controller = new AbortController();
    let queried = false;
    controller.abort();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: controller.signal,
      queryFn: () => {
        queried = true;
        return stub([]);
      },
    });

    expect(result).toMatchObject({ ok: false, aborted: true, reason: 'aborted' });
    expect(queried).toBe(false);
  });

  it('propagates a caller abort that happens during iteration', async () => {
    const { root } = fixture();
    const controller = new AbortController();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: controller.signal,
      queryFn: () => ({
        [Symbol.asyncIterator]: async function* () {
          controller.abort();
          yield { type: 'result', subtype: 'success' } as never;
        },
      }),
    });

    expect(result).toMatchObject({ ok: false, aborted: true, reason: 'aborted' });
  });

  it('fails cleanly before querying when the API key is missing', async () => {
    const { root } = fixture();
    delete process.env.ANTHROPIC_API_KEY;
    let queried = false;

    try {
      const result = await runDetect({
        cwd: root,
        onMessage: () => undefined,
        onPlan: () => undefined,
        signal: new AbortController().signal,
        queryFn: () => {
          queried = true;
          return stub([]);
        },
      });

      expect(result).toMatchObject({ ok: false, aborted: false, reason: 'no_api_key' });
      expect(queried).toBe(false);
    } finally {
      process.env.ANTHROPIC_API_KEY = 'test-only';
    }
  });

  it('maps query failures without throwing', async () => {
    const { root } = fixture();

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: () => {
        throw new Error('subprocess failed');
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'subprocess failed' });
  });

  it('allows intentional report_plan and ask_user shadow warnings', async () => {
    const { root, report } = fixture();
    const warning = Object.assign(
      new Error(
        'canUseTool will not be invoked for: mcp__onboard__report_plan, mcp__onboard__ask_user. Bare allowedTools entries auto-approve these tools.',
      ),
      { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' },
    );
    const queryFn = reportQuery(report);

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: (request) => {
        process.emit('warning', warning);
        return queryFn(request);
      },
    });

    expect(result.ok).toBe(true);
  });

  it('aborts safely on an unexpected permission-shadow warning', async () => {
    const { root } = fixture();
    const warning = Object.assign(
      new Error(
        'canUseTool will not be invoked for: Edit. Bare allowedTools entries auto-approve this tool.',
      ),
      { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' },
    );

    const result = await runDetect({
      cwd: root,
      onMessage: () => undefined,
      onPlan: () => undefined,
      signal: new AbortController().signal,
      queryFn: () => {
        process.emit('warning', warning);
        return stub([{ type: 'result', subtype: 'success' }]);
      },
    });

    expect(result).toMatchObject({ ok: false, aborted: false });
    expect(result.reason).toMatch(/shadowed.*Edit/i);
  });
});
