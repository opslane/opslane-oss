import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_DEPENDENCY,
  createAddDependencyTool,
  FIXED_REGISTRY,
  resolveTrustedPackageManagerCommand,
  type ExecFileRunner,
  type PackageManagerCommandResolver,
} from '../add-dependency.js';

const roots: string[] = [];

async function project(manifest: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opslane-dependency-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('add_dependency', () => {
  const trustedCommand: PackageManagerCommandResolver = async (manager) => ({
    executable: '/trusted/node',
    argsPrefix: [`/trusted/${manager}.js`],
  });

  it('uses packageManager first and executes a fixed argv without a shell', async () => {
    const root = await project({ packageManager: 'pnpm@10.6.4' });
    const run = vi.fn<ExecFileRunner>().mockResolvedValue({ stdout: 'installed' });
    const output = await createAddDependencyTool(root, run, trustedCommand).execute({ name: ALLOWED_DEPENDENCY });

    expect(output).toBe('installed');
    expect(run).toHaveBeenCalledOnce();
    const [executable, args, options] = run.mock.calls[0];
    expect(executable).toBe('/trusted/node');
    expect(args).toEqual([
      '/trusted/pnpm.js',
      'add',
      '--ignore-scripts',
      '--ignore-pnpmfile',
      '--force',
      '--config.prefer-workspace-packages=false',
      '--config.link-workspace-packages=false',
      `--registry=${FIXED_REGISTRY}`,
      `--@opslane:registry=${FIXED_REGISTRY}`,
      `${ALLOWED_DEPENDENCY}@latest`,
    ]);
    expect(options).toMatchObject({ cwd: await realpath(root), timeout: 60_000, maxBuffer: 256 * 1024 });
    expect(options).not.toHaveProperty('shell');
    expect(options.env).not.toHaveProperty('PATH');
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(options.env.npm_config_userconfig).not.toBe(options.env.npm_config_globalconfig);
    expect(options.env.npm_config_userconfig).toContain('opslane-package-manager-');
    expect(options.env.npm_config_globalconfig).toContain('opslane-package-manager-');
    await expect(access(options.env.npm_config_userconfig!)).rejects.toThrow();
    await expect(access(options.env.npm_config_globalconfig!)).rejects.toThrow();
  });

  it('falls back to the lockfile', async () => {
    const root = await project();
    await writeFile(join(root, 'package-lock.json'), '{}');
    const run = vi.fn<ExecFileRunner>().mockResolvedValue({});
    await createAddDependencyTool(root, run, trustedCommand).execute({ name: ALLOWED_DEPENDENCY });
    expect(run.mock.calls[0][1]).toContain('/trusted/npm.js');
  });

  it('rejects every unapproved package before execution', async () => {
    const root = await project({ packageManager: 'npm@11.0.0' });
    const run = vi.fn<ExecFileRunner>();
    await expect(createAddDependencyTool(root, run, trustedCommand).execute({ name: 'evil' })).rejects.toThrow(/Only @opslane\/sdk/);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects package managers whose project configuration can load executable plugins', async () => {
    const root = await project({ packageManager: 'yarn@4.12.0' });
    const run = vi.fn<ExecFileRunner>();
    await expect(createAddDependencyTool(root, run, trustedCommand).execute({ name: ALLOWED_DEPENDENCY }))
      .rejects.toThrow(/not supported by the safe dependency installer/);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects overrides and local workspace packages before execution', async () => {
    const overridden = await project({
      packageManager: 'pnpm@10.6.4',
      pnpm: { overrides: { [ALLOWED_DEPENDENCY]: 'file:./evil' } },
    });
    const run = vi.fn<ExecFileRunner>();
    await expect(createAddDependencyTool(overridden, run, trustedCommand).execute({ name: ALLOWED_DEPENDENCY }))
      .rejects.toThrow(/redirected/);

    const shadowed = await project({ packageManager: 'pnpm@10.6.4' });
    await mkdir(join(shadowed, 'packages', 'sdk'), { recursive: true });
    await writeFile(join(shadowed, 'packages', 'sdk', 'package.json'), JSON.stringify({ name: ALLOWED_DEPENDENCY }));
    await expect(createAddDependencyTool(shadowed, run, trustedCommand).execute({ name: ALLOWED_DEPENDENCY }))
      .rejects.toThrow(/shadows/);

    const localSpec = await project({
      packageManager: 'pnpm@10.6.4',
      dependencies: { [ALLOWED_DEPENDENCY]: 'file:./evil' },
    });
    await expect(createAddDependencyTool(localSpec, run, trustedCommand).execute({ name: ALLOWED_DEPENDENCY }))
      .rejects.toThrow(/non-registry/);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects packageManager URLs before resolving an executable', async () => {
    const root = await project({ packageManager: 'pnpm@https://evil.example/pnpm.tgz' });
    const run = vi.fn<ExecFileRunner>();
    await expect(createAddDependencyTool(root, run, trustedCommand).execute({ name: ALLOWED_DEPENDENCY }))
      .rejects.toThrow(/plain semantic version/);
    expect(run).not.toHaveBeenCalled();
  });

  it('resolves Node-owned package-manager code instead of a repository PATH entry', async () => {
    const root = await project({ packageManager: 'pnpm@10.6.4' });
    const fakeBin = join(root, 'bin');
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, 'pnpm'), '#!/bin/sh\nexit 99\n');
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    try {
      const command = await resolveTrustedPackageManagerCommand('pnpm', root);
      expect(command.executable).toBe(await realpath(process.execPath));
      expect(command.argsPrefix.join(' ')).not.toContain(root);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
