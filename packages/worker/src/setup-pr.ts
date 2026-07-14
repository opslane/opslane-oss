import type { SetupPrStatus } from '@opslane/shared';
import { cloneRepo, gitCommitAndPush, validateDiffPaths } from './repo-clone.js';
import { createGitHubClient } from './pr.js';
import { getInstallationToken } from './github-app.js';
import { runAgentSetup } from './setup-agent.js';
import * as db from './db.js';

const SETUP_BRANCH = 'opslane/setup';

export interface SetupPrDeps {
  getProject(projectId: string): Promise<{ github_repo: string; default_branch: string } | null>;
  getInstallToken(projectId: string): Promise<string | undefined>;
  findExistingPr(token: string, repo: string, head: string): Promise<{ url: string; number: number } | null>;
  clone(opts: { githubRepo: string; defaultBranch: string; jobId: string; githubToken?: string }): Promise<{ repoDir: string; cleanup: () => Promise<void> }>;
  runAgentSetup(input: {
    repoUrl: string;
    defaultBranch: string;
    githubToken?: string;
    apiKeyEnvVar: string;
    releaseEnvVar: string;
  }): Promise<
    | { status: 'setup_ready'; diff: string }
    | { status: 'needs_human'; reason: { reason_message: string } }
  >;
  commitAndPush(repoDir: string, branch: string, message: string, diff: string): Promise<void>;
  createPr(token: string, params: {
    repo: string;
    base: string;
    head: string;
    title: string;
    body: string;
  }): Promise<{ url: string; number: number }>;
  record(projectId: string, status: SetupPrStatus, fields?: { pr_url?: string; pr_number?: number; error?: string }): Promise<void>;
}

export interface SetupPrJob {
  jobId: string;
  projectId: string;
  apiKeyEnvVar: string;
  releaseEnvVar: string;
}

export async function runSetupPr(job: SetupPrJob, d: SetupPrDeps): Promise<{ status: SetupPrStatus }> {
  const project = await d.getProject(job.projectId);
  if (!project?.github_repo) {
    await d.record(job.projectId, 'failed', { error: 'Project has no github_repo configured' });
    return { status: 'failed' };
  }

  const token = await d.getInstallToken(job.projectId);
  if (!token) {
    await d.record(job.projectId, 'failed', { error: 'No GitHub installation token (is the App installed on this repo?)' });
    return { status: 'failed' };
  }

  await d.record(job.projectId, 'opening');

  const existing = await d.findExistingPr(token, project.github_repo, SETUP_BRANCH);
  if (existing) {
    await d.record(job.projectId, 'open', { pr_url: existing.url, pr_number: existing.number });
    return { status: 'open' };
  }

  let cleanup = async (): Promise<void> => {};
  try {
    const repoUrl = `https://github.com/${project.github_repo}.git`;
    const agent = await d.runAgentSetup({
      repoUrl,
      defaultBranch: project.default_branch,
      githubToken: token,
      apiKeyEnvVar: job.apiKeyEnvVar,
      releaseEnvVar: job.releaseEnvVar,
    });

    if (agent.status === 'needs_human') {
      await d.record(job.projectId, 'failed', { error: agent.reason.reason_message });
      return { status: 'failed' };
    }

    const pathCheck = validateDiffPaths(agent.diff);
    if (!pathCheck.valid) {
      await d.record(job.projectId, 'failed', { error: pathCheck.error ?? 'unsafe diff paths' });
      return { status: 'failed' };
    }

    const cloneResult = await d.clone({
      githubRepo: project.github_repo,
      defaultBranch: project.default_branch,
      jobId: job.jobId,
      githubToken: token,
    });
    cleanup = cloneResult.cleanup;

    const repoDir = cloneResult.repoDir;
    await d.commitAndPush(repoDir, SETUP_BRANCH, 'chore: install Opslane SDK', agent.diff);
    const pr = await d.createPr(token, {
      repo: project.github_repo,
      base: project.default_branch,
      head: SETUP_BRANCH,
      title: '[Opslane] Install Opslane SDK',
      body: setupPrBody(),
    });
    await d.record(job.projectId, 'open', { pr_url: pr.url, pr_number: pr.number });
    return { status: 'open' };
  } catch (err: unknown) {
    const msg = (err instanceof Error ? err.message : String(err))
      .replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')
      .replace(/https:\/\/[^@]+@/g, 'https://***@');
    await d.record(job.projectId, 'failed', { error: `Failed to open setup PR: ${msg}` });
    return { status: 'failed' };
  } finally {
    await cleanup().catch(() => {});
  }
}

function setupPrBody(): string {
  return [
    '## Install Opslane',
    '',
    'This PR wires the Opslane browser SDK into your app so production frontend errors are captured with replay and source-mapped stacks.',
    '',
    '**Before this works:** set your Opslane ingest key as the build environment variable referenced in the diff. You can find the key in your Opslane dashboard. For source-map matching, also set the release variable to your build git SHA in CI.',
    '',
    'Merge this PR to finish setup. The dashboard lights up on your first error.',
  ].join('\n');
}

/** Thin wrapper wiring real deps for the poller. */
export async function processSetupPrJob(job: { id: string; projectId: string }): Promise<void> {
  await runSetupPr(
    {
      jobId: job.id,
      projectId: job.projectId,
      apiKeyEnvVar: 'VITE_OPSLANE_API_KEY',
      releaseEnvVar: 'VITE_OPSLANE_RELEASE',
    },
    {
      getProject: (id) => db.getProject(id),
      getInstallToken: async (projectId) => {
        const info = await db.getProjectGitHubInstallation(projectId);
        if (info?.installationId) {
          try {
            return await getInstallationToken(info.installationId);
          } catch {
            // fall through to env token fallback
          }
        }
        return process.env['GITHUB_TOKEN'];
      },
      findExistingPr: async (token, repo, head) => {
        const client = createGitHubClient(token);
        if (!client) return null;
        const [owner, name] = repo.split('/');
        if (!owner || !name) return null;
        if (!client.listOpenPullsByHead) return null;
        return client.listOpenPullsByHead({ owner, repo: name, head });
      },
      clone: (opts) => cloneRepo(opts),
      runAgentSetup: (input) => runAgentSetup(input),
      commitAndPush: (repoDir, branch, message, diff) => gitCommitAndPush(repoDir, branch, message, diff),
      createPr: async (token, params) => {
        const client = createGitHubClient(token);
        if (!client) throw new Error('GitHub client unavailable');
        const [owner, repo] = params.repo.split('/');
        if (!owner || !repo) throw new Error(`Invalid repository format: ${params.repo}`);
        return client.createPullRequest({
          owner,
          repo,
          title: params.title,
          body: params.body,
          head: params.head,
          base: params.base,
        });
      },
      record: (projectId, status, fields) => db.recordSetupPrResult(projectId, status, fields),
    },
  );
}
