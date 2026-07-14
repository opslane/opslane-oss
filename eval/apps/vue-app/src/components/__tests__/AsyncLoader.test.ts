import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AsyncLoader from '../AsyncLoader.vue';

describe('AsyncLoader', () => {
  it('renders loaded data', async () => {
    const loadFn = () => Promise.resolve('Hello World');
    const wrapper = mount(AsyncLoader, { props: { loadFn } });

    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true);

    await flushPromises();

    expect(wrapper.find('[data-testid="data"]').text()).toBe('Hello World');
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="error"]').exists()).toBe(false);
  });

  it('handles rejected promise gracefully', async () => {
    const loadFn = () => Promise.reject(new Error('Network failure'));
    const wrapper = mount(AsyncLoader, { props: { loadFn } });

    await flushPromises();

    expect(wrapper.find('[data-testid="error"]').text()).toBe('Error: Network failure');
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="data"]').exists()).toBe(false);
  });

  it('retries with Promise.any and succeeds', async () => {
    const loadFn = () => Promise.resolve('initial');
    const wrapper = mount(AsyncLoader, { props: { loadFn } });
    await flushPromises();

    await wrapper.find('[data-testid="retry-btn"]').trigger('click');
    // Wait for the Promise.any to resolve (50ms timeout + margin)
    await new Promise(r => setTimeout(r, 200));
    await flushPromises();

    expect(wrapper.find('[data-testid="retry-result"]').text()).toBe('strategy-1-ok');
    expect(wrapper.find('[data-testid="retry-error"]').exists()).toBe(false);
  });
});
