import type { AuthMembership } from '../types/api';

export function canManageInvitations(role?: AuthMembership['role']): boolean {
  return role === 'owner' || role === 'admin';
}
