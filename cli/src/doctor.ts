import { access } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import { defaultTokenPath, loadTokensFrom } from './auth.js';
import { defaultCredentialsPath, resolveCredentials } from './agent-credentials.js';
import { defaultApiUrl } from './config.js';
import { detectRepoFromGit } from './setup.js';
import { canonicalOrigin } from './origin.js';

export interface DoctorOptions {
  fix?: boolean;
  /** Override the API URL for testing. */
  apiUrl?: string;
  /** Override the working directory for testing. */
  cwd?: string;
  /** Injectable fetch for testing. */
  fetchFn?: typeof fetch;
  repo?: string;
  credentialsPath?: string;
  tokenPath?: string;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  remediation?: string;
}

type CheckFn = () => Promise<CheckResult>;

function getApiUrl(options: DoctorOptions): string {
  return canonicalOrigin(options.apiUrl ?? defaultApiUrl());
}

/**
 * Build the list of health checks.
 */
function buildChecks(options: DoctorOptions): CheckFn[] {
  const cwd = options.cwd ?? process.cwd();
  const apiUrl = getApiUrl(options);
  const fetchImpl = options.fetchFn ?? fetch;
  const repo = options.repo ?? detectRepoFromGit(cwd);
  const resolveAgentCredentials = () => resolveCredentials({
    apiUrl,
    repo,
    filePath: options.credentialsPath ?? defaultCredentialsPath(),
  });
  const resolveLoginTokens = () => loadTokensFrom(
    options.tokenPath ?? defaultTokenPath(),
    apiUrl,
  );

  return [
    // Check 1: .opslane.json is optional for agent-first setup.
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
          passed: true,
          message: '.opslane.json not found (optional for agent-first setup)',
        };
      }
    },

    // Check 2: Credentials exist and not expired
    async (): Promise<CheckResult> => {
      const [agentCredentials, tokens] = await Promise.all([
        resolveAgentCredentials(),
        resolveLoginTokens(),
      ]);
      if (agentCredentials || tokens) {
        return {
          name: 'Authentication',
          passed: true,
          message: agentCredentials ? 'Agent API credentials found' : 'Valid login credentials found',
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
        const agentCredentials = await resolveAgentCredentials();
        const tokens = agentCredentials ? null : await resolveLoginTokens();
        if (!agentCredentials && !tokens) {
          return {
            name: 'API key',
            passed: false,
            message: 'Cannot test API key without credentials',
            remediation: 'Run `opslane login` first',
          };
        }
        const response = await fetchImpl(agentCredentials
          ? `${agentCredentials.api_url}/api/v1/projects/${encodeURIComponent(agentCredentials.project_id)}/event-count`
          : `${apiUrl}/api/v1/auth/verify`, {
          headers: agentCredentials
            ? { 'X-API-Key': agentCredentials.api_key }
            : { Authorization: `Bearer ${tokens?.accessToken ?? ''}` },
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
            agentCredentials ? 'Run `opslane setup --force` or `opslane setup --relink`' : 'Run `opslane login` again',
        };
      } catch {
        return {
          name: 'API key',
          passed: false,
          message: 'Could not verify API key',
          remediation:
            'Run `opslane setup --relink` or `opslane login` again',
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
