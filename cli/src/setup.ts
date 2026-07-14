import { execSync } from 'node:child_process';
import { jsonOutput, exitWithError } from './output.js';
import { saveAgentCredentials, loadAgentCredentials } from './agent-credentials.js';

const DEFAULT_API_URL = process.env['OPSLANE_API_URL'] ?? 'http://localhost:8082';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface SetupOptions {
  poll?: string;       // poll_id to resume polling
  apiUrl?: string;
  repoUrl?: string;    // override auto-detection
  agentName?: string;
}

/**
 * Extract owner/repo from a git remote URL.
 * Supports HTTPS, SSH, and already-normalized owner/repo format.
 */
export function normalizeRepoURL(remoteURL: string): string | null {
  // Already in owner/repo format
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(remoteURL)) {
    return remoteURL;
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteURL.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteURL.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  return null;
}

/**
 * Detect repo URL from git remote origin.
 */
export function detectRepoFromGit(cwd?: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return normalizeRepoURL(remote);
  } catch {
    return null;
  }
}

/**
 * Main setup command.
 * - If --poll is provided, resume polling an existing session.
 * - Otherwise, detect repo, check for existing credentials, initiate new session.
 */
export async function setup(options: SetupOptions = {}): Promise<void> {
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL;

  // Resume polling mode
  if (options.poll) {
    await pollForCompletion(apiUrl, options.poll);
    return;
  }

  // Check for existing credentials
  const existing = await loadAgentCredentials();
  if (existing) {
    jsonOutput({
      status: 'already_configured',
      org_id: existing.org_id,
      project_id: existing.project_id,
      api_key: existing.api_key.slice(0, 8) + '…',
      repo: existing.repo,
    });
    return;
  }

  // Detect repo
  const repoUrl = options.repoUrl ?? detectRepoFromGit();
  if (!repoUrl) {
    exitWithError('Could not detect repo from git remote. Use --repo-url to specify.');
  }

  // Initiate setup session
  let resp: Response;
  try {
    resp = await fetch(`${apiUrl}/api/v1/agent/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo_url: repoUrl,
        agent_name: options.agentName,
      }),
    });
  } catch {
    exitWithError('Cannot reach Opslane API', { api_url: apiUrl });
  }

  const body = await resp.json() as Record<string, unknown>;

  if (body['status'] === 'already_configured') {
    jsonOutput(body);
    return;
  }

  if (!resp.ok) {
    exitWithError(String(body['error'] ?? 'setup failed'));
  }

  // Print auth URL and start polling
  jsonOutput(body);

  // Auto-poll if running non-interactively
  const pollId = body['poll_id'] as string;
  if (pollId) {
    await pollForCompletion(apiUrl, pollId);
  }
}

async function pollForCompletion(apiUrl: string, pollId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let resp: Response;
    try {
      resp = await fetch(`${apiUrl}/api/v1/agent/poll/${pollId}`);
    } catch {
      continue; // retry on network error
    }

    const body = await resp.json() as Record<string, unknown>;

    if (body['status'] === 'completed') {
      const orgId = body['org_id'] as string | undefined;
      const projectId = body['project_id'] as string | undefined;
      const apiKey = body['api_key'] as string | undefined;
      const repo = body['repo'] as string | undefined;

      if (!orgId || !projectId || !apiKey || !repo) {
        exitWithError('Setup completed but credentials were not returned. Run setup again.');
      }

      // Save credentials locally
      await saveAgentCredentials({
        org_id: orgId,
        project_id: projectId,
        api_key: apiKey,
        repo: repo,
        api_url: apiUrl,
      });

      jsonOutput({
        status: 'completed',
        org_id: orgId,
        project_id: projectId,
        api_key: apiKey,
        repo: repo,
      });
      return;
    }

    if (resp.status === 410) {
      exitWithError('Session expired. Run setup again.');
    }

    // Still pending — continue polling
  }

  exitWithError('Setup timed out. Run setup again.');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
