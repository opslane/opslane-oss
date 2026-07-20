// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import IncidentLifecycle from './IncidentLifecycle.vue';

describe('IncidentLifecycle', () => {
  it('renders a human-readable status and a non-color signal', () => {
    const wrapper = mount(IncidentLifecycle, { props: { status: 'pr_created' } });

    expect(wrapper.text()).toContain('PR Created');
    expect(wrapper.text()).toContain('✓');
    expect(wrapper.text()).toContain('A pull request is ready for review.');
  });

  /**
   * Restores the guard from the deleted pipeline-indicator.test.ts: an
   * unverified draft must never be presented as a PR ready for review.
   */
  it('never presents a draft PR as a ready one', () => {
    const wrapper = mount(IncidentLifecycle, { props: { status: 'pr_draft' } });

    expect(wrapper.text()).toContain('Draft PR');
    expect(wrapper.text()).toContain('A draft pull request is available.');
    expect(wrapper.text()).not.toContain('PR Created');
    expect(wrapper.text()).not.toContain('ready for review');
  });

  it.each([
    ['new', 'New', 'Ready for investigation.'],
    ['queued', 'Queued', 'Queued for investigation.'],
    ['analyzing', 'Analyzing', 'Investigation is in progress.'],
    ['investigated', 'Investigated', 'Investigation is complete.'],
    ['awaiting_approval', 'Awaiting approval', 'A proposed fix is waiting for approval.'],
    ['fixing', 'Fixing', 'A fix is being prepared.'],
    ['needs_human', 'Needs human', 'Human action is required.'],
    ['insight', 'Insight', 'Investigation produced a product insight.'],
    ['resolved', 'Resolved', 'The incident is resolved.'],
    ['merged', 'Merged', 'The fix has been merged.'],
    ['archived', 'Archived', 'The incident is archived.'],
    ['candidate', 'Candidate', 'Awaiting classification.'],
  ] as const)('summarises %s', (status, label, summary) => {
    const wrapper = mount(IncidentLifecycle, { props: { status } });
    expect(wrapper.text()).toContain(label);
    expect(wrapper.text()).toContain(summary);
  });

  it('falls back to the status label rather than blank text for an unknown status', () => {
    const wrapper = mount(IncidentLifecycle, { props: { status: 'triaging' as 'new' } });
    expect(wrapper.text()).toContain('Triaging');
  });
});
