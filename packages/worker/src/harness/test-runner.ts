import type { CheckOutcome } from '@opslane/shared';
import type { SandboxRuntime } from './sandbox-runtime.js';
import { scrubSecrets } from './redact.js';

const SANDBOX_REPO = '/home/user/repo';
export const SUITE_RESULTS_PATH = '/tmp/opslane-suite-results.json';
const SUITE_TIMEOUT_MS = 240_000;
const MAX_SUITE_OUTPUT = 4000;

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface TestPlan {
  kind: 'vitest' | 'npm-script' | 'none';
  command: string | null;
}

interface PackageJsonLike {
  scripts?: Record<string, string>;
  workspaces?: unknown;
}

export function selectTestCommand(
  pkg: PackageJsonLike,
  vitestBinExists: boolean,
  packageManager: PackageManager = 'npm',
): TestPlan {
  if (pkg.workspaces) return { kind: 'none', command: null };
  if (vitestBinExists) {
    return {
      kind: 'vitest',
      command: `./node_modules/.bin/vitest run --reporter=json --outputFile=${SUITE_RESULTS_PATH}`,
    };
  }
  if (pkg.scripts?.['test']) {
    return {
      kind: 'npm-script',
      command: packageManager === 'npm' ? 'npm test' : `${packageManager} test`,
    };
  }
  return { kind: 'none', command: null };
}

export type TestStatus = 'passed' | 'failed';

export interface ParsedSuite {
  tests: Map<string, TestStatus>;
  total: number;
}

interface JsonAssertion {
  fullName?: string;
  title?: string;
  status?: string;
}

interface JsonTestFile {
  name?: string;
  assertionResults?: JsonAssertion[];
}

interface JsonReport {
  numTotalTests?: number;
  testResults?: JsonTestFile[];
}

export function parseSuiteJson(raw: string): ParsedSuite {
  const report = JSON.parse(raw) as JsonReport;
  const tests = new Map<string, TestStatus>();
  for (const file of report.testResults ?? []) {
    const fileName = (file.name ?? '').replace(`${SANDBOX_REPO}/`, '');
    for (const assertion of file.assertionResults ?? []) {
      const id = `${fileName}::${assertion.fullName ?? assertion.title ?? ''}`;
      if (assertion.status === 'passed') tests.set(id, 'passed');
      else if (assertion.status === 'failed') tests.set(id, 'failed');
    }
  }
  return { tests, total: report.numTotalTests ?? tests.size };
}

export interface SuiteRun {
  outcome: CheckOutcome;
  command: string;
  tests: Map<string, TestStatus> | null;
  total: number | null;
  exitCode?: number;
  output: string;
}

export interface SuiteComparison {
  baselineFailed: string[];
  newFailures: string[];
  missingFromPost: string[];
  comparable: boolean;
}

export function compareSuiteRuns(
  baseline: SuiteRun | null,
  post: SuiteRun,
): SuiteComparison {
  if (post.tests && baseline?.tests) {
    const baselineFailed = [...baseline.tests]
      .filter(([, status]) => status === 'failed')
      .map(([id]) => id);
    const newFailures = [...post.tests]
      .filter(([id, status]) => status === 'failed' && baseline.tests?.get(id) !== 'failed')
      .map(([id]) => id);
    const missingFromPost = [...baseline.tests]
      .filter(([id, status]) => status === 'passed' && !post.tests?.has(id))
      .map(([id]) => id);
    return { baselineFailed, newFailures, missingFromPost, comparable: true };
  }

  const baselineFailedCoarse = baseline?.outcome === 'failed';
  const postPassed = post.outcome === 'passed';
  return {
    baselineFailed: baselineFailedCoarse ? ['<suite>'] : [],
    newFailures: !postPassed && !baselineFailedCoarse ? ['<suite>'] : [],
    missingFromPost: [],
    comparable: postPassed,
  };
}

async function fileExists(sandbox: SandboxRuntime, path: string): Promise<boolean> {
  try {
    await sandbox.files.read(path);
    return true;
  } catch {
    return false;
  }
}

