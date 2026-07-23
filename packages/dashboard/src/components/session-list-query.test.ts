import { describe, expect, it } from 'vitest';
import type { SessionFilters } from '../types/api';
import { applySessionFilters, sessionPageRequest, snapshotSessionFilters } from './session-list-query';

describe('session list pagination query', () => {
  it('keeps a cursor paired with the filters that produced it', () => {
    const draft: SessionFilters = { search: 'account-a', from: '2026-07-15T00:00:00Z' };
    const applied = snapshotSessionFilters(draft);
    draft.search = 'account-b';

    expect(sessionPageRequest(applied, 'cursor-a')).toEqual({
      filters: { search: 'account-a', from: '2026-07-15T00:00:00Z' },
      cursor: 'cursor-a',
    });
  });

  it('returns defensive filter copies for page requests', () => {
    const applied: SessionFilters = { search: 'user-a' };
    const first = sessionPageRequest(applied, 'cursor-a');
    first.filters.search = 'mutated';
    expect(sessionPageRequest(applied, 'cursor-b').filters.search).toBe('user-a');
  });

  it('includes environment_id and resets the cursor when filters are applied', () => {
    expect(applySessionFilters({
      search: 'account-a',
      has_signals: true,
      environment_id: 'env-staging',
    })).toEqual({
      filters: {
        search: 'account-a',
        has_signals: true,
        environment_id: 'env-staging',
      },
      cursor: null,
    });
  });
});
