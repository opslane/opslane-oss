import { describe, expect, it } from 'vitest';
import { shouldSwitchOrg } from './org-switcher';

describe('shouldSwitchOrg', () => {
  it('switches only to a different non-empty organization while idle', () => {
    expect(shouldSwitchOrg('org-b', 'org-a', false)).toBe(true);
    expect(shouldSwitchOrg('org-a', 'org-a', false)).toBe(false);
    expect(shouldSwitchOrg('', 'org-a', false)).toBe(false);
    expect(shouldSwitchOrg('org-b', 'org-a', true)).toBe(false);
  });
});
