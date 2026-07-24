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

const CLONE_DETAIL_LIMIT = 2_000;

/** Scrub clone credentials and bound detail before persistence or display. */
export function redactCloneDetail(detail: string): string {
  const scrubbed = scrubSecrets(detail)
    .replace(/x-access-token:[^@\s]{1,512}@/g, 'x-access-token:***@');
  return scrubbed.length > CLONE_DETAIL_LIMIT
    ? `${scrubbed.slice(0, CLONE_DETAIL_LIMIT)}… (truncated)`
    : scrubbed;
}
