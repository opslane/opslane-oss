import {
  query,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { onboardPreToolUseHook } from './policy.js';
import { createSearchTool } from './search-tool.js';
import { renderDetectSpec } from './spec.js';
import {
  createAskUserTool,
  createOnboardServer,
  createReportPlanTool,
  type AskUserResolver,
  type OnboardingPlan,
} from './tools.js';

const SHADOW_WARNING = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
const INTENTIONALLY_SHADOWED_TOOLS = new Set([
  'mcp__onboard__report_plan',
  'mcp__onboard__ask_user',
]);
const REPORT_PLAN_TOOL = 'mcp__onboard__report_plan';

export type QueryFn = (request: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface EngineResult {
  ok: boolean;
  aborted: boolean;
  subtype?: string;
  reason?: string;
}

export function detectOptions({
  cwd,
  hook,
  mcpServers,
  abortController,
}: {
  cwd: string;
  hook: HookCallback;
  mcpServers: Record<string, McpServerConfig>;
  abortController: AbortController;
}): Options {
  return {
    cwd,
    permissionMode: 'default',
    settingSources: [],
    strictMcpConfig: true,
    allowedTools: ['mcp__onboard__report_plan', 'mcp__onboard__ask_user'],
    tools: ['Read', 'Glob'],
    disallowedTools: [
      'Grep',
      'Write',
      'Edit',
      'MultiEdit',
      'Bash',
      'WebFetch',
      'WebSearch',
    ],
    mcpServers,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    canUseTool: async (toolName) => {
      // `search` is a bounded, secret-aware local MCP tool. It deliberately
      // remains outside allowedTools so the SDK still consults this fail-closed gate.
      if (toolName === 'Read' || toolName === 'Glob' || toolName === 'mcp__onboard__search') {
        return { behavior: 'allow' };
      }
      return {
        behavior: 'deny',
        message: `Detect stage does not allow tool ${toolName}`,
      };
    },
    abortController,
    maxTurns: 50,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warningCode(warning: Error): string | undefined {
  const code = (warning as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isShadowWarning(warning: Error): boolean {
  return (
    warningCode(warning) === SHADOW_WARNING ||
    warning.name.includes(SHADOW_WARNING) ||
    warning.message.includes(SHADOW_WARNING)
  );
}

function isIntentionalShadowWarning(warning: Error): boolean {
  const match = /canUseTool will not be invoked for: ([^.]+)\./.exec(warning.message);
  if (match === null) return false;
  const shadowedTools = match[1]!.split(',').map((toolName) => toolName.trim());
  return (
    shadowedTools.length > 0 &&
    shadowedTools.every((toolName) => INTENTIONALLY_SHADOWED_TOOLS.has(toolName))
  );
}

function contentBlocks(message: unknown): unknown[] {
  if (!isRecord(message) || !isRecord(message.message) || !Array.isArray(message.message.content)) {
    return [];
  }
  return message.message.content;
}

interface ReportStreamState {
  toolUseIds: Set<string>;
  settledToolUseIds: Set<string>;
  successfulResults: number;
  acceptedResultSeen: boolean;
  attemptedAfterSuccess: boolean;
}

function updateReportStream(message: unknown, state: ReportStreamState): void {
  for (const block of contentBlocks(message)) {
    if (
      isRecord(block) &&
      block.type === 'tool_use' &&
      block.name === REPORT_PLAN_TOOL &&
      typeof block.id === 'string'
    ) {
      if (state.acceptedResultSeen) state.attemptedAfterSuccess = true;
      state.toolUseIds.add(block.id);
      continue;
    }
    if (
      isRecord(block) &&
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      state.toolUseIds.has(block.tool_use_id) &&
      !state.settledToolUseIds.has(block.tool_use_id)
    ) {
      state.settledToolUseIds.add(block.tool_use_id);
      if (block.is_error === true) {
        if (state.acceptedResultSeen) state.attemptedAfterSuccess = true;
      } else {
        state.successfulResults += 1;
        state.acceptedResultSeen = true;
      }
    }
  }
}

export async function runDetect({
  cwd,
  onMessage,
  onPlan,
  signal,
  askUser = null,
  queryFn = (request) => query(request),
}: {
  cwd: string;
  onMessage: (message: SDKMessage) => void;
  onPlan: (plan: OnboardingPlan) => void;
  signal: AbortSignal;
  askUser?: AskUserResolver | null;
  queryFn?: QueryFn;
}): Promise<EngineResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, aborted: false, reason: 'no_api_key' };
  }
  if (signal.aborted) {
    return { ok: false, aborted: true, reason: 'aborted' };
  }

  const abortController = new AbortController();
  const abortFromCaller = () => abortController.abort();
  signal.addEventListener('abort', abortFromCaller, { once: true });

  let shadowError: Error | undefined;
  const onWarning = (warning: Error) => {
    if (!isShadowWarning(warning) || isIntentionalShadowWarning(warning)) return;
    shadowError = new Error(`Agent SDK permission callback was shadowed: ${warning.message}`);
    abortController.abort();
  };
  process.on('warning', onWarning);

  let planCaptures = 0;
  let reportCaptures = 0;
  let unsupportedReason: string | undefined;
  const capturePlan = (plan: OnboardingPlan) => {
    planCaptures += 1;
    reportCaptures += 1;
    onPlan(plan);
  };
  const captureUnsupported = (reason: string) => {
    reportCaptures += 1;
    unsupportedReason = reason;
  };

  const hook = onboardPreToolUseHook({ root: cwd });
  const mcpServers = {
    onboard: createOnboardServer(
      createReportPlanTool(cwd, capturePlan, captureUnsupported),
      createAskUserTool(askUser),
      createSearchTool(cwd),
    ),
  };
  const reportStream: ReportStreamState = {
    toolUseIds: new Set<string>(),
    settledToolUseIds: new Set<string>(),
    successfulResults: 0,
    acceptedResultSeen: false,
    attemptedAfterSuccess: false,
  };
  let terminalSubtype: string | undefined;
  let caughtError: Error | undefined;

  try {
    const messages = queryFn({
      prompt: renderDetectSpec({ cwd }),
      options: detectOptions({ cwd, hook, mcpServers, abortController }),
    });
    for await (const message of messages) {
      onMessage(message);
      updateReportStream(message, reportStream);
      if (
        isRecord(message) &&
        message.type === 'result' &&
        typeof message.subtype === 'string'
      ) {
        terminalSubtype = message.subtype;
      }
    }
  } catch (error) {
    caughtError = error instanceof Error ? error : new Error(String(error));
  } finally {
    process.off('warning', onWarning);
    signal.removeEventListener('abort', abortFromCaller);
  }

  if (shadowError !== undefined) {
    return { ok: false, aborted: false, reason: shadowError.message };
  }
  if (signal.aborted || abortController.signal.aborted) {
    return { ok: false, aborted: true, subtype: terminalSubtype, reason: 'aborted' };
  }
  if (caughtError !== undefined) {
    return { ok: false, aborted: false, subtype: terminalSubtype, reason: caughtError.message };
  }
  if (terminalSubtype === undefined) {
    return { ok: false, aborted: false, reason: 'missing_result' };
  }
  if (terminalSubtype !== 'success') {
    return { ok: false, aborted: false, subtype: terminalSubtype, reason: terminalSubtype };
  }
  if (
    reportCaptures > 1 ||
    planCaptures > 1 ||
    reportStream.successfulResults > 1 ||
    reportStream.attemptedAfterSuccess
  ) {
    return { ok: false, aborted: false, subtype: terminalSubtype, reason: 'multiple_plans' };
  }
  if (unsupportedReason !== undefined) {
    return { ok: false, aborted: false, subtype: terminalSubtype, reason: 'unsupported' };
  }
  if (reportCaptures === 0 || planCaptures === 0) {
    return { ok: false, aborted: false, subtype: terminalSubtype, reason: 'no_plan' };
  }
  return { ok: true, aborted: false, subtype: terminalSubtype };
}