export async function planTests(sandbox: SandboxRuntime): Promise<TestPlan> {
  let pkg: PackageJsonLike = {};
  try {
    pkg = JSON.parse(await sandbox.files.read(`${SANDBOX_REPO}/package.json`)) as PackageJsonLike;
  } catch {
    // A repository without a root package.json has no supported Phase-1 runner.
  }
  if (pkg.workspaces || await fileExists(sandbox, `${SANDBOX_REPO}/pnpm-workspace.yaml`)) {
    return { kind: 'none', command: null };
  }
  const packageManager: PackageManager = await fileExists(sandbox, `${SANDBOX_REPO}/pnpm-lock.yaml`)
    ? 'pnpm'
    : await fileExists(sandbox, `${SANDBOX_REPO}/yarn.lock`)
      ? 'yarn'
      : 'npm';
  return selectTestCommand(
    pkg,
    await fileExists(sandbox, `${SANDBOX_REPO}/node_modules/.bin/vitest`),
    packageManager,
  );
}

function bound(raw: string): string {
  return scrubSecrets(raw).slice(-MAX_SUITE_OUTPUT);
}

interface CommandFailureLike {
  message?: string;
  exitCode?: number | null;
  stdout?: unknown;
  stderr?: unknown;
}

function failureExitCode(error: unknown): number | undefined {
  const failure = error as CommandFailureLike;
  if (typeof failure.exitCode === 'number') return failure.exitCode;
  const match = String(failure.message ?? '').match(/exited with code (\d+)/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function failureOutput(error: unknown): string {
  const failure = error as CommandFailureLike;
  const detail = [failure.stderr, failure.stdout]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n');
  return detail || (error instanceof Error ? error.message : String(error));
}

export async function runSuite(
  sandbox: SandboxRuntime,
  plan: TestPlan,
): Promise<SuiteRun> {
  if (plan.kind === 'none' || !plan.command) {
    return {
      outcome: 'skipped_no_runner',
      command: '',
      tests: null,
      total: null,
      output: 'No test runner detected',
    };
  }

  await sandbox.commands.run(`rm -f ${SUITE_RESULTS_PATH}`, { timeoutMs: 10_000 });
  let rawOutput = '';
  let exitCode = 0;
  try {
    const result = await sandbox.commands.run(
      `cd ${SANDBOX_REPO} && ${plan.command}`,
      { timeoutMs: SUITE_TIMEOUT_MS },
    );
    exitCode = result.exitCode;
    rawOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const output = failureOutput(error);
    if (/timed out|timeout/i.test(errorMessage)) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: null,
        total: null,
        output: bound(output),
      };
    }
    exitCode = failureExitCode(error) ?? 1;
    rawOutput = output;
  }
  const output = bound(rawOutput);
  const exitedNonZero = exitCode !== 0;

  if (plan.kind === 'vitest') {
    let parsed: ParsedSuite | null = null;
    try {
      parsed = parseSuiteJson(await sandbox.files.read(SUITE_RESULTS_PATH));
    } catch {
      // A missing/unparseable report means the runner did not produce comparable evidence.
    }
    if (!parsed) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: null,
        total: null,
        exitCode,
        output,
      };
    }
    if (parsed.total === 0 || parsed.tests.size === 0) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: parsed.tests,
        total: parsed.total,
        exitCode,
        output: `Zero executed tests. ${output}`.trim(),
      };
    }
    const anyFailed = [...parsed.tests.values()].some((status) => status === 'failed');
    if (exitedNonZero && !anyFailed) {
      return {
        outcome: 'infra_error',
        command: plan.command,
        tests: parsed.tests,
        total: parsed.total,
        exitCode,
        output: `Runner exited nonzero without a failed assertion. ${output}`.trim(),
      };
    }
    return {
      outcome: anyFailed ? 'failed' : 'passed',
      command: plan.command,
      tests: parsed.tests,
      total: parsed.total,
      exitCode,
      output,
    };
  }

  return {
    outcome: exitedNonZero ? 'failed' : 'passed',
    command: plan.command,
    tests: null,
    total: null,
    exitCode,
    output,
  };
}
