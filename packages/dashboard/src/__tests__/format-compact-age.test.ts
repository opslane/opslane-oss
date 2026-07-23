import { describe, expect, it } from 'vitest';
import { formatCompactAge } from '../utils';

const NOW = new Date('2026-07-22T12:00:00Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('formatCompactAge', () => {
  it('renders seconds under a minute', () => {
    expect(formatCompactAge('2026-07-22T11:59:30Z', NOW)).toBe('30s');
  });

  it('renders whole minutes under an hour', () => {
    expect(formatCompactAge('2026-07-22T11:05:00Z', NOW)).toBe('55m');
  });

  it('renders whole hours under a day', () => {
    expect(formatCompactAge('2026-07-22T02:00:00Z', NOW)).toBe('10h');
  });

  it('renders whole days under a month', () => {
    expect(formatCompactAge(daysBefore(5), NOW)).toBe('5d');
  });

  it('renders months beyond 30 days', () => {
    expect(formatCompactAge(daysBefore(90), NOW)).toBe('3mo');
  });

  it('keeps rendering months across the 360-364 day gap', () => {
    expect(formatCompactAge(daysBefore(359), NOW)).toBe('11mo');
    expect(formatCompactAge(daysBefore(360), NOW)).toBe('12mo');
    expect(formatCompactAge(daysBefore(364), NOW)).toBe('12mo');
  });

  it('switches to years at exactly 365 days', () => {
    expect(formatCompactAge(daysBefore(365), NOW)).toBe('1y');
    expect(formatCompactAge(daysBefore(730), NOW)).toBe('2y');
  });

  it('returns an em dash for an unparseable timestamp', () => {
    expect(formatCompactAge('not-a-date', NOW)).toBe('\u2014');
  });

  it('clamps a future timestamp to 0s rather than showing a negative age', () => {
    expect(formatCompactAge('2026-07-23T12:00:00Z', NOW)).toBe('0s');
  });
});
