import { describe, expect, it } from 'vitest';
import { adminStatusBadgeClass, formatDuration } from './admin-format';

describe('admin formatting', () => {
  it('formats nullable job durations without implying pending jobs completed', () => {
    expect(formatDuration(null)).toBe('\u2014');
    expect(formatDuration(0.4)).toBe('<1s');
    expect(formatDuration(75)).toBe('1m 15s');
    expect(formatDuration(3_720)).toBe('1h 2m');
  });

  it('highlights dead letters as failures', () => {
    expect(adminStatusBadgeClass('dead_letter')).toContain('text-red');
  });

  it('distinguishes draft PRs from ready PRs', () => {
    expect(adminStatusBadgeClass('pr_draft')).toContain('text-amber');
    expect(adminStatusBadgeClass('pr_created')).toContain('text-green');
  });
});
