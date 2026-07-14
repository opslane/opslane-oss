import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import App from '../../App.vue';

describe('App', () => {
  it('runs diagnostics without stack overflow', async () => {
    const wrapper = mount(App);
    await wrapper.find('[data-testid="run-diagnostics-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="diagnostics-result"]').text()).toBe('Diagnostics passed');
    expect(wrapper.find('[data-testid="diagnostics-error"]').exists()).toBe(false);
  });

  it('parses config without error', async () => {
    const wrapper = mount(App);
    await wrapper.find('[data-testid="parse-config-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="config-result"]').text()).toBe('Config loaded: dark_mode');
    expect(wrapper.find('[data-testid="config-error"]').exists()).toBe(false);
  });
});
