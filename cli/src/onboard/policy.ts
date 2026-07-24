import {
  type CanUseTool,
  type HookCallback,
  type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { containedRepoRelative, hasSecretSegment } from './paths.js';

const FILE_TOOLS = new Set(['Read', 'Glob', 'Edit', 'Write', 'MultiEdit']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);
const ALLOWED_BASH = /^(npm|pnpm|yarn|bun) run (build|typecheck|lint)$/;
const PATH_KEYS = new Set(['path', 'file_path', 'pattern']);

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

function pathValues(value: unknown, key?: string): string[] {
  if (typeof value === 'string') return key !== undefined && PATH_KEYS.has(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => pathValues(item, key));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([childKey, child]) => pathValues(child, childKey));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function onboardPreToolUseHook({
  root,
  state,
  writablePaths,
}: {
  root: string;
  state?: { finished: boolean };
  writablePaths?: Iterable<string>;
}): HookCallback {
  const canonicalWritable =
    writablePaths === undefined
      ? undefined
      : new Set(Array.from(writablePaths, (candidate) => containedRepoRelative(root, candidate)));
  return async (input) => {
    const preToolInput = input as PreToolUseHookInput;
    const toolName = preToolInput.tool_name;
    const toolInput = asRecord(preToolInput.tool_input);

    if (state?.finished === true) {
      return toolName === 'mcp__onboard__ask_user'
        ? {}
        : deny('Onboarding has already finished');
    }

    if (FILE_TOOLS.has(toolName)) {
      const paths = pathValues(toolInput);
      if (paths.length === 0) return deny(`${toolName} did not provide a path`);
      for (const candidate of paths) {
        let relative: string;
        try {
          relative = containedRepoRelative(root, candidate);
        } catch {
          return deny(`${toolName} path is not contained in the repository`);
        }
        if (hasSecretSegment(relative)) return deny(`${toolName} cannot access secret files`);
        if (
          canonicalWritable !== undefined &&
          EDIT_TOOLS.has(toolName) &&
          !canonicalWritable.has(relative)
        ) {
          return deny(`${toolName} is not allowed to modify ${relative}`);
        }
      }
    }

    if (toolName === 'Bash') {
      const command = toolInput.command;
      if (typeof command !== 'string' || !ALLOWED_BASH.test(command)) {
        return deny('Only exact package build, typecheck, or lint scripts are allowed');
      }
    }

    return {};
  };
}

export type ApprovalRequest = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<boolean>;

export function createOnboardApproval({
  requestApproval,
  allowedTools = [
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'Bash',
    'mcp__onboard__finish_apply',
    'mcp__onboard__ask_user',
  ],
}: {
  requestApproval: ApprovalRequest;
  allowedTools?: Iterable<string>;
}): CanUseTool {
  const allowed = new Set(allowedTools);
  return async (toolName, input) => {
    if (!allowed.has(toolName)) {
      return { behavior: 'deny', message: `Onboarding does not allow tool ${toolName}` };
    }
    if (!MUTATING_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };
    return (await requestApproval(toolName, input))
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'declined' };
  };
}
