import { describe, it, expect } from 'vitest';
import { kindBadge, fixControlsVisible } from './incident-kind';

describe('kindBadge', () => {
  it('maps kinds to stable, accessible badges', () => {
    const error = kindBadge('error', undefined);
    expect(error.label).toBe('Error');
    expect(error.class).toContain('bg-');

    const friction = kindBadge('friction', undefined);
    expect(friction.label).toBe('Friction');
    expect(friction.class).toContain('bg-');
    expect(friction.class).not.toBe(error.class);
  });

  it('flags exhausted adjudications as Unchecked', () => {
    const unchecked = kindBadge('friction', 'unchecked');
    expect(unchecked.label).toBe('Unchecked');
    expect(unchecked.class).toContain('bg-');
  });

  it('never marks error incidents unchecked', () => {
    expect(kindBadge('error', 'unchecked').label).toBe('Error');
  });
});

describe('fixControlsVisible', () => {
  it('errors: only investigated exposes the fix control', () => {
    expect(fixControlsVisible('error', 'investigated')).toBe(true);
    expect(fixControlsVisible('error', 'fixing')).toBe(false);
    expect(fixControlsVisible('error', 'resolved')).toBe(false);
  });

  it('friction: only awaiting_approval exposes the fix control', () => {
    expect(fixControlsVisible('friction', 'awaiting_approval')).toBe(true);
    expect(fixControlsVisible('friction', 'investigated')).toBe(false);
    expect(fixControlsVisible('friction', 'insight')).toBe(false);
    expect(fixControlsVisible('friction', 'candidate')).toBe(false);
  });
});
