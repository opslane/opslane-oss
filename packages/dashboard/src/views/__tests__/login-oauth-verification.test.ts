// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAuthConfig } = vi.hoisted(() => ({
  fetchAuthConfig: vi.fn(),
}));

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  fetchAuthConfig,
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import Login from '../Login.vue';

describe('Login OAuth verification challenge', () => {
  beforeEach(() => {
    fetchAuthConfig.mockReset();
    window.history.replaceState({}, '', '/login?challenge=email');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('opens code verification without running auth discovery', async () => {
    const wrapper = mount(Login);
    await flushPromises();

    expect(wrapper.get('h1').text()).toBe('Verify your email');
    expect(wrapper.text()).toContain('Enter the 6-digit code sent to your email address.');
    expect(fetchAuthConfig).not.toHaveBeenCalled();
  });
});
