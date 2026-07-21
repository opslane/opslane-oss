/**
 * Bridges eval cases to the worker's runAgentFix function.
 *
 * For eval, the bug patch is applied via setupCommands after the agent
 * clones the repo in E2B. The agent then fixes the bug and returns a diff.
 *
 * Requires: E2B_API_KEY + ANTHROPIC_API_KEY for real runs.
 * The eval app must be accessible via a git URL (repo_url in case.json).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgentFix, type AgentFixResult } from '../../packages/worker/src/agent-fix.js';
import type { EvalCase } from './types.js';

/**
 * Build a shell command that applies a patch via heredoc.
 * Uses base64 encoding to avoid shell escaping issues with patch content.
 */
function buildPatchCommand(patchContent: string): string {
  const b64 = Buffer.from(patchContent).toString('base64');
  return `echo '${b64}' | base64 -d | git apply --whitespace=fix`;
}

export async function callPipeline(
  evalCase: EvalCase,
  casesDir: string,
): Promise<AgentFixResult> {
  if (!evalCase.repo_url) {
    return {
      status: 'needs_human',
      reason: {
        reason_code: 'worker_runtime_error',
        reason_message: `Eval case ${evalCase.id} has no repo_url — cannot clone in E2B`,
        remediation: 'Add repo_url to case.json pointing to a GitHub repo containing the eval app',
      },
    };
  }

  // Build setup commands to apply the bug patch after clone+install
  const setupCommands: string[] = [];
  if (evalCase.bug_patch) {
    const patchPath = path.join(casesDir, evalCase.id, evalCase.bug_patch);
    const patchContent = await readFile(patchPath, 'utf-8');
    setupCommands.push(buildPatchCommand(patchContent));
  }

  return runAgentFix({
    platform: evalCase.error_event.platform,
    customerRuntime: evalCase.error_event.runtime ?? null,
    errorGroupId: evalCase.id,
    projectId: `eval-${evalCase.app}`,
    title: `${evalCase.error_event.error.type}: ${evalCase.error_event.error.message}`,
    errorType: evalCase.error_event.error.type,
    errorMessage: evalCase.error_event.error.message,
    stackTrace: evalCase.error_event.error.stack,
    resolvedStackTrace: null,
    breadcrumbs: JSON.stringify(evalCase.error_event.breadcrumbs),
    context: JSON.stringify(evalCase.error_event.context),
    sourceFiles: [],  // Agent reads files directly from repo
    visualAnalysis: null,
    repoUrl: evalCase.repo_url,
    defaultBranch: evalCase.default_branch ?? 'main',
    setupCommands: setupCommands.length > 0 ? setupCommands : undefined,
    budgetUsd: 2.00,  // Higher budget for eval cases
  });
}

export type { AgentFixResult };
