// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLastAuthMethod, writeLastAuthMethod } from './useLastAuthMethod';

const KEY = 'opslane.last_auth_method';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('useLastAuthMethod', () => {
  it('round-trips every valid method', () => {
    for (const method of ['google', 'github', 'redirect', 'password'] as const) {
      writeLastAuthMethod(method);
      expect(readLastAuthMethod()).toBe(method);
    }
  });

  it('returns null when nothing has been stored', () => {
    expect(readLastAuthMethod()).toBeNull();
  });

  it('returns null for an unrecognised stored value', () => {
    window.localStorage.setItem(KEY, 'myspace');
    expect(readLastAuthMethod()).toBeNull();
  });

  it('returns null when reading from storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => readLastAuthMethod()).not.toThrow();
    expect(readLastAuthMethod()).toBeNull();
  });

  it('swallows a write failure instead of propagating it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeLastAuthMethod('google')).not.toThrow();
  });
});
