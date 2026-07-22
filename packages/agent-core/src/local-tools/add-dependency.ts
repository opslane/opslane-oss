import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ToolSpec } from '../model-port.js';
import { containedPath } from './paths.js';

export const ALLOWED_DEPENDENCY = '@opslane/sdk';
const REGISTRY_DEPENDENCY_SPEC = `${ALLOWED_DEPENDENCY}@latest`;
export const FIXED_REGISTRY = 'https://registry.npmjs.org/';
const INSTALL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 12_000;

export interface ExecFileOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export type ExecFileRunner = (
  executable: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<{ stdout?: string; stderr?: string }>;

type SupportedPackageManager = 'pnpm' | 'npm';
type DetectedPackageManager = SupportedPackageManager | 'yarn' | 'bun';

export interface PackageManagerCommand {
  executable: string;
  argsPrefix: string[];
}

export type PackageManagerCommandResolver = (
  manager: SupportedPackageManager,
  root: string,
) => Promise<PackageManagerCommand>;

const execFileAsync = promisify(execFile);

const defaultRunner: ExecFileRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, args, options);
  return { stdout: result.stdout, stderr: result.stderr };
};

function cap(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS - 24)}\n... [output truncated]`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function selectPackageManager(root: string): Promise<DetectedPackageManager> {
  const packageJsonPath = await containedPath(root, 'package.json');
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  assertNoDependencyRedirects(manifest);
  await assertNoWorkspaceRedirects(root);
  await assertNoLocalPackageShadow(root);
  if (typeof manifest.packageManager === 'string') {
    if (!/^(?:pnpm|npm|yarn|bun)@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(manifest.packageManager)) {
      throw new Error('packageManager must use a supported manager with a plain semantic version');
    }
    const manager = manifest.packageManager.split('@', 1)[0];
    if (manager === 'pnpm' || manager === 'npm' || manager === 'yarn' || manager === 'bun') return manager;
    throw new Error(`Unsupported package manager: ${manager}`);
  }

  const candidates: ReadonlyArray<[string, 'pnpm' | 'npm' | 'yarn' | 'bun']> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [lockfile, manager] of candidates) {
    if (await fileExists(await containedPath(root, lockfile))) return manager;
  }
  throw new Error('Could not determine package manager');
}

function installArgs(manager: SupportedPackageManager): string[] {
  const action = manager === 'npm' ? 'install' : 'add';
  return [
    action,
    '--ignore-scripts',
    ...(manager === 'pnpm'
      ? [
          '--ignore-pnpmfile',
          '--force',
          '--config.prefer-workspace-packages=false',
          '--config.link-workspace-packages=false',
        ]
      : ['--no-audit', '--no-fund', '--force', '--workspaces=false']),
    `--registry=${FIXED_REGISTRY}`,
    `--@opslane:registry=${FIXED_REGISTRY}`,
    REGISTRY_DEPENDENCY_SPEC,
  ];
}

function assertNoDependencyRedirects(manifest: Record<string, unknown>): void {
  const pnpm = isRecord(manifest['pnpm']) ? manifest['pnpm'] : {};
  const redirectConfiguration = {
    overrides: manifest['overrides'],
    resolutions: manifest['resolutions'],
    patchedDependencies: manifest['patchedDependencies'],
    pnpmOverrides: pnpm['overrides'],
    pnpmPatchedDependencies: pnpm['patchedDependencies'],
  };
  if (Object.values(redirectConfiguration).some(hasConfiguration)) {
    throw new Error(`${ALLOWED_DEPENDENCY} may be redirected by repository package-manager configuration`);
  }
  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const section = isRecord(manifest[sectionName]) ? manifest[sectionName] : {};
    const current = section[ALLOWED_DEPENDENCY];
    if (typeof current === 'string' && !isRegistryVersionSpec(current)) {
      throw new Error(`${ALLOWED_DEPENDENCY} has a non-registry dependency specification`);
    }
  }
}

function hasConfiguration(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function isRegistryVersionSpec(specification: string): boolean {
  return /^(?:latest|next|beta|canary|[~^<>=*]|\d)/.test(specification.trim());
}

async function assertNoWorkspaceRedirects(root: string): Promise<void> {
  const workspacePath = await containedPath(root, 'pnpm-workspace.yaml');
  let contents: string;
  try {
    contents = await readFile(workspacePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const withoutComments = contents.replace(/^\s*#.*$/gm, '');
  if (/^\s*(?:overrides|patchedDependencies)\s*:/m.test(withoutComments)) {
    throw new Error('pnpm workspace overrides and patches are not allowed by the safe dependency installer');
  }
}

async function assertNoLocalPackageShadow(root: string): Promise<void> {
  const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
  const pending = [root];
  let visitedDirectories = 0;
  while (pending.length > 0) {
    if (++visitedDirectories > 2_000) {
      throw new Error('Repository is too large to verify dependency shadowing safely');
    }
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) pending.push(path);
      } else if (entry.isFile() && entry.name === 'package.json') {
        const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        if (manifest['name'] === ALLOWED_DEPENDENCY) {
          throw new Error(`Local package ${ALLOWED_DEPENDENCY} shadows the registry package`);
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizedEnvironment(userConfig: string, globalConfig: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    CI: '1',
    npm_config_ignore_scripts: 'true',
    npm_config_registry: FIXED_REGISTRY,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    COREPACK_ENV_FILE: '0',
    COREPACK_NPM_REGISTRY: FIXED_REGISTRY,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  };
}

async function createIsolatedConfigFiles(root: string): Promise<{
  directory: string;
  userConfig: string;
  globalConfig: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'opslane-package-manager-'));
  const directoryReal = await realpath(directory);
  const rootReal = await realpath(root);
  if (isWithin(rootReal, directoryReal)) {
    await rm(directoryReal, { recursive: true, force: true });
    throw new Error('Package-manager config directory must be outside the repository');
  }
  const userConfig = join(directoryReal, 'user.npmrc');
  const globalConfig = join(directoryReal, 'global.npmrc');
  try {
    await Promise.all([
      writeFile(userConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
      writeFile(globalConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
    ]);
  } catch (error) {
    await rm(directoryReal, { recursive: true, force: true });
    throw error;
  }
  return { directory: directoryReal, userConfig, globalConfig };
}

export async function resolveTrustedPackageManagerCommand(
  manager: SupportedPackageManager,
  root: string,
): Promise<PackageManagerCommand> {
  const rootReal = await realpath(root);
  const nodeExecutable = await realpath(process.execPath);
  const nodeBin = dirname(process.execPath);
  const entryCandidates = manager === 'npm'
    ? [
        join(nodeBin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(nodeBin, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(nodeBin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
        join(nodeBin, '..', 'lib', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
        join(nodeBin, '..', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
        join(nodeBin, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
      ];

  for (const candidate of entryCandidates) {
    try {
      const entry = await realpath(candidate);
      if (isWithin(rootReal, entry) || isWithin(rootReal, nodeExecutable)) {
        throw new Error('Trusted package manager executable must be outside the repository');
      }
      return { executable: nodeExecutable, argsPrefix: [entry] };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Could not locate a trusted ${manager} executable beside the Node.js runtime`);
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

