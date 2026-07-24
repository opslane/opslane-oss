import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createAskUserTool,
  createOnboardServer,
  createReportPlanTool,
  type OnboardingPlan,
  type ReportedPlanInput,
} from '../tools.js';

const call = (tool: { handler: (input: never, extra: never) => Promise<unknown> }, input: unknown) =>
  tool.handler(input as never, {} as never);

describe('ask_user', () => {
  it('routes each tool instance to its own resolver', async () => {
    const tool = createAskUserTool(async ({ options }) => [options[1]!]);

    const result = await call(tool, { question: 'Which?', options: ['a', 'b'], multi: false });

    expect((result as { content: unknown[] }).content[0]).toEqual({
      type: 'text',
      text: 'User chose: b',
    });
  });

  it('fails closed when a resolver is not installed', async () => {
    const tool = createAskUserTool(null);

    await expect(call(tool, { question: 'Which?', options: ['a'], multi: false })).rejects.toThrow(
      /resolver not installed/i,
    );
  });
});

describe('report_plan', () => {
  let root: string;
  let entryFile: string;
  let entryContents: string;
  let plan: ReportedPlanInput;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opslane-plan-'));
    mkdirSync(join(root, 'web', 'src'), { recursive: true });
    entryFile = join(root, 'web', 'src', 'main.ts');
    entryContents = "import App from './App.vue';\ncreateApp(App).mount('#app');\n";
    writeFileSync(entryFile, entryContents);
    plan = {
      app_dir: 'web',
      framework: 'vue-vite',
      package_manager: 'pnpm',
      env_prefix: 'VITE_',
      dependency: { name: '@opslane/sdk', version: '^1.0.0' },
      env_vars: {
        api_key: 'VITE_OPSLANE_API_KEY',
        endpoint: 'VITE_OPSLANE_ENDPOINT',
      },
      edit: {
        file: 'web/src/main.ts',
        import_line: "import { init } from '@opslane/sdk';",
        init_block:
          'init({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY, endpoint: import.meta.env.VITE_OPSLANE_ENDPOINT });',
        anchor: "createApp(App).mount('#app');",
        position: 'before',
        occurrence: 0,
      },
      existing_sdk: { action: 'keep', name: '@sentry/vue' },
      rationale: 'Initialize monitoring immediately before the application mounts.',
    };
  });

  const report = (value: unknown, onPlan: (accepted: OnboardingPlan) => void = () => undefined) =>
    call(createReportPlanTool(root, onPlan), value);

  it('accepts and canonicalizes a valid plan exactly once', async () => {
    let captured: OnboardingPlan | undefined;
    const tool = createReportPlanTool(root, (accepted) => {
      captured = accepted;
    });
    const nonCanonical = {
      status: 'ok',
      plan: {
        ...plan,
        app_dir: join(root, 'web'),
        edit: { ...plan.edit, file: join(root, 'web', 'src', '..', 'src', 'main.ts') },
      },
    };

    await call(tool, nonCanonical);

    // The HOST stamps entry_hash from the file it already reads. The model never
    // supplies it — it has only Read/Glob/search and cannot compute a sha256, so
    // requiring it made report_plan unsatisfiable and starved the run of a plan.
    expect(captured).toEqual({
      ...plan,
      edit: {
        ...plan.edit,
        entry_hash: createHash('sha256').update(entryContents).digest('hex'),
      },
    });
    await expect(call(tool, { status: 'ok', plan })).rejects.toThrow(/already/i);
  });

  it.each([
    ['an empty string field', () => ({ ...plan, framework: '' }), /non-empty/i],
    ['an app path escape', () => ({ ...plan, app_dir: '../outside' }), /contain/i],
    [
      'a secret edit file',
      () => {
        writeFileSync(join(root, 'web', '.env.production'), entryContents);
        return {
          ...plan,
          edit: {
            ...plan.edit,
            file: 'web/.env.production',
          },
        };
      },
      /secret/i,
    ],
    [
      'an edit outside app_dir',
      () => {
        writeFileSync(join(root, 'outside.ts'), entryContents);
        return {
          ...plan,
          edit: {
            ...plan.edit,
            file: 'outside.ts',
          },
        };
      },
      /app_dir/i,
    ],
    ['a missing edit file', () => ({ ...plan, edit: { ...plan.edit, file: 'web/src/nope.ts' } }), /exist/i],
    [
      'a variable outside the app prefix',
      () => ({ ...plan, env_vars: { ...plan.env_vars, api_key: 'NEXT_PUBLIC_OPSLANE_API_KEY' } }),
      /prefix/i,
    ],
    [
      'a variable borrowed from another product',
      () => ({ ...plan, env_vars: { ...plan.env_vars, api_key: 'VITE_APP_DEFENDER_API_KEY' } }),
      /opslane/i,
    ],
    ['an unknown package manager', () => ({ ...plan, package_manager: 'curl|sh' }), /package manager/i],
    ['an absent anchor', () => ({ ...plan, edit: { ...plan.edit, anchor: 'not in the file' } }), /anchor/i],
    [
      'an unavailable anchor occurrence',
      () => ({ ...plan, edit: { ...plan.edit, occurrence: 1 } }),
      /occurrence/i,
    ],
    [
      'an unknown existing SDK action',
      () => ({ ...plan, existing_sdk: { ...plan.existing_sdk, action: 'replace_everything' } }),
      /existing SDK action/i,
    ],
  ])('rejects %s', async (_name, makePlan, message) => {
    await expect(report({ status: 'ok', plan: makePlan() })).rejects.toThrow(message);
  });

  it('accepts an unsupported result without plan fields', async () => {
    let reason: string | undefined;
    let plans = 0;
    const tool = createReportPlanTool(
      root,
      () => {
        plans += 1;
      },
      (value) => {
        reason = value;
      },
    );

    await call(tool, { status: 'unsupported', reason: 'no web app: Go services only' });

    expect(reason).toBe('no web app: Go services only');
    expect(plans).toBe(0);
  });

  it.each([
    [{ status: 'unsupported', reason: '' }, /reason/i],
    [{ status: 'unsupported' }, /reason/i],
    [{ status: 'unsupported', reason: 'no web app', plan: {} }, /must not include a plan/i],
    [{ status: 'ok' }, /plan/i],
    [{ status: 'ok', plan: {}, reason: 'not applicable' }, /must not include.*reason/i],
  ])('rejects an incomplete discriminated result', async (input, message) => {
    await expect(report(input)).rejects.toThrow(message);
  });

  it('registers report_plan with an input schema on the MCP server', () => {
    const server = createOnboardServer(createReportPlanTool(root, () => undefined));
    const registered = (
      server.instance as unknown as {
        _registeredTools: Record<string, { inputSchema?: unknown }>;
      }
    )._registeredTools;

    expect(registered.report_plan?.inputSchema).toBeDefined();
  });
});
