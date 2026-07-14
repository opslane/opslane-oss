import { Sandbox } from 'e2b';
import { logger } from '../logger.js';

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
  sandbox: Sandbox;
  installSucceeded: boolean;
}

/**
 * Create an E2B sandbox, clone the repo via .netrc auth, install deps, and
 * commit a baseline so a later diff captures only the agent's work.
 */
export async function createRepoSandbox(opts: {
  repoUrl: string;
  defaultBranch: string;
  githubToken?: string;
}): Promise<RepoSandbox> {
  const sandbox = await Sandbox.create();
  await sandbox.commands.run('git config --global user.email "opslane-agent@opslane.com" && git config --global user.name "Opslane Agent"');

  const token = opts.githubToken ?? process.env['GITHUB_TOKEN'] ?? '';
  if (token) {
    await sandbox.files.write('/home/user/.netrc', `machine github.com\nlogin x-access-token\npassword ${token}\n`);
    await sandbox.commands.run('chmod 600 /home/user/.netrc');
  }

  try {
    await sandbox.commands.run(
      `git clone --depth 1 --branch ${shellEscape(opts.defaultBranch)} ${shellEscape(opts.repoUrl)} ${SANDBOX_REPO}`,
      { timeoutMs: 120_000 },
    );
  } catch (err: unknown) {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/https:\/\/[^@]+@/g, 'https://***@');
    await sandbox.kill().catch(() => {});
    throw new Error(`clone failed: ${msg}`);
  }

  if (token) await sandbox.commands.run('rm -f /home/user/.netrc');

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

  return { sandbox, installSucceeded };
}

/** Extract the agent's change as a unified diff. */
export async function extractDiff(sandbox: Sandbox): Promise<{ diff: string; affectedFiles: string[] }> {
  await sandbox.commands.run(`cd ${SANDBOX_REPO} && git add -A`, { timeoutMs: 30_000 });
  const res = await sandbox.commands.run(`cd ${SANDBOX_REPO} && git diff --cached`, { timeoutMs: 30_000 });
  const raw = (res.stdout ?? '').replace(/\r\n/g, '\n');
  const diff = raw.endsWith('\n') ? raw : raw + '\n';
  return { diff, affectedFiles: parseAffectedFiles(diff) };
}

export interface BuildGateResult {
  passed: boolean;
  skipped: boolean;
  output: string;
}

/** Run the build/typecheck gate. Returns skipped:true when there's nothing to run. */
export async function runBuildGate(sandbox: Sandbox): Promise<BuildGateResult> {
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
  if (!cmd) return { passed: true, skipped: true, output: 'no build script or tsconfig' };

  try {
    const res = await sandbox.commands.run(`cd ${SANDBOX_REPO} && ${cmd}`, { timeoutMs: 240_000 });
    return { passed: true, skipped: false, output: (res.stdout ?? '').slice(-2000) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: false, skipped: false, output: msg.slice(-2000) };
  }
}

async function fileExists(sandbox: Sandbox, path: string): Promise<boolean> {
  try {
    await sandbox.files.read(path);
    return true;
  } catch {
    return false;
  }
}
