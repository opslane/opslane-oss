import { describe, expect, it } from 'vitest';
import type { AdminJobStatus, ErrorGroupStatus, SessionStatus } from './types/api';
import { adminJobStatusRecipe, frictionSignalRecipe, incidentStatusRecipe, sessionStatusRecipe } from './status-recipes';

describe('typed status recipes', () => {
  it('covers every incident status without motion styling', () => {
    const statuses: ErrorGroupStatus[] = [
      'new', 'queued', 'analyzing', 'investigated', 'fixing', 'pr_draft', 'pr_created',
      'needs_human', 'resolved', 'merged', 'archived', 'candidate', 'awaiting_approval', 'insight',
    ];
    expect(statuses.map(incidentStatusRecipe).map((item) => item.label)).toEqual([
      'New', 'Queued', 'Analyzing', 'Investigated', 'Fixing', 'Draft PR', 'PR Created',
      'Needs human', 'Resolved', 'Merged', 'Archived', 'Candidate', 'Awaiting approval', 'Insight',
    ]);
    expect(statuses.every((status) => incidentStatusRecipe(status).class.length > 0)).toBe(true);
    expect(incidentStatusRecipe('fixing').class).not.toContain('animate');
  });

  it('covers every admin job status', () => {
    const statuses: AdminJobStatus[] = ['pending', 'claimed', 'completed', 'failed', 'dead_letter'];
    expect(statuses.map(adminJobStatusRecipe).map((item) => item.label)).toEqual([
      'Pending', 'Claimed', 'Completed', 'Failed', 'Dead letter',
    ]);
  });

  it('covers every session status', () => {
    const statuses: SessionStatus[] = ['recording', 'closed', 'analyzing', 'analyzed', 'analysis_failed', 'deleting'];
    expect(statuses.map(sessionStatusRecipe).map((item) => item.label)).toEqual([
      'Recording', 'Closed', 'Analyzing', 'Analyzed', 'Analysis failed', 'Deleting',
    ]);
  });

  it('maps session signals to truthful labels and tones', () => {
    expect(frictionSignalRecipe('error', 3)).toMatchObject({ label: '3 errors', tone: 'danger' });
    expect(frictionSignalRecipe('rage_click', 1)).toMatchObject({ label: '1 rage click', tone: 'warning' });
    expect(frictionSignalRecipe('dead_click', 2)).toMatchObject({ label: '2 dead clicks', tone: 'warning' });
    expect(frictionSignalRecipe('form_abandon', 1)).toMatchObject({ label: '1 form abandon', tone: 'neutral' });
    expect(frictionSignalRecipe('analysis_failed')).toMatchObject({ label: 'Analysis failed', tone: 'warning' });
  });

  it('falls back to a neutral badge instead of throwing on an unknown wire value', () => {
    // The server types status as a bare string (read_api.go, session_read.go) and
    // has grown the enum via ALTER TYPE four times. A value the union does not
    // know about must degrade, not crash the route.
    const forward = 'triaging' as ErrorGroupStatus;
    expect(() => incidentStatusRecipe(forward)).not.toThrow();
    expect(incidentStatusRecipe(forward)).toMatchObject({ label: 'Triaging', tone: 'neutral' });
    expect(incidentStatusRecipe(forward).class).toBe(incidentStatusRecipe('archived').class);

    expect(sessionStatusRecipe('paused' as SessionStatus).label).toBe('Paused');
    expect(adminJobStatusRecipe('retrying' as AdminJobStatus).tone).toBe('neutral');
    expect(incidentStatusRecipe('needs_more_input' as ErrorGroupStatus).label).toBe('Needs more input');
    expect(incidentStatusRecipe(undefined as unknown as ErrorGroupStatus).label).toBe('Unknown');
  });
});
