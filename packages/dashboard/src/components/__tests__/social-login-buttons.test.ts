// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { LastAuthMethod } from '../../composables/useLastAuthMethod';
import { socialProviderButtons } from '../../composables/socialProviders';
import SocialLoginButtons from '../SocialLoginButtons.vue';
import GitHubIcon from '../icons/GitHubIcon.vue';
import GoogleIcon from '../icons/GoogleIcon.vue';

const buttons = socialProviderButtons(['github', 'google']);

function mountButtons(lastUsed?: LastAuthMethod | null) {
  return mount(SocialLoginButtons, {
    props: { buttons, dividerLabel: 'or continue with email', lastUsed },
  });
}

describe('SocialLoginButtons', () => {
  it('renders the matching brand icon inside each provider button', () => {
    const wrapper = mountButtons();
    const github = wrapper.get('a[href="/auth/login?provider=github"]');
    const google = wrapper.get('a[href="/auth/login?provider=google"]');

    expect(github.findComponent(GitHubIcon).exists()).toBe(true);
    expect(github.findComponent(GoogleIcon).exists()).toBe(false);
    expect(google.findComponent(GoogleIcon).exists()).toBe(true);
    expect(google.findComponent(GitHubIcon).exists()).toBe(false);
  });

  it('preserves the provider hrefs the e2e suite selects on', () => {
    const links = mountButtons().findAll('a[href^="/auth/login?provider="]');
    expect(links).toHaveLength(2);
    expect(links[0].attributes('href')).toBe('/auth/login?provider=github');
  });

  it('badges only the button matching lastUsed', () => {
    const wrapper = mountButtons('github');
    const badges = wrapper.findAll('[data-testid="last-used-badge"]');
    expect(badges).toHaveLength(1);
    expect(wrapper.findAll('a')[0].text()).toContain('Last used');
  });

  it('shows no badge when lastUsed is undefined', () => {
    expect(mountButtons().findAll('[data-testid="last-used-badge"]')).toHaveLength(0);
  });

  it('shows no badge when the last method was the email form', () => {
    expect(mountButtons('password').findAll('[data-testid="last-used-badge"]')).toHaveLength(0);
  });

  it('emits the provider id when a button is clicked', async () => {
    const wrapper = mountButtons();
    const googleLink = wrapper.findAll('a')[1];
    googleLink.element.addEventListener('click', (event) => event.preventDefault());
    await googleLink.trigger('click');
    expect(wrapper.emitted('select')).toEqual([['google']]);
  });

  it('renders nothing when no providers are configured', () => {
    const wrapper = mount(SocialLoginButtons, {
      props: { buttons: [], dividerLabel: 'or' },
    });
    // The divider shares the buttons' v-if, so assert the whole component is
    // empty — otherwise a dangling "or continue with email" rule slips through.
    expect(wrapper.text()).toBe('');
  });
});
