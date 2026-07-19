// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PipelineIndicator from '../PipelineIndicator.vue';

describe('PipelineIndicator', () => {
  it('shows a draft outcome without presenting it as a ready PR', () => {
    const wrapper = mount(PipelineIndicator, { props: { status: 'pr_draft' } });

    expect(wrapper.text()).toContain('Draft PR');
    expect(wrapper.text()).not.toContain('PR Created');
    expect(wrapper.html()).toContain('bg-amber');
  });
});
