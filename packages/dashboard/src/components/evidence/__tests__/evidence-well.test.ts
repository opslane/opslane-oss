// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import EvidenceWell from '../EvidenceWell.vue';
import type { EvidenceRecord } from '../../../types/api';

const evidence: EvidenceRecord = {
  version: 2,
  tier: 'E2',
  checks: [{ name: 'Unit tests', outcome: 'passed', command: 'pnpm test', output_tail: '12 passed' }],
};

describe('EvidenceWell', () => {
  it('renders evidence as selectable text in the dark evidence surface', () => {
    const wrapper = mount(EvidenceWell, { props: { evidence } });
    expect(wrapper.classes()).toContain('bg-evidence-surface');
    expect(wrapper.text()).toContain('Unit tests');
    expect(wrapper.text()).toContain('Passed');
    expect(wrapper.get('code').text()).toBe('pnpm test');
    expect(wrapper.get('pre').classes()).toContain('select-text');
  });

  // Restores coverage lost with components/__tests__/evidence-card.test.ts.
  it('reports pre-existing failures excluded from the gate', () => {
    const wrapper = mount(EvidenceWell, {
      props: {
        evidence: {
          ...evidence,
          suite: { baseline_failed_tests: ['suite::a'], new_failures: [] },
        } as EvidenceRecord,
      },
    });
    expect(wrapper.text()).toContain('1 pre-existing test failure(s) excluded from this gate.');
  });

  it('omits the baseline-failure line when there are none', () => {
    const wrapper = mount(EvidenceWell, {
      props: {
        evidence: { ...evidence, suite: { baseline_failed_tests: [], new_failures: [] } } as EvidenceRecord,
      },
    });
    expect(wrapper.text()).not.toContain('pre-existing test failure');
  });

  it.each([
    ['failed', 'Failed'],
    ['skipped_no_runner', 'Skipped — no runner'],
    ['infra_error', 'Infrastructure error'],
  ] as const)('labels the %s check outcome', (outcome, label) => {
    const wrapper = mount(EvidenceWell, {
      props: {
        evidence: { ...evidence, checks: [{ name: 'Unit tests', outcome }] } as EvidenceRecord,
      },
    });
    expect(wrapper.text()).toContain(label);
  });

  it('degrades instead of rendering a blank label for an unknown outcome', () => {
    const wrapper = mount(EvidenceWell, {
      props: {
        evidence: {
          ...evidence,
          checks: [{ name: 'Unit tests', outcome: 'timed_out' as 'passed' }],
        } as EvidenceRecord,
      },
    });
    expect(wrapper.text()).toContain('Unknown outcome');
  });

  it('renders the provenance footer only when external CI is present', () => {
    expect(mount(EvidenceWell, { props: { evidence } }).text()).not.toContain('Repository CI');
    const withCi = mount(EvidenceWell, {
      props: {
        evidence: {
          ...evidence,
          external_ci: {
            outcome: 'failed',
            pr_number: 42,
            head_sha: '0123456789abcdef',
            check_names: ['unit tests'],
            failing_checks: ['unit tests'],
          },
        } as EvidenceRecord,
      },
    });
    expect(withCi.text()).toContain('Repository CI failed');
    expect(withCi.text()).toContain('PR #42');
  });
});
