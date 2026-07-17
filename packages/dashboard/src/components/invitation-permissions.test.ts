import { describe, expect, it } from 'vitest';
import { canManageInvitations } from './invitation-permissions';

describe('canManageInvitations', () => {
  it('allows owners and admins but not members or OSS users', () => {
    expect(canManageInvitations('owner')).toBe(true);
    expect(canManageInvitations('admin')).toBe(true);
    expect(canManageInvitations('member')).toBe(false);
    expect(canManageInvitations()).toBe(false);
  });
});
