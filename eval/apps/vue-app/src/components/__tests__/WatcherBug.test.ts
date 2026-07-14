import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import WatcherBug from '../WatcherBug.vue';
import { nextTick } from 'vue';

describe('WatcherBug', () => {
  it('increments count', async () => {
    const wrapper = mount(WatcherBug);

    expect(wrapper.find('[data-testid="count"]').text()).toBe('0');

    await wrapper.find('[data-testid="increment"]').trigger('click');
    expect(wrapper.find('[data-testid="count"]').text()).toBe('1');
  });

  it('shows message when count exceeds limit', async () => {
    const wrapper = mount(WatcherBug);

    // Click increment 11 times to go past 10
    for (let i = 0; i < 11; i++) {
      await wrapper.find('[data-testid="increment"]').trigger('click');
    }

    await nextTick();

    expect(wrapper.find('[data-testid="count"]').text()).toBe('11');
    expect(wrapper.find('[data-testid="message"]').text()).toBe('Count exceeds limit');
  });

  it('handles deep watcher toggle without error', async () => {
    const wrapper = mount(WatcherBug);
    await wrapper.find('[data-testid="toggle-mode"]').trigger('click');
    await nextTick();
    // When value is null, should show 'NULL' (null-safe check)
    expect(wrapper.find('[data-testid="deep-watch-result"]').text()).toBe('NULL');
    expect(wrapper.find('[data-testid="deep-watch-error"]').exists()).toBe(false);
  });

  it('runs timer without crashing on stale ref', async () => {
    vi.useFakeTimers();
    const wrapper = mount(WatcherBug);
    await wrapper.find('[data-testid="start-timer"]').trigger('click');
    // Advance past 3 ticks (300ms+)
    await vi.advanceTimersByTimeAsync(400);
    expect(Number(wrapper.find('[data-testid="timer-ticks"]').text())).toBeGreaterThanOrEqual(3);
    expect(wrapper.find('[data-testid="timer-error"]').exists()).toBe(false);
    vi.useRealTimers();
  });
});
