import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import UserCard from '../UserCard.vue';
import type { User } from '../../types';

describe('UserCard', () => {
  it('renders user name when profile exists', () => {
    const user: User = {
      id: '1',
      name: 'Alice',
      profile: { name: 'Alice Smith', email: 'alice@example.com' },
    };
    const wrapper = mount(UserCard, { props: { user } });
    expect(wrapper.find('h2').text()).toBe('Alice Smith');
    expect(wrapper.find('p').text()).toBe('alice@example.com');
  });

  it('handles null profile gracefully', () => {
    const user: User = {
      id: '2',
      name: 'Bob',
      profile: null,
    };
    const wrapper = mount(UserCard, { props: { user } });
    expect(wrapper.find('h2').text()).toBe('No profile');
    expect(wrapper.find('p').text()).toBe('');
  });

  it('exports user data without error', async () => {
    const user: User = {
      id: '1',
      name: 'Alice',
      profile: { name: 'Alice', email: 'alice@example.com' },
    };
    const wrapper = mount(UserCard, { props: { user } });
    await wrapper.find('[data-testid="export-btn"]').trigger('click');
    const result = wrapper.find('[data-testid="export-result"]');
    expect(result.exists()).toBe(true);
    const parsed = JSON.parse(result.text());
    expect(parsed.name).toBe('Alice');
    expect(parsed.email).toBe('alice@example.com');
    expect(wrapper.find('[data-testid="export-error"]').exists()).toBe(false);
  });
});
