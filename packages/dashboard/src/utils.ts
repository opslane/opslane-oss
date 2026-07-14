import { formatDistanceToNow, format } from 'date-fns';
import type { ErrorGroupStatus } from './types/api';

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

export function getProjectId(): string {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('project_id') ??
    localStorage.getItem('opslane_project_id') ??
    ''
  );
}

export function statusBadgeClass(status: ErrorGroupStatus): string {
  switch (status) {
    case 'resolved':
      return 'bg-green-500/10 text-green';
    case 'merged':
    case 'pr_created':
      return 'bg-emerald-500/10 text-green';
    case 'needs_human':
      return 'bg-amber-500/10 text-amber';
    case 'analyzing':
    case 'queued':
      return 'bg-indigo-500/10 text-indigo';
    case 'investigated':
      return 'bg-teal-500/10 text-teal';
    case 'fixing':
      return 'bg-indigo-500/10 text-indigo animate-pulse';
    case 'archived':
      return 'bg-surface-2 text-text-faint';
    default:
      return 'bg-surface-2 text-text';
  }
}

export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return url;
    return undefined;
  } catch {
    return undefined;
  }
}
