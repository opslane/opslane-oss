import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchFilter from '../SearchFilter.vue';
import type { Item } from '../../types';

describe('SearchFilter', () => {
  const items: Item[] = [
    { id: '1', label: 'Apple', active: true },
    { id: '2', label: 'Banana', active: false },
    { id: '3', label: 'Avocado', active: true },
  ];

  it('renders all items when search is empty', () => {
    const wrapper = mount(SearchFilter, { props: { items } });

    expect(wrapper.find('[data-testid="filtered-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="filtered-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="filtered-3"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="no-results"]').exists()).toBe(false);
  });

  it('filters items correctly', async () => {
    const wrapper = mount(SearchFilter, { props: { items } });

    await wrapper.find('[data-testid="search-input"]').setValue('ban');

    expect(wrapper.find('[data-testid="filtered-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="filtered-2"]').text()).toBe('Banana');
    expect(wrapper.find('[data-testid="filtered-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="filtered-3"]').exists()).toBe(false);
  });
});
