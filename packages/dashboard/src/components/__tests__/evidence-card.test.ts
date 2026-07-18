// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import EvidenceCard from '../EvidenceCard.vue';

describe('EvidenceCard', () => {
  it('renders the tier, checks, and pre-existing suite failures', () => {
    const wrapper = mount(EvidenceCard, {
      props: {
        evidence: {
          version: 1,
          tier: 'E1',
          checks: [
            { name: 'build', outcome: 'passed', command: '', output_tail: '' },
            { name: 'suite_post_patch', outcome: 'failed', command: '', output_tail: '' },
          ],
          suite: { baseline_failed_tests: ['a::t1'], new_failures: [] },
        },
      },
    });

    expect(wrapper.text()).toContain('E1');
    expect(wrapper.text()).toContain('build');
    expect(wrapper.text()).toContain('failed');
    expect(wrapper.text()).toContain('1 test(s) already failed before the patch');
  });

  it('renders repository-provided check names as text, never as HTML', () => {
    const wrapper = mount(EvidenceCard, {
      props: {
        evidence: {
          version: 1,
          tier: null,
          checks: [
            {
              name: '<img src=x onerror=alert(1)>',
              outcome: 'passed',
              command: '',
              output_tail: '',
            },
          ],
        },
      },
    });

    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('renders version 2 external CI evidence for the exact PR commit', () => {
    const wrapper = mount(EvidenceCard, {
      props: {
        evidence: {
          version: 2,
          tier: 'E0',
          checks: [],
          external_ci: {
            outcome: 'failed',
            pr_number: 42,
            head_sha: '0123456789abcdef',
            check_names: ['build', 'unit tests'],
            failing_checks: ['unit tests'],
            observed_at: '2026-07-17T12:00:00Z',
          },
        },
      },
    });

    expect(wrapper.text()).toContain('Repository CI failed');
    expect(wrapper.text()).toContain('unit tests');
    expect(wrapper.text()).toContain('Failing: unit tests');
    expect(wrapper.text()).toContain('PR #42 · commit 01234567');
  });
});
