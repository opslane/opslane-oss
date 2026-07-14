import { describe, it, expect, beforeEach } from 'vitest';
import { shouldThrottle, _resetThrottle } from '../throttle';

describe('shouldThrottle', () => {
  beforeEach(() => _resetThrottle());

  it('lets the first occurrence through, throttles a duplicate within the window', () => {
    expect(shouldThrottle('TypeError', 'x', 'at a.js:1:1', 1000, 0)).toBe(false);
    expect(shouldThrottle('TypeError', 'x', 'at a.js:1:1', 1000, 500)).toBe(true);
  });
  it('lets it through again after the window elapses', () => {
    expect(shouldThrottle('TypeError', 'x', 'at a.js:1:1', 1000, 0)).toBe(false);
    expect(shouldThrottle('TypeError', 'x', 'at a.js:1:1', 1000, 1500)).toBe(false);
  });
  it('treats distinct errors independently', () => {
    expect(shouldThrottle('TypeError', 'x', '', 1000, 0)).toBe(false);
    expect(shouldThrottle('RangeError', 'y', '', 1000, 0)).toBe(false);
  });
  it('is disabled when the window is zero', () => {
    expect(shouldThrottle('TypeError', 'x', '', 0, 0)).toBe(false);
    expect(shouldThrottle('TypeError', 'x', '', 0, 0)).toBe(false);
  });
});
