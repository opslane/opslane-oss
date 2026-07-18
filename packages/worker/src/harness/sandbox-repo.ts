import type { CheckOutcome } from '@opslane/shared';
import { logger } from '../logger.js';
import { buildGitNetrc } from '../repo-clone.js';
import { scrubSecrets } from './redact.js';
import { createSandboxRuntime, type SandboxRuntime } from './sandbox-runtime.js';

const SANDBOX_REPO = '/home/user/repo';

interface PackageJsonLike {
  scripts?: Record<string, string>;
}

/** Pick the build/typecheck command. tsconfigExists enables the tsc fallback. */
export function selectBuildCommand(
  pkg: PackageJsonLike,
  tsconfigExists: boolean,
  pm: 'npm' | 'pnpm' | 'yarn' = 'npm',
): string | null {
  if (pkg.scripts?.['build']) {
    return pm === 'npm' ? 'npm run build' : `${pm} run build`;
  }
  if (tsconfigExists) return 'npx tsc --noEmit';
  return null;
}

export function parseAffectedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      const file = line.slice(6);
      if (file !== '/dev/null') files.add(file);
    }
  }
  return [...files];
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RepoSandbox {
  sandbox: SandboxRuntime;
  installSucceeded: boolean;
}

const SANDBOX_NODE_VERSION = '22.17.0';

/**
 * The default E2B image ships Node 20.9, which predates crypto.hash() and
 * breaks modern Vite plugins (they require >= 20.12). Install a user-space
 * Node when the sandbox's Node is too old; later command shells pick it up
 * through ~/.profile and ~/.bashrc.
 */
async function ensureModernNode(sandbox: SandboxRuntime): Promise<void> {
  try {
    await sandbox.commands.run(
      `node -e "if (typeof require('crypto').hash !== 'function') process.exit(1)"`,
    );
    return;
  } catch {
    // Node is missing or too old — install below.
  }
  const url = `https://nodejs.org/dist/v${SANDBOX_NODE_VERSION}/node-v${SANDBOX_NODE_VERSION}-linux-x64.tar.xz`;
  await sandbox.commands.run(
    `curl -fsSL ${url} -o /tmp/node.tar.xz` +
      ' && mkdir -p ~/.opslane-node && tar -xJf /tmp/node.tar.xz -C ~/.opslane-node --strip-components=1' +
      ` && echo 'export PATH="$HOME/.opslane-node/bin:$PATH"' >> ~/.profile` +
      ` && echo 'export PATH="$HOME/.opslane-node/bin:$PATH"' >> ~/.bashrc`,
    { timeoutMs: 180_000 },
  );
}

/**
 * Create an E2B sandbox, clone the repo via .netrc auth, install deps, and
 * commit a baseline so a later diff captures only the agent's work.
 */
