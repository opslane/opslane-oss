import { formatDistanceToNow, format } from 'date-fns';
import type { ErrorGroupStatus } from './types/api';
import { incidentStatusRecipe } from './status-recipes';

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '\u2014';
  return formatDistanceToNow(d, { addSuffix: true });
}

export function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '\u2014';
  return format(d, 'PPpp');
}

/**
 * Compact age for narrow numeric table columns: `30s`, `55m`, `10h`, `5d`,
 * `3mo`, `2y`. `formatDate` produces prose ("about 7 days ago") which wraps
 * and destroys column alignment.
 *
 * `now` is injectable so tests do not depend on wall-clock time.
 */
export function formatCompactAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (isNaN(then.getTime())) return '\u2014';

  // Clock skew between browser and ingest can put a timestamp slightly in the
  // future. Show 0s rather than a negative age.
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  // Gate on days, not the derived month count: 360-364 days floor to 12 months
  // but to 0 years, so a `months < 12` cutoff would print "0y".
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function getProjectId(): string {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('project_id') ??
    localStorage.getItem('opslane_project_id') ??
    ''
  );
}

export function statusBadgeClass(status: ErrorGroupStatus): string {
  return incidentStatusRecipe(status).class;
}

export function statusLabel(status: ErrorGroupStatus): string {
  return incidentStatusRecipe(status).label;
}

export interface SafeUrlOptions {
  /**
   * Reject `http:`. Defaults to false, preserving the historic behavior —
   * AdminView renders trace_url through this function and LANGFUSE_BASE_URL
   * may legitimately be a self-hosted http:// origin (docker-compose.yml:119).
   */
  httpsOnly?: boolean;
  /**
   * Exact hostname allowlist, lowercased. Omit to allow any host.
   * Exact matching is deliberate: a prefix test (startsWith('github.'))
   * accepts github.evil.com, and a suffix test (endsWith('github.com'))
   * accepts notgithub.com. Neither is an origin check.
   */
  hosts?: readonly string[];
}

/** PR links are GitHub-only. Enterprise hosts are unsupported — see TODOS.md. */
export const GITHUB_PR_URL_OPTIONS: SafeUrlOptions = {
  httpsOnly: true,
  hosts: ['github.com', 'www.github.com'],
};

/**
 * Sole URL sanitizer for the dashboard. Everything bound to an href passes
 * through here, because worker- and model-derived strings are untrusted
 * (packages/dashboard/AGENTS.md) and Vue does not sanitize href.
 *
 * Permissive mode returns the original string so visible raw URL text remains
 * identical to the destination. Strict mode returns the normalized URL that
 * was validated, avoiding parser differentials at hardened call sites.
 */
export function safeUrl(
  url: string | undefined | null,
  options: SafeUrlOptions = {},
): string | undefined {
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const allowedProtocols = options.httpsOnly ? ['https:'] : ['https:', 'http:'];
  if (!allowedProtocols.includes(parsed.protocol)) return undefined;

  if (parsed.username || parsed.password) return undefined;

  if (options.hosts && !options.hosts.includes(parsed.hostname.toLowerCase())) {
    return undefined;
  }

  const strict = options.httpsOnly === true || options.hosts !== undefined;
  return strict ? parsed.toString() : url;
}
