import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createE2BSandbox } = vi.hoisted(() => ({
  createE2BSandbox: vi.fn(),
}));

vi.mock('e2b', () => ({
  Sandbox: { create: createE2BSandbox },
}));

import { createSandboxRuntime } from '../sandbox-runtime.js';

const ENV_KEYS = [
  'OPSLANE_SANDBOX_BACKEND',
  'OPSLANE_RELIABILITY_HARNESS',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'DATABASE_URL',
  'MINIO_SECRET_KEY',
  'E2B_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe('createSandboxRuntime', () => {
  it('uses E2B by default', async () => {
    delete process.env['OPSLANE_SANDBOX_BACKEND'];
    const e2bRuntime = { marker: 'e2b' };
    createE2BSandbox.mockResolvedValue(e2bRuntime);

    await expect(createSandboxRuntime()).resolves.toBe(e2bRuntime);
    expect(createE2BSandbox).toHaveBeenCalledOnce();
  });

  it('maps virtual paths and commands into a disposable local filesystem', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    const sandbox = await createSandboxRuntime();

    await sandbox.files.write('/home/user/repo/input.txt', 'hello\n');
    const result = await sandbox.commands.run(
      'cd /home/user/repo && tr a-z A-Z < input.txt > output.txt && pwd',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/opslane-local-sandbox-.+\/home\/user\/repo/);
    await expect(sandbox.files.read('/home/user/repo/output.txt')).resolves.toBe('HELLO\n');

    await sandbox.kill();
    await expect(sandbox.files.read('/home/user/repo/output.txt')).rejects.toThrow('killed');
  });

  it('isolates temporary files and removes worker secrets from command environments', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    for (const key of ENV_KEYS.slice(2)) process.env[key] = `secret-${key}`;
    const sandbox = await createSandboxRuntime();

    await sandbox.files.write('/tmp/provider.patch', 'fixture');
    const tmpResult = await sandbox.commands.run('cat /tmp/provider.patch');
    expect(tmpResult.stdout).toBe('fixture');

    const envResult = await sandbox.commands.run(
      `node -e 'console.log(["ANTHROPIC_API_KEY","GITHUB_TOKEN","DATABASE_URL","MINIO_SECRET_KEY","E2B_API_KEY","LANGFUSE_PUBLIC_KEY","LANGFUSE_SECRET_KEY"].map(k => process.env[k] || "").join("|"))'`,
    );
    expect(envResult.stdout.trim()).toBe('||||||');

    await sandbox.kill();
  });

  it('rejects non-zero exits and timeouts like the remote command transport', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';
    const sandbox = await createSandboxRuntime();

    await expect(sandbox.commands.run('echo failed >&2; exit 7')).rejects.toMatchObject({
      exitCode: 7,
      stderr: 'failed\n',
    });
    await expect(sandbox.commands.run('sleep 1', { timeoutMs: 10 })).rejects.toThrow(/timed out/i);

    await sandbox.kill();
  });

  it('rejects unknown backends instead of silently falling back', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'elsewhere';
    await expect(createSandboxRuntime()).rejects.toThrow(
      'Unsupported OPSLANE_SANDBOX_BACKEND: elsewhere',
    );
    expect(createE2BSandbox).not.toHaveBeenCalled();
  });

  it('requires an explicit harness guard before running commands on the host', async () => {
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    delete process.env['OPSLANE_RELIABILITY_HARNESS'];
    await expect(createSandboxRuntime()).rejects.toThrow(
      'Local sandbox backend requires OPSLANE_RELIABILITY_HARNESS=1',
    );
  });
});
