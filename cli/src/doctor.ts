import { access } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import { loadTokens } from './auth.js';

export interface DoctorOptions {
  fix?: boolean;
  /** Override the API URL for testing. */
  apiUrl?: string;
  /** Override the working directory for testing. */
  cwd?: string;
  /** Injectable fetch for testing. */
  fetchFn?: typeof fetch;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  remediation?: string;
}

type CheckFn = () => Promise<CheckResult>;

function getApiUrl(options: DoctorOptions): string {
  return (
    options.apiUrl ??
    process.env['OPSLANE_API_URL'] ??
    'http://localhost:8082'
  );
}

/**
 * Build the list of health checks.
 */
function buildChecks(options: DoctorOptions): CheckFn[] {
  const cwd = options.cwd ?? process.cwd();
  const apiUrl = getApiUrl(options);
  const fetchImpl = options.fetchFn ?? fetch;

  return [
    // Check 1: .opslane.json exists
    async (): Promise<CheckResult> => {
      try {
        await access(join(cwd, '.opslane.json'));
        return {
          name: 'Project config',
          passed: true,
          message: '.opslane.json found',
        };
      } catch {
        return {
          name: 'Project config',
          passed: false,
          message: '.opslane.json not found in current directory',
          remediation: 'Run `opslane init`',
        };
      }
    },

    // Check 2: Credentials exist and not expired
    async (): Promise<CheckResult> => {
      const tokens = await loadTokens();
      if (tokens) {
        return {
          name: 'Authentication',
          passed: true,
          message: 'Valid credentials found',
        };
      }
      return {
        name: 'Authentication',
        passed: false,
        message: 'No valid credentials found (missing or expired)',
        remediation: 'Run `opslane login`',
      };
    },

    // Check 3: Ingestion reachable
    async (): Promise<CheckResult> => {
      try {
        const response = await fetchImpl(`${apiUrl}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return {
            name: 'Ingestion service',
            passed: true,
            message: `Reachable at ${apiUrl}`,
          };
        }
        return {
          name: 'Ingestion service',
          passed: false,
          message: `Responded with status ${response.status}`,
          remediation:
            'Check OPSLANE_API_URL or ensure services are running',
        };
      } catch {
        return {
          name: 'Ingestion service',
          passed: false,
          message: `Cannot reach ${apiUrl}`,
          remediation:
            'Check OPSLANE_API_URL or ensure services are running',
        };
      }
    },

    // Check 4: API key valid
    async (): Promise<CheckResult> => {
      try {
        const tokens = await loadTokens();
        if (!tokens) {
          return {
            name: 'API key',
            passed: false,
            message: 'Cannot test API key without credentials',
            remediation: 'Run `opslane login` first',
          };
        }
        const response = await fetchImpl(`${apiUrl}/api/v1/auth/verify`, {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
          },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return {
            name: 'API key',
            passed: true,
            message: 'API key is valid',
          };
        }
        return {
          name: 'API key',
          passed: false,
          message: `Auth verification failed (status ${response.status})`,
          remediation:
            'Check environment API key in .opslane.json',
        };
      } catch {
        return {
          name: 'API key',
          passed: false,
          message: 'Could not verify API key',
          remediation:
            'Check environment API key in .opslane.json',
        };
      }
    },
  ];
}

/**
 * Run all health checks and report results.
 */
export async function doctor(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const checkFns = buildChecks(options);
  const results: CheckResult[] = [];

  console.log(chalk.bold('\nOpslane Doctor\n'));

  for (const checkFn of checkFns) {
    const result = await checkFn();
    results.push(result);

    const icon = result.passed
      ? chalk.green('PASS')
      : chalk.red('FAIL');

    console.log(`[${icon}] ${result.name}: ${result.message}`);

    if (!result.passed && result.remediation) {
      console.log(chalk.dim(`       Fix: ${result.remediation}`));
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  console.log('');
  if (passed === total) {
    console.log(chalk.green(`All ${total} checks passed!`));
  } else {
    console.log(
      chalk.yellow(
        `${passed}/${total} checks passed. Run the suggested fixes above.`,
      ),
    );
  }

  return results;
}
