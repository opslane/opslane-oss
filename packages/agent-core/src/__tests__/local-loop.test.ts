import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelPort, ModelResponse } from '../model-port.js';
import { toolLoop, type AgentEvent } from '../tool-loop.js';
import { ALLOWED_DEPENDENCY, type ExecFileRunner } from '../local-tools/add-dependency.js';
import { SecretVault } from '../local-tools/secrets.js';
import { createLocalToolset } from '../local-tools/toolset.js';

const roots: string[] = [];
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opslane-local-loop-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.6.4' }));
  return root;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function scriptedPort(responses: ModelResponse[], requests: Parameters<ModelPort['generate']>[0][] = []): ModelPort {
  return {
    async generate(request) {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error('Script exhausted');
      return response;
    },
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): ModelResponse {
  return { content: [{ type: 'tool_use', id, name, input }], usage, stopReason: 'tool_use' };
}

const pricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe('local tool loop', () => {
  it('runs read, write, and constrained dependency installation end to end', async () => {
    const root = await temporaryProject();
    const install = vi.fn<ExecFileRunner>().mockResolvedValue({ stdout: 'installed' });
    const vault = new SecretVault({ api: 'host-only-secret' });
    const local = createLocalToolset(root, vault, {
      execFile: install,
      resolvePackageManagerCommand: async () => ({
        executable: '/trusted/node',
        argsPrefix: ['/trusted/pnpm.js'],
      }),
    });
    const events: AgentEvent[] = [];
    const requests: Parameters<ModelPort['generate']>[0][] = [];
    const port = scriptedPort([
      toolUse('read-1', 'read', { path: 'package.json' }),
      toolUse('write-1', 'write', { path: 'src/opslane.ts', content: 'export const ready = true;\n' }),
      toolUse('add-1', 'add_dependency', { name: ALLOWED_DEPENDENCY }),
      { content: [{ type: 'text', text: 'Setup complete' }], usage, stopReason: 'end_turn' },
    ], requests);

    const result = await toolLoop(port, {
      model: 'scripted',
      systemPrompt: 'Set up the project',
      userMessage: 'Begin',
      maxTurns: 5,
      tools: local.tools,
      onEvent: (event) => events.push(event),
      pricing,
      redact: local.redact,
    });

    expect(result.success).toBe(true);
    expect(await readFile(join(root, 'src', 'opslane.ts'), 'utf8')).toBe('export const ready = true;\n');
    expect(install).toHaveBeenCalledOnce();
    expect(install.mock.calls[0][0]).toBe('/trusted/node');
    expect(install.mock.calls[0][1]).toContain('/trusted/pnpm.js');
    expect(install.mock.calls[0][1]).toContain('--ignore-scripts');
    expect(install.mock.calls[0][1]).toContain(`${ALLOWED_DEPENDENCY}@latest`);
    expect(requests[0].tools.map((tool) => tool.name)).not.toContain('bash');
    expect(events.some((event) => event.type === 'completed')).toBe(true);
  });

  it('blocks unapproved installs and path escapes and redacts every emitted event and model turn', async () => {
    const root = await temporaryProject();
    const secret = 'never-emit-this-value';
    const vault = new SecretVault({ api: secret });
    const install = vi.fn<ExecFileRunner>();
    const local = createLocalToolset(root, vault, { execFile: install });
    const events: AgentEvent[] = [];
    const requests: Parameters<ModelPort['generate']>[0][] = [];
    const escapedName = `opslane-escaped-${basename(root)}`;
    const escapedPath = join(dirname(root), escapedName);
    const port = scriptedPort([
      {
        content: [
          { type: 'text', text: `attempting ${secret}` },
          { type: 'tool_use', id: 'evil-1', name: 'add_dependency', input: { name: 'evil' } },
          { type: 'tool_use', id: 'escape-1', name: 'write', input: { path: `../${escapedName}`, content: 'escaped' } },
        ],
        usage,
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: `finished ${secret}` }], usage, stopReason: 'end_turn' },
    ], requests);

    await toolLoop(port, {
      model: 'scripted',
      systemPrompt: `Do not reveal ${secret}`,
      userMessage: `start ${secret}`,
      maxTurns: 3,
      tools: local.tools,
      onEvent: (event) => events.push(event),
      pricing,
      redact: local.redact,
    });

    expect(install).not.toHaveBeenCalled();
    await expect(access(escapedPath)).rejects.toThrow();
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(requests)).not.toContain(secret);
    expect(events.filter((event) => event.type === 'tool_result' && event.isError)).toHaveLength(2);
  });
});
