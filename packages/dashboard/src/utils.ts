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