export async function createRepoSandbox(opts: {
  repoUrl: string;
  defaultBranch: string;
  githubToken?: string;
  /** Commands applied after the baseline commit and committed separately. */
  setupCommands?: string[];
}): Promise<RepoSandbox> {
  const sandbox = await createSandboxRuntime();
  try {
    await ensureModernNode(sandbox);
    await sandbox.commands.run('git config --global user.email "opslane-agent@opslane.com" && git config --global user.name "Opslane Agent"');

    const token = opts.githubToken ?? process.env['GITHUB_TOKEN'] ?? '';
    const gitNetrc = token ? buildGitNetrc(opts.repoUrl, token) : null;
    if (gitNetrc) {
      await sandbox.files.write('/home/user/.netrc', gitNetrc);
      await sandbox.commands.run('chmod 600 /home/user/.netrc');
    }

    try {
      await sandbox.commands.run(
        `git clone --depth 1 --branch ${shellEscape(opts.defaultBranch)} ${shellEscape(opts.repoUrl)} ${SANDBOX_REPO}`,
        { timeoutMs: 120_000 },
      );
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err))
        .replace(/https:\/\/[^@]+@/g, 'https://***@');
      throw new Error(`clone failed: ${msg}`);
    }

    if (gitNetrc) await sandbox.commands.run('rm -f /home/user/.netrc');

    await sandbox.commands.run(
      `cd ${SANDBOX_REPO} && printf "\\nnode_modules\\n.cache\\ncoverage\\n" >> .gitignore`,
      { timeoutMs: 10_000 },
    );

    let installSucceeded = false;
    try {
      await sandbox.commands.run(
        `cd ${SANDBOX_REPO} && if [ -f pnpm-lock.yaml ]; then pnpm install; elif [ -f yarn.lock ]; then yarn install; elif [ -f package.json ]; then npm install; else echo "no package.json"; fi`,
        { timeoutMs: 120_000 },
      );
      installSucceeded = true;
    } catch (err: unknown) {
      logger.warn('setup install failed; continuing', { error: err instanceof Error ? err.message : String(err) });
    }

    await sandbox.commands.run(
      `cd ${SANDBOX_REPO} && git add -A && git commit -m "baseline: setup" --allow-empty`,
      { timeoutMs: 30_000 },
    );

    if (opts.setupCommands && opts.setupCommands.length > 0) {
      for (const command of opts.setupCommands) {
        await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${command}`, { timeoutMs: 60_000 });
      }
      await sandbox.commands.run(
        `cd ${SANDBOX_REPO} && git add -A && git commit -m "eval: setup" --allow-empty`,
        { timeoutMs: 30_000 },
      );
    }

    return { sandbox, installSucceeded };
  } catch (err: unknown) {
    await sandbox.kill().catch(() => {});
    throw err;
  }
}

/** Extract the agent's change as a unified diff. */
export async function extractDiff(sandbox: SandboxRuntime): Promise<{ diff: string; affectedFiles: string[] }> {
  await sandbox.commands.run(`cd ${SANDBOX_REPO} && git add -A`, { timeoutMs: 30_000 });
  const res = await sandbox.commands.run(`cd ${SANDBOX_REPO} && git diff --cached`, { timeoutMs: 30_000 });
  const raw = (res.stdout ?? '').replace(/\r\n/g, '\n');
  const diff = raw.endsWith('\n') ? raw : raw + '\n';
  return { diff, affectedFiles: parseAffectedFiles(diff) };
}

export interface BuildGateResult {
  outcome: CheckOutcome;
  exitCode?: number;
  output: string;
}

interface BuildFailureLike {
  message?: string;
  exitCode?: number | null;
  stdout?: unknown;
  stderr?: unknown;
}

function buildFailureExitCode(error: unknown): number | undefined {
  const failure = error as BuildFailureLike;
  if (typeof failure.exitCode === 'number') return failure.exitCode;
  const match = String(failure.message ?? '').match(/exited with code (\d+)/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Run the build/typecheck gate using the verification outcome taxonomy. */
export async function runBuildGate(sandbox: SandboxRuntime): Promise<BuildGateResult> {
  let pkg: PackageJsonLike = {};
  try {
    const raw = await sandbox.files.read(`${SANDBOX_REPO}/package.json`);
    pkg = JSON.parse(raw) as PackageJsonLike;
  } catch {
    // no package.json
  }

  const tsconfigExists = await fileExists(sandbox, `${SANDBOX_REPO}/tsconfig.json`);
  const pm: 'npm' | 'pnpm' | 'yarn' =
    (await fileExists(sandbox, `${SANDBOX_REPO}/pnpm-lock.yaml`)) ? 'pnpm'
      : (await fileExists(sandbox, `${SANDBOX_REPO}/yarn.lock`)) ? 'yarn'
        : 'npm';

  const cmd = selectBuildCommand(pkg, tsconfigExists, pm);
  if (!cmd) return { outcome: 'skipped_no_runner', output: 'no build script or tsconfig' };

  try {
    const res = await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${cmd}`, { timeoutMs: 240_000 });
    const output = scrubSecrets(`${res.stdout ?? ''}${res.stderr ? `\n${res.stderr}` : ''}`).slice(-2000);
    return res.exitCode === 0
      ? { outcome: 'passed', exitCode: 0, output }
      : { outcome: 'failed', exitCode: res.exitCode, output };
  } catch (err: unknown) {
    const failure = err as BuildFailureLike;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const detail = [failure.stderr, failure.stdout]
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join('\n');
    const output = scrubSecrets(detail || rawMessage).slice(-2000);
    if (/timed out|timeout/i.test(rawMessage)) {
      return { outcome: 'infra_error', output };
    }
    return { outcome: 'failed', exitCode: buildFailureExitCode(err), output };
  }
}

async function fileExists(sandbox: SandboxRuntime, path: string): Promise<boolean> {
  try {
    await sandbox.files.read(path);
    return true;
  } catch {
    return false;
  }
}
