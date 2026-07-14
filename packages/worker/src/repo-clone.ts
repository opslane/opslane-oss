import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface CloneOptions {
  githubRepo: string;   // "owner/repo"
  defaultBranch: string;
  jobId: string;
  timeoutMs?: number;
  githubToken?: string;
}

export interface CloneResult {
  repoDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Clone a repo using token-in-URL. execFile doesn't use a shell,
 * so the token is only visible in /proc/PID/environ (same process),
 * not in /proc/PID/cmdline or shell history.
 */
export async function cloneRepo(options: CloneOptions): Promise<CloneResult> {
  const { githubRepo, defaultBranch, jobId, timeoutMs = 30_000 } = options;
  const token = options.githubToken ?? process.env['GITHUB_TOKEN'];
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set');
  }

  const repoDir = `/tmp/opslane-repo-${jobId}`;
  const cloneUrl = `https://x-access-token:${token}@github.com/${githubRepo}.git`;

  try {
    await execFile('git', [
      'clone', '--depth', '1', '--branch', defaultBranch,
      cloneUrl, repoDir,
    ], { timeout: timeoutMs, env: scrubbedEnv() });
  } catch (err: unknown) {
    // Scrub token from error messages before propagating
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@'));
  }

  return {
    repoDir,
    cleanup: async () => {
      await execFile('rm', ['-rf', repoDir]).catch(() => {});
    },
  };
}

/**
 * Create branch, re-apply diff, commit, and push.
 * Called after verification passes (which rolls back the diff).
 */
export async function gitCommitAndPush(
  repoDir: string,
  branchName: string,
  commitMessage: string,
  diff: string,
): Promise<void> {
  const opts = {
    cwd: repoDir,
    timeout: 30_000,
    env: {
      ...scrubbedEnv(),
      GIT_AUTHOR_NAME: 'Opslane Bot',
      GIT_AUTHOR_EMAIL: 'opslane-bot@opslane.com',
      GIT_COMMITTER_NAME: 'Opslane Bot',
      GIT_COMMITTER_EMAIL: 'opslane-bot@opslane.com',
    },
  };
  // Re-apply the diff (verify.ts rolls it back after testing)
  await gitApplyStdin(repoDir, diff, 30_000);
  await execFile('git', ['checkout', '-b', branchName], opts);
  await execFile('git', ['add', '-A'], opts);
  await execFile('git', ['commit', '-m', commitMessage], opts);
  await execFile('git', ['push', 'origin', branchName], opts);
}

/** Apply a diff via stdin to git apply. */
function gitApplyStdin(cwd: string, diff: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFileCb('git', ['apply', '-'], { cwd, timeout: timeoutMs, env: scrubbedEnv() }, (error) => {
      if (error) {
        reject(new Error(`git apply failed: ${error.message}`));
        return;
      }
      resolve();
    });
    if (child.stdin) {
      child.stdin.write(diff);
      child.stdin.end();
    }
  });
}

/**
 * Validate that all diff paths are safe -- no path traversal, within repo.
 */
export function validateDiffPaths(diff: string): { valid: boolean; error?: string } {
  const pathRegex = /^(?:---|\+\+\+) [ab]\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(diff)) !== null) {
    const filePath = match[1];
    if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\0')) {
      return { valid: false, error: `Unsafe diff path: ${filePath}` };
    }
  }
  return { valid: true };
}

/**
 * Build a scrubbed env for running customer test scripts.
 * Removes secrets so they can't leak via malicious package.json scripts.
 */
export function scrubbedEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'MINIO_SECRET_KEY', 'REPLAY_STORE_SECRET_KEY', 'ENCRYPTION_KEY', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_SECRET']) {
    delete env[key];
  }
  return env;
}
