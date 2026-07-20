// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Button from '../Button.vue';
import StatusLabel from '../StatusLabel.vue';
import TextInput from '../TextInput.vue';
import TabList from '../TabList.vue';
import SelectField from '../SelectField.vue';
import SkeletonBlock from '../SkeletonBlock.vue';

describe('owned UI primitives', () => {
  it('prevents interaction and exposes busy state on buttons', async () => {
    const wrapper = mount(Button, { props: { busy: true }, slots: { default: 'Save' } });
    const button = wrapper.get('button');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('aria-busy')).toBe('true');
    await button.trigger('click');
    expect(wrapper.emitted('click')).toBeUndefined();
  });

  it('uses text and a non-color signal for statuses', () => {
    const wrapper = mount(StatusLabel, { props: { tone: 'success', label: 'Resolved' } });
    expect(wrapper.text()).toContain('✓');
    expect(wrapper.text()).toContain('Resolved');
    expect(wrapper.classes()).toContain('text-success');
  });

  it('associates field labels, errors, and model updates', async () => {
    const wrapper = mount(TextInput, { props: { label: 'Repository', error: 'Required' } });
    const input = wrapper.get('input');
    expect(wrapper.get('label').attributes('for')).toBe(input.attributes('id'));
    expect(input.attributes('aria-invalid')).toBe('true');
    await input.setValue('opslane/app');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['opslane/app']);
  });

  it('exposes tabs with selection semantics', async () => {
    const wrapper = mount(TabList, {
      props: {
        label: 'Incident sections', modelValue: 'summary',
        tabs: [{ id: 'summary', label: 'Summary' }, { id: 'evidence', label: 'Evidence' }],
      },
    });
    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('Incident sections');
    expect(wrapper.get('[aria-selected="true"]').text()).toBe('Summary');
    await wrapper.findAll('[role="tab"]')[1]?.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['evidence']);
  });
});

describe('field primitive attribute routing', () => {
  it('sends non-class attrs to the control, not the wrapping label', () => {
    const wrapper = mount(TextInput, {
      props: { label: 'Name', modelValue: '' },
      attrs: { name: 'new-project-name', maxlength: '100' },
    });
    const input = wrapper.get('input');
    expect(input.attributes('name')).toBe('new-project-name');
    expect(input.attributes('maxlength')).toBe('100');
    // the label must not absorb them
    expect(wrapper.get('label').attributes('name')).toBeUndefined();
  });

  it('keeps class on the wrapper so callers can lay the field out', () => {
    const wrapper = mount(TextInput, {
      props: { label: 'Name', modelValue: '' },
      attrs: { class: 'col-span-2' },
    });
    expect(wrapper.get('label').classes()).toContain('col-span-2');
    expect(wrapper.get('input').classes()).not.toContain('col-span-2');
  });

  it('hides the label visually but keeps it for assistive tech', () => {
    const wrapper = mount(TextInput, {
      props: { label: 'Search', modelValue: '', labelHidden: true },
    });
    const span = wrapper.get('label > span');
    expect(span.classes()).toContain('sr-only');
    expect(span.text()).toBe('Search');
    expect(wrapper.get('input').attributes('id')).toBe(wrapper.get('label').attributes('for'));
  });

  it('routes SelectField attrs the same way', () => {
    const wrapper = mount(SelectField, {
      props: { label: 'Status', modelValue: '', options: [{ value: 'a', label: 'A' }] },
      attrs: { name: 'status', class: 'w-40' },
    });
    expect(wrapper.get('select').attributes('name')).toBe('status');
    expect(wrapper.get('label').classes()).toContain('w-40');
  });
});

describe('SkeletonBlock announcement', () => {
  it('is decorative so a stack of them does not announce repeatedly', () => {
    // Previously each skeleton was its own role="status", so three stacked
    // placeholders announced "Loading" three times. The loading *region* owns
    // the announcement now; the bars are hidden from assistive tech.
    const wrapper = mount(SkeletonBlock, { props: { class: 'h-14' } });
    expect(wrapper.attributes('aria-hidden')).toBe('true');
    expect(wrapper.attributes('role')).toBeUndefined();
    expect(wrapper.text()).toBe('');
    expect(wrapper.classes()).toContain('h-14');
  });
});
