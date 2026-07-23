export interface AppNavigationItem {
  label: string;
  routeName: string;
  relatedRoutes: readonly string[];
  adminOnly?: boolean;
}

export const APP_NAVIGATION: readonly AppNavigationItem[] = [
  { label: 'Issues', routeName: 'activity', relatedRoutes: ['incident'] },
  { label: 'Accounts', routeName: 'accounts', relatedRoutes: ['account-detail'] },
  { label: 'Sessions', routeName: 'sessions', relatedRoutes: ['session-detail'] },
  { label: 'Settings', routeName: 'settings', relatedRoutes: [] },
  { label: 'Admin', routeName: 'admin', relatedRoutes: [], adminOnly: true },
] as const;

export function isNavigationItemActive(item: AppNavigationItem, currentRouteName: unknown): boolean {
  return currentRouteName === item.routeName
    || (typeof currentRouteName === 'string' && item.relatedRoutes.includes(currentRouteName));
}
