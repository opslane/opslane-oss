import type { SessionFilters } from '../types/api';

/**
 * Captures the filters that produced a cursor. Pagination must use this
 * snapshot even while the user edits the next form submission.
 */
export function snapshotSessionFilters(filters: SessionFilters): SessionFilters {
  return { ...filters };
}

export interface SessionPageRequest {
  filters: SessionFilters;
  cursor?: string;
}

export interface AppliedSessionFilters {
  filters: SessionFilters;
  cursor: null;
}

export function applySessionFilters(filters: SessionFilters): AppliedSessionFilters {
  return {
    filters: snapshotSessionFilters(filters),
    cursor: null,
  };
}

export function sessionPageRequest(
  appliedFilters: SessionFilters,
  cursor?: string,
): SessionPageRequest {
  return { filters: snapshotSessionFilters(appliedFilters), cursor };
}
