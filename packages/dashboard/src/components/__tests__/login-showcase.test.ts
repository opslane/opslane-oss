// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import LoginShowcase from '../LoginShowcase.vue';

describe('LoginShowcase', () => {
  it('states the outcome promise from the README', () => {
    expect(mount(LoginShowcase).text()).toContain('Every production error gets an answer');
  });

  it('describes all four documented terminal states', () => {
    const text = mount(LoginShowcase).text();
    expect(text).toContain('fix PR');
    expect(text).toContain('draft');
    expect(text).toContain('analysis');
    expect(text).toContain('incident');
  });

  it('keeps the hedges that stop it overpromising', () => {
    const text = mount(LoginShowcase).text();
    // Positive assertions: weakening either qualifier must fail the test.
    expect(text).toContain('backed by executed verification evidence');
    expect(text).toContain('not yet verified');
  });

  it('contains nothing focusable, so it cannot disrupt tab order', () => {
    const wrapper = mount(LoginShowcase);
    expect(wrapper.findAll('a, button, input, [tabindex]')).toHaveLength(0);
  });
});
