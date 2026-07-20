import { describe, expect, it } from 'vitest';

import { formatBreadcrumb, getRequestContext } from './sample-event';

describe('getRequestContext', () => {
  it('narrows request fields and string header values', () => {
    expect(getRequestContext({
      request: {
        method: 'GET',
        path: '/users/42',
        remote_addr: '203.0.113.8',
        headers: {
          Accept: 'application/json',
          ignored: 42,
        },
      },
    })).toEqual({
      method: 'GET',
      path: '/users/42',
      remote_addr: '203.0.113.8',
      headers: [{ name: 'Accept', value: 'application/json' }],
    });
  });

  it('rejects non-object request context', () => {
    expect(getRequestContext({ request: 'GET /users/42' })).toBeNull();
    expect(getRequestContext({ request: null })).toBeNull();
  });
});

describe('formatBreadcrumb', () => {
  it('formats only narrowed string fields', () => {
    expect(formatBreadcrumb({
      timestamp: '2026-07-19T00:00:00Z',
      type: 'log',
      category: 'app',
      level: 'warning',
      message: 'Near expiry',
      ignored: { nested: true },
    })).toEqual({
      timestamp: '2026-07-19T00:00:00Z',
      label: 'log · app',
      level: 'warning',
      message: 'Near expiry',
    });
  });

  it('drops scalars and objects without displayable strings', () => {
    expect(formatBreadcrumb('not an object')).toBeNull();
    expect(formatBreadcrumb({ message: 42 })).toBeNull();
  });
});
