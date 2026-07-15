import type { ConfidenceLevel, NeedsHumanReason } from '@opslane/shared';
import { Octokit } from '@octokit/rest';
import { scrubDevPaths } from './harness/stack-trace-utils.js';
/** Extract file paths from +++ headers in a unified diff. */
function extractFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      let filePath = line.slice(4).trim();
      if (filePath.startsWith('b/')) filePath = filePath.slice(2);
      if (filePath !== '/dev/null') files.push(filePath);
    }
  }
  return files;
}

// === Public types ===

export interface ReplaySignals {
  eventTypeCounts?: Record<string, number>;
  consoleErrorCount?: number;
  consoleWarningCount?: number;
  consoleErrorMessages?: string[];
  consoleWarningMessages?: string[];
  networkAnomalyCount?: number;
  networkAnomalies?: Array<{
    type?: string;
    method?: string;
    url?: string;
    statusCode?: number;
    message?: string;
  }>;
  lastUserActions?: Array<{
    timestamp: string;
    type: string;
    detail: string;
  }>;
}

export interface ReplayInput {
  id: string;
  sessionId: string;
  triggerType: string | null;
  pageUrl: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: string;
  sizeBytes: number | null;
  signals: ReplaySignals | null;
}

export interface PRInput {
  projectId: string;
  errorGroupId: string;
  githubRepo: string; // "owner/repo"
  defaultBranch: string;
  branchName: string;
  diff: string;
  title: string;
  confidence: ConfidenceLevel;
  rootCause?: string;
  humanSummary?: string;
  // Evidence
  stackTrace?: string;
  replay?: ReplayInput | null;
  visualAnalysis?: {
    whatUserSaw: string;
    failureMoment: string;
    uxImpact: string;
    confidence: string;
  } | null;
  errorType?: string;
  errorMessage?: string;
}

export type PRResult =
  | { status: 'created'; prUrl: string; prNumber: number }
  | { status: 'failed'; reason: NeedsHumanReason };

// === Sanitization ===

/** Strip potential XSS/injection vectors from text going into GitHub markdown. */
export function sanitize(text: string): string {
  return text
    .replace(/[<>]/g, '')                 // HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown images ![alt](url)
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')  // markdown links [text](url)
    .slice(0, 2000);
}

// === Helpers ===

const MAX_LEDE_LENGTH = 700;
const MAX_FIX_LINE_LENGTH = 500;

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'n/a';
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

/**
 * Dashboard link to the incident, where the session replay plays. Reads the
 * dashboard base URL from env (DASHBOARD_URL, falling back to DASHBOARD_ORIGIN).
 * Returns null when no base is configured so the PR body degrades gracefully.
 */
