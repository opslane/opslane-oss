import { describe, expect, it } from 'vitest';

import { statusBadgeClass, statusLabel } from './utils';

describe('incident status presentation', () => {
  it('labels and styles draft PRs separately from ready PRs', () => {
    expect(statusLabel('pr_draft')).toBe('Draft PR');
    expect(statusBadgeClass('pr_draft')).toContain('text-amber');
    expect(statusLabel('pr_created')).toBe('PR Created');
    expect(statusBadgeClass('pr_created')).toContain('text-green');
  });
});
