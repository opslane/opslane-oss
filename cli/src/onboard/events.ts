import path from 'node:path';

import { containedRepoRelative } from './paths.js';

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

interface ToolLogEntry {
  seq: number;
  id: string;
  kind: 'edit' | 'finish';
  path?: string;
  committed: boolean;
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
    mcp__onboard__finish_onboarding: 'Finish onboarding',
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

export class EditTracker {
  readonly #root: string;
  readonly #log: ToolLogEntry[] = [];
  #nextSequence = 0;
  #finishedSequence: number | null = null;

  constructor(root: string) {
    this.#root = root;
  }

  onMessage(message: unknown): void {
    for (const block of contentBlocks(message)) {
      const use = asToolUse(block);
      if (use !== null) {
        if (['Edit', 'MultiEdit', 'Write'].includes(use.name)) {
          const filePath = displayPath(use.input);
          if (filePath !== undefined) {
            this.#log.push({
              seq: this.#nextSequence++,
              id: use.id,
              kind: 'edit',
              path: containedRepoRelative(this.#root, filePath),
              committed: false,
            });
          }
        } else if (use.name === 'mcp__onboard__finish_onboarding') {
          this.#log.push({
            seq: this.#nextSequence++,
            id: use.id,
            kind: 'finish',
            committed: false,
          });
        }
        continue;
      }

      const result = asToolResult(block);
      if (result === null) continue;
      const entry = this.#log.find(({ id }) => id === result.tool_use_id);
      if (entry !== undefined && result.is_error !== true) entry.committed = true;
    }
  }

  markFinished(id: string): void {
    const finish = this.#log.find((entry) => entry.id === id && entry.kind === 'finish');
    if (finish === undefined || !finish.committed) {
      throw new Error(`Cannot mark uncommitted finish tool '${id}' as accepted`);
    }
    this.#finishedSequence = finish.seq;
  }

  committedBeforeFinish(): Set<string> {
    const boundary = this.#finishedSequence ?? Number.POSITIVE_INFINITY;
    return new Set(
      this.#log
        .filter(
          (entry) =>
            entry.kind === 'edit' &&
            entry.committed &&
            entry.seq < boundary &&
            entry.path !== undefined,
        )
        .map((entry) => entry.path!),
    );
  }

  editsAfterFinish(): string[] {
    if (this.#finishedSequence === null) return [];
    return this.#log
      .filter(
        (entry) =>
          entry.kind === 'edit' &&
          entry.committed &&
          entry.seq >= this.#finishedSequence! &&
          entry.path !== undefined,
      )
      .map((entry) => entry.path!);
  }
}
