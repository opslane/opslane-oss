import { describe, expect, it } from 'vitest';
import { APP_NAVIGATION, isNavigationItemActive } from './navigation';

describe('application navigation', () => {
  it('keeps detail routes associated with their parent ledger section', () => {
    const incidents = APP_NAVIGATION.find((item) => item.routeName === 'issues');
    const accounts = APP_NAVIGATION.find((item) => item.routeName === 'accounts');
    const sessions = APP_NAVIGATION.find((item) => item.routeName === 'sessions');

    expect(incidents && isNavigationItemActive(incidents, 'incident')).toBe(true);
    expect(accounts && isNavigationItemActive(accounts, 'account-detail')).toBe(true);
    expect(sessions && isNavigationItemActive(sessions, 'session-detail')).toBe(true);
  });

  it('does not mark unrelated or unresolved routes active', () => {
    const incidents = APP_NAVIGATION[0];

    expect(isNavigationItemActive(incidents, 'settings')).toBe(false);
    expect(isNavigationItemActive(incidents, undefined)).toBe(false);
  });
});
