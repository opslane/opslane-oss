const PROJECT_EXEMPT_ROUTES = new Set(['setup', 'login', 'auth-callback', 'admin']);

export function routeNeedsProject(routeName: unknown): boolean {
  return !PROJECT_EXEMPT_ROUTES.has(String(routeName));
}
