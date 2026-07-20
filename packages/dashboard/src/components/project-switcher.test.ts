import { describe, expect, it } from 'vitest';

import {
  applyProjectSelection,
  projectSwitchQuery,
  shouldSwitchProject,
} from './project-switcher';

function storageStub(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  };
}

describe('project switcher', () => {
  it('switches only to a different non-empty project while idle', () => {
    expect(shouldSwitchProject('project-b', 'project-a', false)).toBe(true);
    expect(shouldSwitchProject('project-a', 'project-a', false)).toBe(false);
    expect(shouldSwitchProject('', 'project-a', false)).toBe(false);
    expect(shouldSwitchProject('project-b', 'project-a', true)).toBe(false);
  });

  it('persists the project and clears project-scoped filter storage', () => {
    const { storage, values } = storageStub({
      opslane_environment_id: 'env-old',
      opslane_account_id: 'account-old',
    });

    applyProjectSelection(storage, { id: 'project-b', name: 'Project B' });

    expect(values.get('opslane_project_id')).toBe('project-b');
    expect(values.get('opslane_project_name')).toBe('Project B');
    expect(values.has('opslane_environment_id')).toBe(false);
    expect(values.has('opslane_account_id')).toBe(false);
  });

  it('strips route overrides and project-scoped filters on navigation home', () => {
    expect(projectSwitchQuery({
      project_id: 'project-a',
      environment_id: 'env-a',
      account_id: 'account-a',
      status: 'new',
      retained: 'value',
    })).toEqual({ retained: 'value' });
  });
});
