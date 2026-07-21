import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);

export interface TestResult {
  test: string;
  passed: boolean;
  output?: string;
}

/** Escape regex metacharacters so vitest -t matches literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function runTests(
  appDir: string,
  testNames: string[],
  timeoutMs = 60_000,
  platform: 'javascript' | 'python' = 'javascript',
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const testName of testNames) {
    const filePath = testName.split(' > ')[0].trim();
    const fullTestName = testName.substring(filePath.length + 3);

    try {
      const command = platform === 'python' ? path.join(appDir, '.venv', 'bin', 'python') : 'npx';
      const args = platform === 'python'
        ? ['-m', 'pytest', testName, '-q']
        : ['vitest', 'run', filePath, '-t', escapeRegex(fullTestName), '--reporter=verbose'];
      const { stdout } = await exec(
        command, args,
        { cwd: appDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );
      results.push({ test: testName, passed: true, output: stdout });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const execErr = error as Error & { stdout?: string; stderr?: string };
      results.push({
        test: testName,
        passed: false,
        output: execErr.stdout ?? execErr.stderr ?? error.message,
      });
    }
  }

  return results;
}
