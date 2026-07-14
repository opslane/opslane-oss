import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ItemList from '../ItemList.vue';
import type { Item } from '../../types';

describe('ItemList', () => {
  const sampleItems: Item[] = [
    { id: '1', label: 'Item One', active: true },
    { id: '2', label: 'Item Two', active: false },
  ];

  it('renders items with correct keys', () => {
    const wrapper = mount(ItemList, { props: { initialItems: sampleItems } });

    expect(wrapper.find('[data-testid="item-1"]').text()).toContain('Item One');
    expect(wrapper.find('[data-testid="item-1"]').text()).toContain('active');
    expect(wrapper.find('[data-testid="item-2"]').text()).toContain('Item Two');
    expect(wrapper.find('[data-testid="empty"]').exists()).toBe(false);
  });

  it('handles adding items reactively', async () => {
    const wrapper = mount(ItemList, { props: { initialItems: sampleItems } });

    const newItem: Item = { id: '3', label: 'Item Three', active: false };
    (wrapper.vm as unknown as { addItem: (item: Item) => void }).addItem(newItem);

    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="item-3"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="item-3"]').text()).toContain('Item Three');
    expect(wrapper.findAll('li')).toHaveLength(3);
  });
});
