import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * Pipe a string to a command's stdin using the callback form of execFile.
 * Node's promisified execFile does NOT support `input` — must use child.stdin.
 * Pattern from packages/worker/src/repo-clone.ts:76 (gitApplyStdin).
 */
function execWithStdin(
  cmd: string,
  args: string[],
  cwd: string,
  stdin: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFileCb(cmd, args, { cwd, timeout: 30_000 }, (error) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${error.message}`));
        return;
      }
      resolve();
    });
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export async function createSandbox(
  appDir: string,
  bugPatchPath?: string | null,
  platform: 'javascript' | 'python' = 'javascript',
): Promise<string> {
  const sandboxDir = await mkdtemp(path.join(tmpdir(), 'opslane-eval-'));
  await cp(appDir, sandboxDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });

  // Write .gitignore BEFORE git init to avoid staging node_modules
  await writeFile(path.join(sandboxDir, '.gitignore'), 'node_modules/\ndist/\n.venv/\n__pycache__/\n*.pyc\n.pytest_cache/\n*.egg-info/\n');

  // Install dependencies so grading sandbox has node_modules for test runners
  if (platform === 'python') {
    await execFile('python', ['-m', 'venv', '.venv'], { cwd: sandboxDir, timeout: 60_000 });
    await execFile(path.join(sandboxDir, '.venv', 'bin', 'python'), ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: sandboxDir, timeout: 120_000 });
  } else {
    await execFile('npm', ['install'], { cwd: sandboxDir, timeout: 120_000 });
  }

  await execFile('git', ['init'], { cwd: sandboxDir });
  await execFile('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@test', 'add', '-A'], { cwd: sandboxDir });
  await execFile('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@test', 'commit', '-m', 'init'], { cwd: sandboxDir });

  if (bugPatchPath) {
    const patch = await readFile(bugPatchPath, 'utf-8');
    await execWithStdin('git', ['apply', '--whitespace=fix'], sandboxDir, patch);
  }

  return sandboxDir;
}

export async function destroySandbox(sandboxDir: string): Promise<void> {
  await rm(sandboxDir, { recursive: true, force: true });
}
