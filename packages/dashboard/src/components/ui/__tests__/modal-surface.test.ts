// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ModalSurface from '../ModalSurface.vue';

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('ModalSurface', () => {
  it('owns dialog semantics, initial focus, inertness, Escape, and restoration', async () => {
    document.body.innerHTML = '<button id="before">Open</button><div id="app"></div>';
    const trigger = document.querySelector<HTMLButtonElement>('#before')!;
    trigger.focus();
    const wrapper = mount(ModalSurface, {
      attachTo: document.querySelector('#app')!,
      props: { open: true, title: 'Confirm change', initialFocus: '[data-confirm]' },
      slots: { default: '<button data-confirm>Confirm</button><button>Cancel</button>' },
    });
    await nextTick();
    await nextTick();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Confirm change');
    expect(document.querySelector('#app')?.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement?.hasAttribute('data-confirm')).toBe(true);

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false]);
    await wrapper.setProps({ open: false });
    expect(document.querySelector('#app')?.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });

  it('renders the typed drawer surface full-height and right aligned', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    mount(ModalSurface, {
      attachTo: document.querySelector('#app')!,
      props: { open: true, title: 'Navigation', variant: 'drawer' },
    });
    await nextTick();
    expect(document.querySelector('[role="dialog"]')?.className).toContain('h-full');
    expect(document.querySelector('.justify-end')).not.toBeNull();
  });
});
