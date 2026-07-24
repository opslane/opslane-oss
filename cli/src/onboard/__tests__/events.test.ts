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

describe('EditTracker', () => {
  const fixtureRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'opslane-edit-tracker-'));
    mkdirSync(join(root, 'src'));
    return root;
  };

  it('orders committed edits around the successful finish result', () => {
    const root = fixtureRoot();
    const tracker = new EditTracker(root);

    tracker.onMessage(assistant([toolUse('edit-1', 'Edit', { file_path: join(root, 'src/main.ts') })]));
    tracker.onMessage(user([toolResult('edit-1')]));
    tracker.onMessage(
      assistant([toolUse('finish-1', 'mcp__onboard__finish_apply', { edited_files: [] })]),
    );
    tracker.onMessage(user([toolResult('finish-1')]));
    tracker.onMessage(assistant([toolUse('edit-2', 'Write', { file_path: join(root, 'src/late.ts') })]));
    tracker.onMessage(user([toolResult('edit-2')]));

    expect(tracker.committedBeforeFinish()).toEqual(['src/main.ts']);
    expect(tracker.editsAfterFinish()).toEqual(['src/late.ts']);
  });

  it('does not commit errored edits and preserves duplicate file commits', () => {
    const root = fixtureRoot();
    const tracker = new EditTracker(root);

    tracker.onMessage(
      assistant([
        toolUse('edit-1', 'Edit', { file_path: join(root, 'src/main.ts') }),
        toolUse('edit-2', 'Edit', { file_path: join(root, 'src/main.ts') }),
        toolUse('edit-3', 'Write', { file_path: join(root, 'src/error.ts') }),
      ]),
    );
    expect(tracker.hasUnsettledEdits()).toBe(true);
    tracker.onMessage(user([toolResult('edit-1'), toolResult('edit-2'), toolResult('edit-3', true)]));
    tracker.markFinished('finish-1');

    expect(tracker.hasUnsettledEdits()).toBe(false);
    expect(tracker.committedBeforeFinish()).toEqual(['src/main.ts', 'src/main.ts']);
    expect(tracker.editsAfterFinish()).toEqual([]);
  });

  it('keeps an edit unsettled until its matching tool result arrives', () => {
    const root = fixtureRoot();
    const tracker = new EditTracker(root);

    tracker.onMessage(assistant([toolUse('edit-1', 'Edit', { file_path: join(root, 'src/main.ts') })]));

    expect(tracker.hasUnsettledEdits()).toBe(true);
    tracker.onMessage(user([toolResult('edit-1')]));
    expect(tracker.hasUnsettledEdits()).toBe(false);
  });
});
