import { describe, expect, it } from 'vitest';
import { platformBadge } from './platform-badge';

describe('platformBadge', () => {
  it('labels javascript and python', () => {
    expect(platformBadge('javascript')?.label).toBe('JavaScript');
    expect(platformBadge('python')?.label).toBe('Python');
  });

  it('returns null for absent platform (friction incidents)', () => {
    expect(platformBadge(null)).toBeNull();
    expect(platformBadge(undefined)).toBeNull();
  });

  it('renders unknown future tokens verbatim rather than hiding them', () => {
    expect(platformBadge('ruby')?.label).toBe('ruby');
  });
});
