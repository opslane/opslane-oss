import path from 'node:path';

export interface TaskLine {
  id: string;
  label: string;
  state: 'run' | 'done' | 'fail';
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  is_error?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(message: unknown): unknown[] {
  if (!isRecord(message) || !isRecord(message.message) || !Array.isArray(message.message.content)) {
    return [];
  }
  return message.message.content;
}

function asToolUse(value: unknown): ToolUseBlock | null {
  if (
    !isRecord(value) ||
    value.type !== 'tool_use' ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.input)
  ) {
    return null;
  }
  return value as unknown as ToolUseBlock;
}

function asToolResult(value: unknown): ToolResultBlock | null {
  if (!isRecord(value) || value.type !== 'tool_result' || typeof value.tool_use_id !== 'string') {
    return null;
  }
  return value as unknown as ToolResultBlock;
}

function displayPath(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'pattern']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return undefined;
}

export function labelFor(toolName: string, input: Record<string, unknown>): string {
  const file = displayPath(input);
  const shown = file === undefined ? '' : ` ${path.basename(file)}`;
  const labels: Record<string, string> = {
    Read: `Read${shown}`,
    Glob: `Find files${shown}`,
    Edit: `Edit${shown}`,
    MultiEdit: `Edit${shown}`,
    Write: `Write${shown}`,
    Bash: `Run ${typeof input.command === 'string' ? input.command : 'check'}`,
    mcp__onboard__ask_user: 'Ask user',
    mcp__onboard__report_plan: 'Report onboarding plan',
    mcp__onboard__search: 'Search repository',
  };
  return labels[toolName] ?? toolName;
}

export function reduceTasks(tasks: TaskLine[], message: unknown): TaskLine[] {
  let next = tasks.map((task) => ({ ...task }));
  for (const block of contentBlocks(message)) {
    const use = asToolUse(block);
    if (use !== null) {
      next.push({ id: use.id, label: labelFor(use.name, use.input), state: 'run' });
      continue;
    }
    const result = asToolResult(block);
    if (result !== null) {
      next = next.map((task) =>
        task.id === result.tool_use_id
          ? { ...task, state: result.is_error === true ? 'fail' : 'done' }
          : task,
      );
    }
  }

  if (isRecord(message) && message.type === 'result') {
    const state: TaskLine['state'] = message.subtype === 'success' ? 'done' : 'fail';
    next = next.map((task) => (task.state === 'run' ? { ...task, state } : task));
  }
  return next;
}
