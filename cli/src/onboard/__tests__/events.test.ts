import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EditTracker, labelFor, reduceTasks, type TaskLine } from '../events.js';

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
        toolUse('a', 'Edit', { file_path: '/r/a' }),
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

  it('produces friendly labels for known tools', () => {
    expect(labelFor('Edit', { file_path: '/r/src/main.ts' })).toMatch(/edit.*main\.ts/i);
    expect(labelFor('mcp__onboard__finish_onboarding', {})).toMatch(/finish/i);
  });
});

describe('EditTracker', () => {
  it('tracks committed edits in tool order around the accepted finish', () => {
    const root = mkdtempSync(join(tmpdir(), 'opslane-events-'));
    mkdirSync(join(root, 'src'));
    const tracker = new EditTracker(root);
    tracker.onMessage(
      assistant([toolUse('e1', 'Edit', { file_path: join(root, 'src', 'main.ts') })]),
    );
    tracker.onMessage(user([toolResult('e1')]));
    tracker.onMessage(
      assistant([toolUse('f', 'mcp__onboard__finish_onboarding', {})]),
    );
    tracker.onMessage(user([toolResult('f')]));
    tracker.onMessage(
      assistant([toolUse('e2', 'Write', { file_path: join(root, 'src', 'late.ts') })]),
    );
    tracker.onMessage(user([toolResult('e2')]));
    tracker.markFinished('f');

    expect([...tracker.committedBeforeFinish()]).toEqual(['src/main.ts']);
    expect(tracker.editsAfterFinish()).toEqual(['src/late.ts']);
  });

  it('does not commit denied or errored edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'opslane-events-'));
    mkdirSync(join(root, 'src'));
    const tracker = new EditTracker(root);
    tracker.onMessage(
      assistant([toolUse('e1', 'Edit', { file_path: join(root, 'src', 'main.ts') })]),
    );
    tracker.onMessage(user([toolResult('e1', true)]));
    tracker.onMessage(
      assistant([toolUse('f', 'mcp__onboard__finish_onboarding', {})]),
    );
    tracker.onMessage(user([toolResult('f')]));
    tracker.markFinished('f');

    expect([...tracker.committedBeforeFinish()]).toEqual([]);
  });
});
