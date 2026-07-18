import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntime } from '../sandbox-runtime.js';

const state = vi.hoisted(() => ({
  commands: [] as string[],
  failWhenIncludes: undefined as string | undefined,
  kill: vi.fn(async () => undefined),
}));

vi.mock('../sandbox-runtime.js', () => ({
  createSandboxRuntime: vi.fn(async (): Promise<SandboxRuntime> => ({
    commands: {
      run: async (command: string) => {
        state.commands.push(command);
        if (state.failWhenIncludes && command.includes(state.failWhenIncludes)) {
          throw new Error(`command failed: ${state.failWhenIncludes}`);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    files: {
      read: async () => { throw new Error('not found'); },
      write: async () => undefined,
    },
    kill: state.kill,
  })),
}));

const { createRepoSandbox } = await import('../sandbox-repo.js');

beforeEach(() => {
  state.commands.length = 0;
  state.failWhenIncludes = undefined;
  state.kill.mockClear();
});

describe('createRepoSandbox setupCommands', () => {
  it('runs setup commands after the baseline commit and commits them separately', async () => {
    await createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
      defaultBranch: 'main',
      setupCommands: ['git apply bug.patch'],
    });

    const baselineIndex = state.commands.findIndex((command) => command.includes('baseline: setup'));
    const setupIndex = state.commands.findIndex((command) => command.includes('git apply bug.patch'));
    const evalCommitIndex = state.commands.findIndex((command) => command.includes('eval: setup'));
    expect(baselineIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeGreaterThan(baselineIndex);
    expect(evalCommitIndex).toBeGreaterThan(setupIndex);
  });

  it('runs no eval commit when setupCommands is absent', async () => {
    await createRepoSandbox({ repoUrl: 'https://github.com/o/r.git', defaultBranch: 'main' });

    expect(state.commands.some((command) => command.includes('eval: setup'))).toBe(false);
  });

  it('kills the sandbox and propagates when a setup command fails', async () => {
    state.failWhenIncludes = 'git apply bug.patch';

    await expect(createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
      defaultBranch: 'main',
      setupCommands: ['git apply bug.patch'],
    })).rejects.toThrow('command failed: git apply bug.patch');

    expect(state.kill).toHaveBeenCalledTimes(1);
  });

  it('kills the sandbox and propagates when the baseline commit fails', async () => {
    state.failWhenIncludes = 'baseline: setup';

    await expect(createRepoSandbox({
      repoUrl: 'https://github.com/o/r.git',
      defaultBranch: 'main',
    })).rejects.toThrow('command failed: baseline: setup');

    expect(state.kill).toHaveBeenCalledTimes(1);
  });
});
