// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../agent-onboarding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-onboarding')>()),
  AGENT_ONBOARDING_ENABLED: true,
}));

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  fetchAuthConfig: vi.fn().mockResolvedValue({
    provider: 'embedded',
    supports_password: true,
    supports_signup: true,
    supports_reset: true,
    social_providers: [],
  }),
  getGitHubAppStatus: vi.fn().mockResolvedValue({
    installed: false,
    installation_id: null,
    install_url: 'https://github.com/apps/opslane/installations/new',
  }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import Login from '../Login.vue';
import SetupWizard from '../SetupWizard.vue';

describe('agent card wiring (flag enabled)', () => {
  it('Login renders the divider and card after authentication loads', async () => {
    const wrapper = mount(Login);
    await flushPromises();

    expect(wrapper.findComponent({ name: 'AgentOnboardingCard' }).exists()).toBe(true);
    expect(wrapper.text()).toContain('Let your agent do it');
    expect(wrapper.findAll('span').some((span) => span.text() === 'or')).toBe(true);
  });

  it('SetupWizard Step 1 (not installed) renders the card', async () => {
    const wrapper = mount(SetupWizard);
    await flushPromises();

    expect(wrapper.text()).toContain('Connect GitHub');
    expect(wrapper.findComponent({ name: 'AgentOnboardingCard' }).exists()).toBe(true);
  });
});