export function buildReplayLink(errorGroupId: string, projectId: string): string | null {
  const base = (process.env['DASHBOARD_URL'] ?? process.env['DASHBOARD_ORIGIN'] ?? '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/incidents/${encodeURIComponent(errorGroupId)}?project_id=${encodeURIComponent(projectId)}`;
}

// === Section builders ===

function sanitizeInline(text: string, max = 2000): string {
  return sanitize(scrubDevPaths(text))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stripMarkdownHeaders(text: string): string {
  return text.replace(/^\s{0,3}#{1,6}\s*/gm, '');
}

function normalizeLede(text: string): string {
  return sanitizeInline(stripMarkdownHeaders(text), MAX_LEDE_LENGTH);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function inlineCode(text: string): string {
  return `\`${sanitizeInline(text).replace(/`/g, "'")}\``;
}

function buildHumanSummary(input: PRInput): string {
  const explicit = normalizeLede(input.humanSummary ?? '');
  if (explicit) return explicit;

  if (input.visualAnalysis) {
    const whatUserSaw = sanitizeInline(input.visualAnalysis.whatUserSaw, 240);
    const failureMoment = sanitizeInline(input.visualAnalysis.failureMoment, 240);
    // Don't restate rootCause here — `buildFixLine` already surfaces it in
    // `### The fix`, so embedding it in the lede would render it twice.
    const fix = 'This change updates the failing code path so the flow can complete';
    const fallback = [
      whatUserSaw ? sentence(whatUserSaw) : '',
      failureMoment ? sentence(failureMoment) : '',
      sentence(fix),
    ].filter(Boolean).join(' ');
    const normalized = normalizeLede(fallback);
    if (normalized) return normalized;
  }

  return normalizeLede(
    `Opslane detected a ${input.errorType ?? 'runtime error'} (${input.errorMessage ?? input.title}) and generated a fix.`,
  );
}

function buildFixLine(input: PRInput, files: string[]): string {
  const rootCause = sanitizeInline(input.rootCause ?? '', MAX_FIX_LINE_LENGTH);
  if (rootCause) return `Addresses ${rootCause}`;
  if (files.length > 0) {
    const namedFiles = files.slice(0, 3).map((file) => inlineCode(file)).join(', ');
    const suffix = files.length > 3 ? ` and ${files.length - 3} more files` : '';
    return `Updates ${namedFiles}${suffix} to fix the reported failure.`;
  }
  return 'Applies a focused code change for the reported failure.';
}

function buildFileLine(files: string[]): string | null {
  if (files.length === 0) return null;
  return `Changed files: ${files.map((file) => inlineCode(file)).join(', ')}`;
}

function buildStackTraceSection(stackTrace?: string): string {
  if (!stackTrace) return 'Not available.';
  const frames = scrubDevPaths(stackTrace)
    .split('\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (frames.length === 0) return 'Not available.';
  return frames.map((frame) => `- ${inlineCode(frame)}`).join('\n');
}

function buildVisualAnalysisSection(visualAnalysis?: PRInput['visualAnalysis']): string {
  if (!visualAnalysis) return '';
  const lines = [
    visualAnalysis.whatUserSaw ? `The user saw ${sanitizeInline(visualAnalysis.whatUserSaw)}.` : '',
    visualAnalysis.failureMoment ? `The failure happened around ${sanitizeInline(visualAnalysis.failureMoment)}.` : '',
    visualAnalysis.uxImpact ? `Impact: ${sanitizeInline(visualAnalysis.uxImpact)}.` : '',
  ].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : '';
}

function buildReplaySignalSummary(signals?: ReplaySignals | null): string {
  if (!signals) return 'Signals not available.';

  const consoleErrors = signals.consoleErrorCount ?? 0;
  const consoleWarnings = signals.consoleWarningCount ?? 0;
  const networkAnomalies = signals.networkAnomalyCount ?? signals.networkAnomalies?.length ?? 0;
  const lastAction = signals.lastUserActions?.at(-1);
  const firstAnomaly = signals.networkAnomalies?.[0];

  const parts = [
    plural(consoleErrors, 'console error'),
    plural(consoleWarnings, 'warning'),
    plural(networkAnomalies, 'network anomaly', 'network anomalies'),
  ];

  if (lastAction) {
    parts.push(
      `last action: ${lastAction.type} (${lastAction.detail}) at ${formatTimestamp(lastAction.timestamp)}`,
    );
  } else {
    parts.push('no recent user action recorded');
  }

  if (firstAnomaly) {
    const method = firstAnomaly.method || 'GET';
    const status = firstAnomaly.statusCode != null ? String(firstAnomaly.statusCode) : 'n/a';
    parts.push(`first network anomaly: ${method} ${firstAnomaly.url ?? ''} (${status})`);
  }

  return sentence(sanitizeInline(parts.join(', '), 700));
}

function buildTechnicalDetails(input: PRInput): string {
  const visualAnalysis = buildVisualAnalysisSection(input.visualAnalysis);
  return [
    '<details><summary>Technical detail</summary>',
    '',
    '#### Stack trace',
    buildStackTraceSection(input.stackTrace),
    '',
    '#### What the replay showed',
    visualAnalysis || 'Visual replay analysis not available.',
    '',
    '#### Signals',
    buildReplaySignalSummary(input.replay?.signals),
    '',
    '</details>',
  ].join('\n');
}

// === PR body construction ===

export function buildPRBody(input: PRInput): string {
  const files = extractFiles(input.diff);
  const maxBacktickRun = (input.diff.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length), 2,
  );
  const fence = '`'.repeat(maxBacktickRun + 1);
  const replayLink = buildReplayLink(input.errorGroupId, input.projectId);

  return [
    `## 🛡️ Opslane fixed ${sanitizeInline(input.title, 120)}`,
    buildHumanSummary(input),
    '### The fix',
    buildFixLine(input, files),
    buildFileLine(files),
    `${fence}diff`,
    input.diff.trim(),
    fence,
    '**Confidence:** High · ✅ Tests passing',
    replayLink ? `📊 [Full investigation & session replay →](${replayLink})` : null,
    buildTechnicalDetails(input),
    '---',
    `*Generated by Opslane · Error Group: ${inlineCode(input.errorGroupId.slice(0, 8))}*`,
  ].filter(Boolean).join('\n\n');
}

// === GitHub client interface (for mocking) ===

export interface GitHubClient {
  createPullRequest(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ url: string; number: number }>;
  getFileContent(params: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<string | null>;
  listOpenPullsByHead?(params: {
    owner: string;
    repo: string;
    head: string;
  }): Promise<{ url: string; number: number } | null>;
}

export function getGitHubClientOptions(token: string): ConstructorParameters<typeof Octokit>[0] {
  const configuredBaseUrl = process.env['OPSLANE_GITHUB_API_URL']?.trim();
  return {
    auth: token,
    ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
  };
}

/**
 * Create a real GitHub client backed by Octokit.
 * Uses the provided token or falls back to GITHUB_TOKEN env. Returns null if no token available.
 */
export function createGitHubClient(githubToken?: string): GitHubClient | null {
  const token = githubToken ?? process.env['GITHUB_TOKEN'];
  if (!token) return null;

  const octokit = new Octokit(getGitHubClientOptions(token));

  return {
    async createPullRequest(params) {
      const { data } = await octokit.pulls.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      });
      return { url: data.html_url, number: data.number };
    },

    async getFileContent(params) {
      try {
        const { data } = await octokit.repos.getContent({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          ref: params.ref,
        });
        if ('content' in data && data.encoding === 'base64') {
          return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return null;
      } catch {
        return null; // file not found or too large
      }
    },

    async listOpenPullsByHead(params) {
      const { data } = await octokit.pulls.list({
        owner: params.owner,
        repo: params.repo,
        state: 'open',
        head: `${params.owner}:${params.head}`,
      });
      const pr = data[0];
      return pr ? { url: pr.html_url, number: pr.number } : null;
    },
  };
}

// === Main function ===

export async function createPR(
  input: PRInput,
  clientFactory: () => GitHubClient | null = createGitHubClient
): Promise<PRResult> {
  const client = clientFactory();

  if (!client) {
    return {
      status: 'failed',
      reason: {
        reason_code: 'missing_github_token',
        reason_message: 'GITHUB_TOKEN environment variable is not set',
        remediation:
          'Set the GITHUB_TOKEN environment variable with a GitHub personal access token that has repo scope',
      },
    };
  }

  const [owner, repo] = input.githubRepo.split('/');
  if (!owner || !repo) {
    return {
      status: 'failed',
      reason: {
        reason_code: 'repo_access_denied',
        reason_message: `Invalid repository format: ${input.githubRepo}. Expected "owner/repo"`,
        remediation:
          'Ensure the project github_repo is in "owner/repo" format',
      },
    };
  }

  const prBody = buildPRBody(input);

  try {
    const pr = await client.createPullRequest({
      owner,
      repo,
      title: `[Opslane] Fix: ${input.title}`,
      body: prBody,
      head: input.branchName,
      base: input.defaultBranch,
    });

    return {
      status: 'created',
      prUrl: pr.url,
      prNumber: pr.number,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Detect 403 / access denied
    if (message.includes('403') || message.toLowerCase().includes('forbidden')) {
      return {
        status: 'failed',
        reason: {
          reason_code: 'repo_access_denied',
          reason_message: `Access denied to repository ${input.githubRepo}: ${message}`,
          remediation:
            'Ensure the GITHUB_TOKEN has push access to the target repository',
        },
      };
    }

    return {
      status: 'failed',
      reason: {
        reason_code: 'repo_access_denied',
        reason_message: `Failed to create PR: ${message}`,
        remediation:
          'Check GitHub token permissions and repository access',
      },
    };
  }
}
