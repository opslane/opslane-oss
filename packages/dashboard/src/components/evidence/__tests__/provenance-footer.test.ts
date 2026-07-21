// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ProvenanceFooter from '../ProvenanceFooter.vue';
import type { EvidenceRecord } from '../../../types/api';

type ExternalCi = NonNullable<EvidenceRecord['external_ci']>;

function externalCi(overrides: Partial<ExternalCi> = {}): ExternalCi {
  return {
    outcome: 'passed',
    pr_number: 42,
    head_sha: '0123456789abcdef0123456789abcdef01234567',
    check_names: ['unit tests'],
    ...overrides,
  } as ExternalCi;
}

/**
 * Restores coverage lost when components/__tests__/evidence-card.test.ts was
 * deleted: that suite asserted the version-2 external-CI block, which now lives
 * in this component.
 */
describe('ProvenanceFooter', () => {
  it.each([
    ['passed', 'Repository CI passed'],
    ['failed', 'Repository CI failed'],
    ['no_ci_observed', 'No repository CI observed'],
    ['head_moved', 'Draft branch changed'],
    ['permission_denied', 'Checks permission required'],
  ] as const)('labels the %s outcome', (outcome, label) => {
    const wrapper = mount(ProvenanceFooter, { props: { externalCi: externalCi({ outcome }) } });
    expect(wrapper.text()).toContain(label);
  });

  it('degrades instead of rendering a blank heading for an unknown outcome', () => {
    const wrapper = mount(ProvenanceFooter, {
      props: { externalCi: externalCi({ outcome: 'cancelled' as ExternalCi['outcome'] }) },
    });
    expect(wrapper.get('strong').text()).toBe('Repository CI status unknown');
  });

  it('truncates the head SHA to 8 characters and shows the PR number', () => {
    const wrapper = mount(ProvenanceFooter, { props: { externalCi: externalCi() } });
    expect(wrapper.text()).toContain('PR #42');
    expect(wrapper.text()).toContain('01234567');
    expect(wrapper.text()).not.toContain('0123456789abcdef');
  });

  it('lists check names and, separately, failing checks', () => {
    const wrapper = mount(ProvenanceFooter, {
      props: {
        externalCi: externalCi({
          outcome: 'failed',
          check_names: ['unit tests', 'lint'],
          failing_checks: ['unit tests'],
        }),
      },
    });
    expect(wrapper.text()).toContain('Checks: unit tests, lint');
    expect(wrapper.text()).toContain('Failing: unit tests');
  });

  it('omits the failing line when nothing failed', () => {
    const wrapper = mount(ProvenanceFooter, {
      props: { externalCi: externalCi({ failing_checks: [] }) },
    });
    expect(wrapper.text()).not.toContain('Failing:');
  });
});
