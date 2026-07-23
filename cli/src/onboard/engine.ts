import {
  query,
  type CanUseTool,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { createOnboardApproval, onboardPreToolUseHook, type ApprovalRequest } from './policy.js';
import { createSearchTool } from './search-tool.js';
import { renderSpec } from './spec.js';
import {
  createAskServer,
  createAskUserTool,
  createFinishTool,
  type AskUserResolver,
  type OnboardingReport,
} from './tools.js';

const SHADOW_WARNING = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';

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

export function engineOptions({
  cwd,
  canUseTool,
  hook,
  mcpServers,
  abortController,
}: {
  cwd: string;
  canUseTool: CanUseTool;
  hook: HookCallback;
  mcpServers: Record<string, McpServerConfig>;
  abortController: AbortController;
}): Options {
  return {
    cwd,
    permissionMode: 'default',
    settingSources: [],
    strictMcpConfig: true,
    allowedTools: ['mcp__onboard__ask_user'],
    tools: ['Read', 'Glob', 'Write', 'Edit', 'Bash'],
    disallowedTools: ['Grep', 'WebFetch', 'WebSearch'],
    mcpServers,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    canUseTool,
    abortController,
    maxTurns: 60,
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

function isExpectedAskUserShadow(warning: Error): boolean {
  const match = /canUseTool will not be invoked for: ([^.]+)\./.exec(warning.message);
  if (match === null) return false;
  const shadowedTools = match[1]!.split(',').map((toolName) => toolName.trim());
  return (
    shadowedTools.length > 0 &&
    shadowedTools.every((toolName) => toolName === 'mcp__onboard__ask_user')
  );
}

export async function runOnboardingAgent({
  cwd,
  onMessage,
  onReport,
  requestApproval,
  signal,
  askUser = null,
  queryFn = (request) => query(request),
}: {
  cwd: string;
  onMessage: (message: SDKMessage) => void;
  onReport: (report: OnboardingReport) => void;
  requestApproval: ApprovalRequest;
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

  const state = { finished: false };
  const abortController = new AbortController();
  const abortFromCaller = () => abortController.abort();
  signal.addEventListener('abort', abortFromCaller, { once: true });

  let shadowError: Error | undefined;
  const onWarning = (warning: Error) => {
    if (!isShadowWarning(warning) || isExpectedAskUserShadow(warning)) return;
    shadowError = new Error(`Agent SDK permission callback was shadowed: ${warning.message}`);
    abortController.abort();
  };
  process.on('warning', onWarning);

  const hook = onboardPreToolUseHook({ root: cwd, state });
  const canUseTool = createOnboardApproval({ requestApproval });
  const mcpServers = {
    onboard: createAskServer(
      createAskUserTool(askUser),
      createFinishTool(cwd, state, onReport),
      createSearchTool(cwd),
    ),
  };
  let terminalSubtype: string | undefined;
  let caughtError: Error | undefined;

  try {
    const messages = queryFn({
      prompt: renderSpec({ cwd }),
      options: engineOptions({ cwd, canUseTool, hook, mcpServers, abortController }),
    });
    for await (const message of messages) {
      onMessage(message);
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
  return {
    ok: terminalSubtype === 'success',
    aborted: false,
    subtype: terminalSubtype,
    reason: terminalSubtype === 'success' ? undefined : terminalSubtype,
  };
}
