import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import FetchUser from '../FetchUser.vue';

describe('FetchUser', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders user on successful fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '1', name: 'Alice', profile: null }),
    }));

    const wrapper = mount(FetchUser, { props: { userId: '1' } });

    await flushPromises();

    expect(wrapper.find('[data-testid="user"]').text()).toBe('Alice');
    expect(wrapper.find('[data-testid="error"]').exists()).toBe(false);
  });

  it('handles HTTP error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    const wrapper = mount(FetchUser, { props: { userId: '1' } });

    await flushPromises();

    expect(wrapper.find('[data-testid="error"]').text()).toBe('HTTP 500');
    expect(wrapper.find('[data-testid="user"]').exists()).toBe(false);
  });

  it('loads cached content without body-consumed error', async () => {
    const responseText = '{"id":"1","name":"Alice"}';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(responseText),
      clone: function() { return { text: () => Promise.resolve(responseText) }; },
      json: () => Promise.resolve({ id: '1', name: 'Alice', profile: null }),
    }));

    const wrapper = mount(FetchUser, { props: { userId: '1' } });
    await flushPromises();

    await wrapper.find('[data-testid="load-cached-btn"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="cached-content"]').text()).toBe(responseText);
    expect(wrapper.find('[data-testid="cached-error"]').exists()).toBe(false);
  });
});
