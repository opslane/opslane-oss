// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api', () => ({
  fetchAuthConfig: vi.fn(),
  passwordLogin: vi.fn().mockResolvedValue({
    status: 'error',
    code: 401,
    message: 'Invalid credentials',
  }),
  signup: vi.fn().mockResolvedValue({
    status: 'error',
    code: 400,
    message: 'Unable to sign up',
  }),
  verifyEmail: vi.fn(),
  forgotPassword: vi.fn(),
}));
vi.mock('../../post-auth', () => ({ completePostAuth: vi.fn() }));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { fetchAuthConfig } from '../../api';
import type { AuthConfig } from '../../types/api';
import GitHubIcon from '../../components/icons/GitHubIcon.vue';
import Login from '../Login.vue';

const passwordConfig: AuthConfig = {
  provider: 'embedded',
  supports_password: true,
  supports_signup: true,
  supports_reset: true,
  social_providers: ['github', 'google'],
};

const redirectConfig: AuthConfig = {
  provider: 'workos',
  supports_password: false,
  supports_signup: false,
  supports_reset: false,
  social_providers: [],
};

async function mountLogin(config: AuthConfig = passwordConfig) {
  vi.mocked(fetchAuthConfig).mockResolvedValueOnce(config);
  const wrapper = mount(Login);
  await vi.waitFor(() => {
    const selector = config.supports_password
      ? '#auth-password'
      : '[data-testid="idp-redirect-button"]';
    expect(wrapper.find(selector).exists()).toBe(true);
  });
  return wrapper;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(fetchAuthConfig).mockReset();
});

describe('Login redesign', () => {
  it('starts with the password masked', async () => {
    const wrapper = await mountLogin();
    expect(wrapper.get('#auth-password').attributes('type')).toBe('password');
  });

  it('reveals and re-masks the password accessibly', async () => {
    const wrapper = await mountLogin();
    const toggle = wrapper.get('[data-testid="password-toggle"]');

    // Static label + toggling aria-pressed: the label names the control, the
    // state names the state. A label that also flips announces a contradiction.
    expect(toggle.attributes('aria-label')).toBe('Show password');

    await toggle.trigger('click');
    expect(wrapper.get('#auth-password').attributes('type')).toBe('text');
    expect(toggle.attributes('aria-pressed')).toBe('true');

    await toggle.trigger('click');
    expect(wrapper.get('#auth-password').attributes('type')).toBe('password');
    expect(toggle.attributes('aria-pressed')).toBe('false');
  });

  it('discards the password when the mode changes, so it cannot be revealed later', async () => {
    const wrapper = await mountLogin();
    await wrapper.get('#auth-password').setValue('hunter2');

    await wrapper.get('[role="tab"][aria-selected="false"]').trigger('click');

    expect((wrapper.get('#auth-password').element as HTMLInputElement).value).toBe('');
  });

  it('re-masks when switching from sign in to sign up', async () => {
    const wrapper = await mountLogin();
    await wrapper.get('[data-testid="password-toggle"]').trigger('click');
    expect(wrapper.get('#auth-password').attributes('type')).toBe('text');

    await wrapper.get('[role="tab"][aria-selected="false"]').trigger('click');
    expect(wrapper.get('#auth-password').attributes('type')).toBe('password');
  });

  it('leaves room for the toggle so the value cannot sit underneath it', async () => {
    const wrapper = await mountLogin();
    expect(wrapper.get('#auth-password').classes()).toContain('pr-10');
  });

  it('uses a neutral lock on the generic hosted-IdP button', async () => {
    const wrapper = await mountLogin(redirectConfig);
    const idpButton = wrapper.get('[data-testid="idp-redirect-button"]');
    const lock = idpButton.get('[data-testid="idp-lock-icon"]');

    expect(lock.attributes('viewBox')).toBe('0 0 24 24');
    expect(lock.attributes('fill')).toBe('none');
    expect(idpButton.findComponent(GitHubIcon).exists()).toBe(false);
  });

  it('shows the last-used badge on the generic redirect method', async () => {
    window.localStorage.setItem('opslane.last_auth_method', 'redirect');
    const wrapper = await mountLogin(redirectConfig);
    expect(wrapper.get('[data-testid="idp-redirect-button"]').text()).toContain('Last used');
  });

  it('records a social method when its provider is selected', async () => {
    const wrapper = await mountLogin();
    const githubLink = wrapper.get('a[href="/auth/login?provider=github"]');
    githubLink.element.addEventListener('click', (event) => event.preventDefault());

    await githubLink.trigger('click');

    expect(window.localStorage.getItem('opslane.last_auth_method')).toBe('github');
    expect(githubLink.text()).toContain('Last used');
  });

  it('clears the social badge as soon as the email form is submitted', async () => {
    window.localStorage.setItem('opslane.last_auth_method', 'github');
    const wrapper = await mountLogin();
    expect(wrapper.findAll('[data-testid="last-used-badge"]')).toHaveLength(1);

    await wrapper.get('form').trigger('submit');

    expect(wrapper.findAll('[data-testid="last-used-badge"]')).toHaveLength(0);
    expect(window.localStorage.getItem('opslane.last_auth_method')).toBe('password');
  });
});
