import { describe, expect, it } from 'vitest';

import { labelFor, reduceTasks, type TaskLine } from '../events.js';

const assistant = (blocks: unknown[]) => ({ type: 'assistant', message: { content: blocks } });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const user = (blocks: unknown[]) => ({ type: 'user', message: { content: blocks } });
const toolResult = (id: string, isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  is_error: isError,
});

describe('onboarding task reducer', () => {
  it('reduces every tool block and applies each tool result independently', () => {
    let tasks: TaskLine[] = reduceTasks(
      [],
      assistant([
        toolUse('a', 'Glob', { pattern: 'src/**' }),
        toolUse('b', 'Read', { file_path: '/r/b' }),
      ]),
    );

    expect(tasks).toHaveLength(2);
    tasks = reduceTasks(tasks, user([toolResult('a'), toolResult('b', true)]));
    expect(tasks.find(({ id }) => id === 'a')?.state).toBe('done');
    expect(tasks.find(({ id }) => id === 'b')?.state).toBe('fail');
  });

  it('settles every running task from the terminal result', () => {
    const running = reduceTasks([], assistant([toolUse('a', 'Read', { file_path: '/r/a' })]));

    expect(reduceTasks(running, { type: 'result', subtype: 'success' })[0]?.state).toBe('done');
    expect(reduceTasks(running, { type: 'result', subtype: 'error_max_turns' })[0]?.state).toBe(
      'fail',
    );
  });

  it('produces friendly labels for detect-stage tools', () => {
    expect(labelFor('Read', { file_path: '/r/src/main.ts' })).toMatch(/read.*main\.ts/i);
    expect(labelFor('mcp__onboard__report_plan', {})).toMatch(/report.*plan/i);
    expect(labelFor('mcp__onboard__search', {})).toMatch(/search/i);
  });
});
