import { describe, expect, it } from 'vitest';
import type { SessionFilters } from '../types/api';
import { sessionPageRequest, snapshotSessionFilters } from './session-list-query';

describe('session list pagination query', () => {
  it('keeps a cursor paired with the filters that produced it', () => {
    const draft: SessionFilters = { account_id: 'account-a', from: '2026-07-15T00:00:00Z' };
    const applied = snapshotSessionFilters(draft);
    draft.account_id = 'account-b';

    expect(sessionPageRequest(applied, 'cursor-a')).toEqual({
      filters: { account_id: 'account-a', from: '2026-07-15T00:00:00Z' },
      cursor: 'cursor-a',
    });
  });

  it('returns defensive filter copies for page requests', () => {
    const applied: SessionFilters = { end_user_id: 'user-a' };
    const first = sessionPageRequest(applied, 'cursor-a');
    first.filters.end_user_id = 'mutated';
    expect(sessionPageRequest(applied, 'cursor-b').filters.end_user_id).toBe('user-a');
  });
});
