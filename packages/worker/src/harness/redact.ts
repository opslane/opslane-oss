/**
 * Scrub credentials and API tokens from text before storage, logging, or
 * prompt injection. Never truncates — callers bound length themselves.
 */
export function scrubSecrets(raw: string): string {
  return raw
    .replace(/https:\/\/[^@\s]+@/g, 'https://***@')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
