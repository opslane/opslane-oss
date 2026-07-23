import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  createAskServer,
  createAskUserTool,
  createFinishTool,
  type OnboardingReport,
} from '../tools.js';

const call = (tool: { handler: (input: never, extra: never) => Promise<unknown> }, input: unknown) =>
  tool.handler(input as never, {} as never);

type JsonRpcMessage = Record<string, unknown>;

class TestTransport {
  peer?: TestTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JsonRpcMessage) => void;
  readonly queued: JsonRpcMessage[] = [];

  async start(): Promise<void> {
    for (const message of this.queued.splice(0)) this.onmessage?.(message);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.peer === undefined) throw new Error('Test transport is not connected');
    if (this.peer.onmessage === undefined) this.peer.queued.push(message);
    else this.peer.onmessage(message);
  }

  async close(): Promise<void> {
    const peer = this.peer;
    this.peer = undefined;
    if (peer !== undefined) await peer.close();
    this.onclose?.();
  }
}

function linkedTransports(): [TestTransport, TestTransport] {
  const client = new TestTransport();
  const server = new TestTransport();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

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

describe('finish_onboarding', () => {
  let root: string;
  let report: OnboardingReport;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'opslane-finish-'));
    mkdirSync(join(root, 'web', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'web', 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
    );
    writeFileSync(join(root, 'web', 'src', 'main.ts'), '');
    report = {
      apps: [
        {
          dir: 'web',
          apiKeyVar: 'VITE_OPSLANE_API_KEY',
          endpointVar: 'VITE_OPSLANE_ENDPOINT',
          packageManager: 'pnpm',
          devScript: 'dev',
        },
      ],
      editedFiles: ['web/src/main.ts', 'web/package.json'],
    };
  });

  const finish = (state = { finished: false }) =>
    createFinishTool(root, state, () => undefined);

  it('accepts a validated report and marks the run finished', async () => {
    const state = { finished: false };
    let captured: OnboardingReport | undefined;

    await call(createFinishTool(root, state, (value) => (captured = value)), report);

    expect(state.finished).toBe(true);
    expect(captured).toEqual(report);
  });

  it('canonicalizes accepted paths for later edit reconciliation', async () => {
    let captured: OnboardingReport | undefined;
    const nonCanonical = {
      ...report,
      apps: [{ ...report.apps[0]!, dir: join(root, 'web') }],
      editedFiles: [join(root, 'web', 'src', '..', 'src', 'main.ts'), 'web/package.json'],
    };

    await call(createFinishTool(root, { finished: false }, (value) => (captured = value)), nonCanonical);

    expect(captured?.apps[0]?.dir).toBe('web');
    expect(captured?.editedFiles).toEqual(['web/src/main.ts', 'web/package.json']);
  });

  it.each([
    ['empty report', { apps: [], editedFiles: [] }, /exactly one/i],
    [
      'multiple apps',
      () => ({ ...report, apps: [report.apps[0]!, report.apps[0]!] }),
      /exactly one/i,
    ],
    [
      'path escape',
      () => ({ ...report, apps: [{ ...report.apps[0]!, dir: '../../etc' }] }),
      /contain/i,
    ],
    [
      'secret file',
      () => ({ ...report, editedFiles: ['web/.env.production'] }),
      /secret/i,
    ],
    [
      'borrowed product variable',
      () => ({
        ...report,
        apps: [{ ...report.apps[0]!, apiKeyVar: 'VITE_APP_DEFENDER_API_KEY' }],
      }),
      /opslane/i,
    ],
    [
      'endpoint variable without Opslane token',
      () => ({
        ...report,
        apps: [{ ...report.apps[0]!, endpointVar: 'VITE_API_ENDPOINT' }],
      }),
      /opslane/i,
    ],
    [
      'invalid variable',
      () => ({ ...report, apps: [{ ...report.apps[0]!, apiKeyVar: 'BAD=X\nY' }] }),
      /variable/i,
    ],
    [
      'unknown package manager',
      () => ({ ...report, apps: [{ ...report.apps[0]!, packageManager: 'curl|sh' }] }),
      /package manager/i,
    ],
    [
      'missing dev script',
      () => ({ ...report, apps: [{ ...report.apps[0]!, devScript: 'nope' }] }),
      /script/i,
    ],
  ])('rejects %s', async (_name, input, message) => {
    const value = typeof input === 'function' ? input() : input;
    await expect(call(finish(), value)).rejects.toThrow(message);
  });

  it('keeps state unfinished after rejection and refuses a duplicate finish', async () => {
    const state = { finished: false };
    const tool = createFinishTool(root, state, () => undefined);

    await expect(call(tool, { apps: [], editedFiles: [] })).rejects.toThrow();
    expect(state.finished).toBe(false);
    await call(tool, report);
    expect(state.finished).toBe(true);
    await expect(call(tool, report)).rejects.toThrow(/already/i);
  });

  it('registers finish_onboarding and its schema on the MCP server', () => {
    const tool = finish();
    const server = createAskServer(tool);
    const registered = (
      server.instance as unknown as {
        _registeredTools: Record<string, { inputSchema?: unknown }>;
      }
    )._registeredTools;

    expect(registered.finish_onboarding?.inputSchema).toBeDefined();
  });

  it('strips unknown keys through an in-process MCP tool call', async () => {
    let captured: OnboardingReport | undefined;
    const server = createAskServer(
      createFinishTool(root, { finished: false }, (value) => (captured = value)),
    );
    const [clientTransport, serverTransport] = linkedTransports();
    const pending = new Map<number, (message: JsonRpcMessage) => void>();
    let nextRequestId = 0;
    clientTransport.onmessage = (message) => {
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    };
    const request = (method: string, params: Record<string, unknown>) => {
      const id = ++nextRequestId;
      return new Promise<JsonRpcMessage>((resolve) => {
        pending.set(id, resolve);
        void clientTransport.send({ jsonrpc: '2.0', id, method, params });
      });
    };

    await server.instance.connect(serverTransport as never);
    await clientTransport.start();
    await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'opslane-test', version: '0.0.0' },
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const response = await request('tools/call', {
      name: 'finish_onboarding',
      arguments: {
        ...report,
        sneaky: true,
        apps: [{ ...report.apps[0]!, sneaky: true }],
      },
    });
    await server.instance.close();

    expect(response.error).toBeUndefined();
    expect(captured).toEqual(report);
  });
});
