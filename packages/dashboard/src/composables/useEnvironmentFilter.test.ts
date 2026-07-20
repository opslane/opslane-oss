// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  ENVIRONMENT_STORAGE_KEY,
  environmentFilterQuery,
  initialEnvironmentId,
  persistEnvironmentId,
} from './useEnvironmentFilter';

describe('environment filter state', () => {
  it('prefers a URL query value over the persisted selection', () => {
    expect(initialEnvironmentId('env-url', 'env-stored')).toBe('env-url');
    expect(initialEnvironmentId(undefined, 'env-stored')).toBe('env-stored');
    expect(initialEnvironmentId(['env-first', 'env-second'], 'env-stored')).toBe('env-first');
  });

  it('adds and removes only environment_id in a query snapshot', () => {
    expect(environmentFilterQuery({ account_id: 'account-1' }, 'env-1')).toEqual({
      account_id: 'account-1',
      environment_id: 'env-1',
    });
    expect(environmentFilterQuery({ account_id: 'account-1', environment_id: 'env-1' }, '')).toEqual({
      account_id: 'account-1',
    });
  });

  it('persists a selection and removes it when cleared', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    persistEnvironmentId(storage, 'env-1');
    expect(values.get(ENVIRONMENT_STORAGE_KEY)).toBe('env-1');
    persistEnvironmentId(storage, '');
    expect(values.has(ENVIRONMENT_STORAGE_KEY)).toBe(false);
  });
});
