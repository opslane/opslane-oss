import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Sandbox } from 'e2b';
import type { Platform } from '../platform.js';

const execFile = promisify(execFileCallback);
const VIRTUAL_HOME = '/home/user';
/** Must match the template name in packages/worker/e2b-python/e2b.toml. */
const DEFAULT_PYTHON_TEMPLATE = 'opslane-python';
const PYTHON_SANDBOX_LIFETIME_MS = 1_800_000;
const VIRTUAL_TMP = '/tmp';

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The small portion of the E2B API used by the agent and verification harness. */
export interface SandboxRuntime {
  commands: {
    run(command: string, options?: { timeoutMs?: number }): Promise<SandboxCommandResult>;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<unknown>;
  };
  kill(): Promise<unknown>;
}

/**
 * Create the configured sandbox runtime. Production remains on E2B unless the
 * local backend is selected explicitly by the deterministic reliability harness.
 * The local backend is a transport test double, not a security boundary, and
 * must only execute trusted fixture repositories and scripted model commands.
 */
export async function createSandboxRuntime(platform: Platform = 'javascript'): Promise<SandboxRuntime> {
  const backend = process.env['OPSLANE_SANDBOX_BACKEND']?.trim().toLowerCase() || 'e2b';
  if (backend === 'e2b') {
    // Python installs (pip build backends, compiled wheels) run far longer than
    // npm, so the Python path gets an extended lifetime. The JavaScript path
    // keeps the E2B default: raising it there would multiply billed sandbox
    // time and leak duration on a worker crash for no benefit.
    if (platform !== 'python') return Sandbox.create();
    const template = process.env['OPSLANE_E2B_PYTHON_TEMPLATE']?.trim() || DEFAULT_PYTHON_TEMPLATE;
    return Sandbox.create(template, { timeoutMs: PYTHON_SANDBOX_LIFETIME_MS });
  }
  if (backend === 'local') {
    if (process.env['OPSLANE_RELIABILITY_HARNESS'] !== '1') {
      throw new Error('Local sandbox backend requires OPSLANE_RELIABILITY_HARNESS=1');
    }
    return createLocalSandboxRuntime();
  }
  throw new Error(`Unsupported OPSLANE_SANDBOX_BACKEND: ${backend}`);
}

interface CommandFailure extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

class LocalCommandError extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, failure: CommandFailure) {
    super(message);
    this.name = 'LocalCommandError';
    this.exitCode = typeof failure.code === 'number' ? failure.code : null;
    this.stdout = String(failure.stdout ?? '');
    this.stderr = String(failure.stderr ?? '');
  }
}

async function createLocalSandboxRuntime(): Promise<SandboxRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'opslane-local-sandbox-'));
  const home = join(root, 'home', 'user');
  const localTmp = join(root, 'tmp');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(localTmp, { recursive: true }),
  ]);

  let killed = false;

  const ensureRunning = (): void => {
    if (killed) throw new Error('Sandbox has been killed');
  };

  const mapPath = (path: string): string => {
    ensureRunning();
    let mapped: string;
    if (path === VIRTUAL_HOME || path.startsWith(`${VIRTUAL_HOME}/`)) {
      mapped = join(root, path.slice(1));
    } else if (path === VIRTUAL_TMP || path.startsWith(`${VIRTUAL_TMP}/`)) {
      mapped = join(localTmp, path.slice(VIRTUAL_TMP.length + 1));
    } else if (!isAbsolute(path)) {
      mapped = resolve(root, path);
    } else {
      throw new Error(`Local sandbox path is outside the virtual filesystem: ${path}`);
    }

    const fromRoot = relative(root, mapped);
    if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Local sandbox path escapes the virtual filesystem: ${path}`);
    }
    return mapped;
  };

  const rewriteCommand = (command: string): string => {
    // Fixture repositories are passed as host file:// URLs. Preserve those URLs
    // while translating virtual sandbox paths; on Linux both live under /tmp,
    // so a blind replacement redirects git to a nonexistent path inside root.
    const hostFileUrls: string[] = [];
    const protectedCommand = command.replace(/file:\/\/[^\s'"]+/g, (url) => {
      const placeholder = `__OPSLANE_HOST_FILE_URL_${hostFileUrls.length}__`;
      hostFileUrls.push(url);
      return placeholder;
    });

    let rewritten = protectedCommand
      .replaceAll(VIRTUAL_TMP, localTmp)
      .replaceAll(VIRTUAL_HOME, home);
    for (const [index, url] of hostFileUrls.entries()) {
      rewritten = rewritten.replaceAll(`__OPSLANE_HOST_FILE_URL_${index}__`, url);
    }
    return rewritten;
  };

  const commandEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'CI']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env['HOME'] = home;
    env['TMPDIR'] = localTmp;
    return env;
  };

  return {
    commands: {
      async run(command, options) {
        ensureRunning();
        const timeoutMs = options?.timeoutMs;
        try {
          const result = await execFile('/bin/sh', ['-c', rewriteCommand(command)], {
            cwd: root,
            env: commandEnv(),
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
          });
          return {
            exitCode: 0,
            stdout: String(result.stdout ?? ''),
            stderr: String(result.stderr ?? ''),
          };
        } catch (error: unknown) {
          const failure = error as CommandFailure;
          const timedOut = failure.killed === true || failure.signal === 'SIGTERM';
          const detail = String(failure.stderr ?? failure.stdout ?? failure.message ?? '').trim();
          const message = timedOut
            ? `Command timed out after ${timeoutMs ?? 0}ms${detail ? `: ${detail}` : ''}`
            : `Command exited with code ${String(failure.code ?? 'unknown')}${detail ? `: ${detail}` : ''}`;
          throw new LocalCommandError(message, failure);
        }
      },
    },
    files: {
      async read(path) {
        return readFile(mapPath(path), 'utf8');
      },
      async write(path, data) {
        const mapped = mapPath(path);
        await mkdir(dirname(mapped), { recursive: true });
        await writeFile(mapped, data, 'utf8');
      },
    },
    async kill() {
      if (killed) return;
      killed = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}
