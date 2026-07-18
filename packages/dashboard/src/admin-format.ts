export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '\u2014';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.round((seconds % 3_600) / 60)}m`;
}

// Keep the shared statuses aligned with statusBadgeClass in utils.ts so the
// same status never renders a different color on the admin page.
export function adminStatusBadgeClass(status: string): string {
  switch (status) {
    case 'completed':
    case 'insight':
    case 'resolved':
      return 'bg-green-500/10 text-green';
    case 'merged':
    case 'pr_created':
      return 'bg-emerald-500/10 text-green';
    case 'pr_draft':
      return 'bg-amber-500/10 text-amber';
    case 'claimed':
    case 'analyzing':
    case 'queued':
      return 'bg-indigo-500/10 text-indigo';
    case 'fixing':
      return 'bg-indigo-500/10 text-indigo animate-pulse';
    case 'awaiting_approval':
    case 'investigated':
      return 'bg-teal-500/10 text-teal';
    case 'pending':
    case 'needs_human':
      return 'bg-amber-500/10 text-amber';
    case 'failed':
    case 'dead_letter':
      return 'bg-red-500/10 text-red';
    default:
      return 'bg-surface-2 text-text-muted';
  }
}