export function createAddDependencyTool(
  root: string,
  run: ExecFileRunner = defaultRunner,
  resolveCommand: PackageManagerCommandResolver = resolveTrustedPackageManagerCommand,
): ToolSpec {
  return {
    name: 'add_dependency',
    description: `Add the approved ${ALLOWED_DEPENDENCY} package to an npm or pnpm project without running lifecycle scripts.`,
    schema: {
      type: 'object',
      properties: { name: { type: 'string', enum: [ALLOWED_DEPENDENCY] } },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async (input) => {
      if (input.name !== ALLOWED_DEPENDENCY) {
        throw new Error(`Only ${ALLOWED_DEPENDENCY} may be installed`);
      }
      const cwd = await containedPath(root, '.');
      const manager = await selectPackageManager(cwd);
      if (manager !== 'pnpm' && manager !== 'npm') {
        throw new Error(`Package manager ${manager} is not supported by the safe dependency installer`);
      }
      const command = await resolveCommand(manager, cwd);
      const config = await createIsolatedConfigFiles(cwd);
      try {
        const result = await run(command.executable, [...command.argsPrefix, ...installArgs(manager)], {
          cwd,
          timeout: INSTALL_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
          env: sanitizedEnvironment(config.userConfig, config.globalConfig),
        });
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        return cap(output || `Added ${ALLOWED_DEPENDENCY}`);
      } finally {
        await rm(config.directory, { recursive: true, force: true });
      }
    },
  };
}
