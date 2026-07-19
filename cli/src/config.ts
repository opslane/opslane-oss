/**
 * Shared CLI configuration.
 *
 * The default target is hosted Opslane (design decision 2). Self-hosters
 * override with OPSLANE_API_URL. This is a function, not a module-level
 * constant, so the environment is read at call time (testable, and correct
 * when the env is set programmatically before a command runs).
 */
export function defaultApiUrl(): string {
  return process.env['OPSLANE_API_URL'] ?? 'https://api.opslane.com';
}
