import type { AdminJobStatus, AdminOverview, ErrorGroupStatus } from './types/api';
import { adminJobStatusRecipe, incidentStatusRecipe } from './status-recipes';

type AdminOnboardingOverview = NonNullable<AdminOverview['onboarding']>;
type OnboardingStageKey =
  | 'started'
  | 'auth_clicked'
  | 'completed'
  | 'key_claimed'
  | 'first_event_received';

export interface OnboardingFunnelStage {
  key: OnboardingStageKey;
  label: string;
  value: number;
  pctOfFirst: number;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '\u2014';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.round((seconds % 3_600) / 60)}m`;
}

export function onboardingFunnelStages(onboarding: AdminOnboardingOverview): OnboardingFunnelStage[] {
  const stages: Array<{ key: OnboardingStageKey; label: string }> = [
    { key: 'started', label: 'Started' },
    { key: 'auth_clicked', label: 'Auth clicked' },
    { key: 'completed', label: 'Completed' },
    { key: 'key_claimed', label: 'Key claimed' },
    { key: 'first_event_received', label: 'Project activated' },
  ];

  return stages.map(({ key, label }) => ({
    key,
    label,
    value: onboarding[key],
    pctOfFirst: onboarding.started === 0
      ? 0
      : Math.round((onboarding[key] / onboarding.started) * 100),
  }));
}

// Keep the shared statuses aligned with statusBadgeClass in utils.ts so the
// same status never renders a different color on the admin page.
export type AdminDisplayedStatus = AdminJobStatus | ErrorGroupStatus;

const ADMIN_JOB_STATUSES: readonly AdminJobStatus[] = ['pending', 'claimed', 'completed', 'failed', 'dead_letter'];
const INCIDENT_STATUSES: readonly ErrorGroupStatus[] = [
  'new', 'queued', 'analyzing', 'investigated', 'fixing', 'pr_draft', 'pr_created',
  'needs_human', 'resolved', 'merged', 'archived', 'candidate', 'awaiting_approval', 'insight',
];

function isAdminJobStatus(status: string): status is AdminJobStatus {
  return ADMIN_JOB_STATUSES.some((candidate) => candidate === status);
}

function isIncidentStatus(status: string): status is ErrorGroupStatus {
  return INCIDENT_STATUSES.some((candidate) => candidate === status);
}

export function adminStatusBadgeClass(status: string): string {
  if (isAdminJobStatus(status)) return adminJobStatusRecipe(status).class;
  if (isIncidentStatus(status)) return incidentStatusRecipe(status).class;
  return 'border-border-strong bg-surface-subtle text-muted';
}
