// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { buildAgentPrompt } from '../../agent-onboarding';
import AgentOnboardingCard from '../AgentOnboardingCard.vue';

describe('AgentOnboardingCard', () => {
  it('renders the prompt for the given origin with a copy button', () => {
    const wrapper = mount(AgentOnboardingCard, {
      props: { origin: 'http://localhost:8082' },
    });

    expect(wrapper.text()).toContain('Let your agent do it');
    expect(wrapper.text()).toContain('OPSLANE_API_URL=http://localhost:8082');
    expect(wrapper.text()).toContain('npx -y @opslane/cli setup --start');
    expect(wrapper.findComponent({ name: 'CopyButton' }).props('text')).toContain(
      'npx -y @opslane/cli',
    );
    expect(wrapper.text()).not.toMatch(/one click/i);
  });

  it('copies the exact prompt and allows it to wrap within narrow cards', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const origin = 'http://localhost:8082';
    const wrapper = mount(AgentOnboardingCard, { props: { origin } });

    await wrapper.get('button').trigger('click');

    expect(writeText).toHaveBeenCalledWith(buildAgentPrompt(origin));
    expect(wrapper.get('code').classes()).toEqual(
      expect.arrayContaining(['whitespace-pre-wrap', 'break-words']),
    );
  });
});
