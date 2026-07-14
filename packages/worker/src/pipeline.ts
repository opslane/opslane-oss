import type { NeedsHumanReason, ConfidenceLevel } from '@opslane/shared';
import type { VisualAnalysisOutput } from './harness/types.js';
import type { ReplayInput } from './pr.js';
import { runAgentFix } from './agent-fix.js';
import { createPR, createGitHubClient } from './pr.js';
import { gitCommitAndPush, validateDiffPaths } from './repo-clone.js';
import { buildReason } from './reason-codes.js';
import { logger } from './logger.js';
import { traceSpan } from './tracing.js';

export interface PipelineInput {
  jobId: string;
  errorGroupId: string;
  projectId: string;
  title: string;
  errorType: string;
  errorMessage: string;
  stackTrace: string;
  resolvedStackTrace: unknown;
  breadcrumbs: string;
  context: string;
  sourceFiles: Array<{ filePath: string; content: string }>;
  visualAnalysis: VisualAnalysisOutput | null;
  repoPath: string;
  repoUrl: string;
  githubRepo: string;
  defaultBranch: string;
  githubToken?: string;
  replay?: ReplayInput | null;
  /** Pre-computed investigation results. When set, agent skips internal triage. */
  investigation?: {
    rootCause: string;
    suggestedMitigation: string;
    guidance?: string;
  };
}

export interface PipelineResult {
  status: 'pr_created' | 'needs_human';
  pr_url?: string;
  pr_number?: number;
  confidence?: ConfidenceLevel;
  reason?: NeedsHumanReason;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  // Stage 1: Agent fix (E2B sandbox + LLM tool loop)
  const fixResult = await runAgentFix({
    errorGroupId: input.errorGroupId,
    projectId: input.projectId,
    title: input.title,
    errorType: input.errorType,
    errorMessage: input.errorMessage,
    stackTrace: input.stackTrace,
    resolvedStackTrace: input.resolvedStackTrace,
    breadcrumbs: input.breadcrumbs,
    context: input.context,
    sourceFiles: input.sourceFiles,
    visualAnalysis: input.visualAnalysis,
    repoUrl: input.repoUrl,
    defaultBranch: input.defaultBranch,
    githubToken: input.githubToken,
    repoPath: input.repoPath,
    investigation: input.investigation,
  });

  if (fixResult.status === 'needs_human') {
    return { status: 'needs_human', reason: fixResult.reason, confidence: fixResult.confidence };
  }

  // Hard precision guard (independent of agent-fix): only a HIGH-confidence fix may
  // proceed to push + PR. Anything else terminates as needs_human, preserving the
  // reason + confidence (root_cause was persisted during investigation; the candidate
  // diff itself is not stored). This is the product's core invariant — enforce it here too.
  if (fixResult.confidence !== 'high') {
    return {
      status: 'needs_human',
      confidence: fixResult.confidence,
      reason: buildReason(
        'low_confidence_fix',
        'A candidate fix was generated but did not clear the confidence bar for an automatic PR.',
      ),
    };
  }

  const diff = fixResult.diff!;

  logger.info('Agent fix complete', {
    error_group_id: input.errorGroupId,
    confidence: fixResult.confidence,
    root_cause: fixResult.rootCause?.slice(0, 200),
    affected_files: fixResult.affectedFiles,
    diff_length: diff.length,
  });

  // Validate diff paths before applying to local clone
  const pathCheck = validateDiffPaths(diff);
  if (!pathCheck.valid) {
    return {
      status: 'needs_human',
      reason: {
        reason_code: 'malformed_diff',
        reason_message: pathCheck.error ?? 'Diff contains unsafe paths',
        remediation: 'Review the generated diff manually — it contains path traversal',
      },
    };
  }

  // Stage 2: Apply diff to local clone, commit + push
  const branchName = `opslane/fix-${input.errorGroupId.slice(0, 8)}-${Date.now()}`;
  try {
    await traceSpan('git-push', { 'git.branch': branchName }, () =>
      gitCommitAndPush(
        input.repoPath,
        branchName,
        `fix: ${input.title.slice(0, 72)}`,
        diff,
      ),
    );
  } catch (err: unknown) {
    return {
      status: 'needs_human',
      reason: {
        reason_code: 'repo_access_denied',
        reason_message: `Failed to push branch: ${err instanceof Error ? err.message : String(err)}`,
        remediation: 'Ensure GITHUB_TOKEN has push access to the repository',
      },
    };
  }

  // Stage 3: Create PR
  const prResult = await traceSpan(
    'create-pr',
    { 'pr.repo': input.githubRepo, 'pr.branch': branchName },
    () => createPR({
      projectId: input.projectId,
      errorGroupId: input.errorGroupId,
      githubRepo: input.githubRepo,
      defaultBranch: input.defaultBranch,
      branchName,
      diff,
      title: input.title,
      confidence: fixResult.confidence!,
      rootCause: fixResult.rootCause,
      humanSummary: fixResult.humanSummary,
      stackTrace: input.stackTrace,
      replay: input.replay,
      visualAnalysis: input.visualAnalysis,
      errorType: input.errorType,
      errorMessage: input.errorMessage,
    }, input.githubToken ? () => createGitHubClient(input.githubToken) : undefined),
  );

  if (prResult.status === 'failed') {
    return { status: 'needs_human', reason: prResult.reason };
  }

  return {
    status: 'pr_created',
    pr_url: prResult.prUrl,
    pr_number: prResult.prNumber,
    confidence: fixResult.confidence,
  };
}
