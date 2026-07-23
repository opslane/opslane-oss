import { describe, expect, it } from 'vitest';
import { adminStatusBadgeClass, formatDuration, onboardingFunnelStages } from './admin-format';

describe('admin formatting', () => {
  it('formats nullable job durations without implying pending jobs completed', () => {
    expect(formatDuration(null)).toBe('\u2014');
    expect(formatDuration(0.4)).toBe('<1s');
    expect(formatDuration(75)).toBe('1m 15s');
    expect(formatDuration(3_720)).toBe('1h 2m');
  });

  it('does not carry rounded remainders into impossible duration units', () => {
    expect(formatDuration(59.5)).toBe('59s');
    expect(formatDuration(3_599.5)).toBe('59m 59s');
    expect(formatDuration(7_199)).toBe('1h 59m');
  });

  it('highlights dead letters as failures', () => {
    expect(adminStatusBadgeClass('dead_letter')).toContain('text-danger');
  });

  it('distinguishes draft PRs from ready PRs', () => {
    expect(adminStatusBadgeClass('pr_draft')).toContain('text-warning');
    expect(adminStatusBadgeClass('pr_created')).toContain('text-success');
  });

  it('formats the onboarding funnel in order with conversion from started', () => {
    const stages = onboardingFunnelStages({
      started: 10,
      auth_clicked: 8,
      completed: 6,
      key_claimed: 4,
      first_event_received: 3,
      failed: 2,
      by_failure_reason: {},
    });

    expect(stages.map(({ key }) => key)).toEqual([
      'started',
      'auth_clicked',
      'completed',
      'key_claimed',
      'first_event_received',
    ]);
    expect(stages.map(({ pctOfFirst }) => pctOfFirst)).toEqual([100, 80, 60, 40, 30]);
  });

  it('reports zero conversion rather than NaN when no onboarding sessions started', () => {
    const stages = onboardingFunnelStages({
      started: 0,
      auth_clicked: 0,
      completed: 0,
      key_claimed: 0,
      first_event_received: 0,
      failed: 0,
      by_failure_reason: {},
    });

    expect(stages.map(({ pctOfFirst }) => pctOfFirst)).toEqual([0, 0, 0, 0, 0]);
  });
});
