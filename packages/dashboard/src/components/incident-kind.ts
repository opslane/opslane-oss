import type { ErrorGroupStatus } from '../types/api';

export interface KindBadge {
  label: string;
  class: string;
}

/**
 * Incident kind badge (Batch 4, issue #56). Text carries the meaning —
 * color is reinforcement, never the only signal. 'Unchecked' flags an
 * exhausted friction adjudication surfaced as a non-fixable diagnostic.
 */
export function kindBadge(
  kind: 'error' | 'friction',
  adjudicationStatus: string | undefined,
): KindBadge {
  if (kind === 'friction' && adjudicationStatus === 'unchecked') {
    return { label: 'Unchecked', class: 'bg-amber-100 text-amber-800' };
  }
  if (kind === 'friction') {
    return { label: 'Friction', class: 'bg-purple-100 text-purple-800' };
  }
  return { label: 'Error', class: 'bg-surface-2 text-text' };
}

/**
 * Whether the incident detail may render a fix trigger. Errors keep the
 * existing investigated-only flow; friction is manual-approval only
 * (awaiting_approval) — insight, candidates, and unchecked diagnostics
 * never expose fix controls (Batch 5 owns lifting this).
 */
export function fixControlsVisible(
  kind: 'error' | 'friction',
  status: ErrorGroupStatus,
): boolean {
  if (kind === 'friction') return status === 'awaiting_approval';
  return status === 'investigated';
}
