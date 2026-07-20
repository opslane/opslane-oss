// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createNotificationDestination: vi.fn(),
  deleteNotificationDestination: vi.fn(),
  listNotificationDestinations: vi.fn(),
  testNotificationDestination: vi.fn(),
  updateNotificationDestination: vi.fn(),
}));

vi.mock('../../api', () => api);

import IntegrationsSettings from '../../components/IntegrationsSettings.vue';

const destination = (id: string, name: string) => ({
  id,
  type: 'slack' as const,
  name,
  config_fingerprint: 'hooks.slack.com/…/****part',
  event_types: ['issue.created'],
  enabled: true,
  created_at: '2026-07-19T00:00:00Z',
  last_delivery: null,
  recent_failures: 0,
});

describe('IntegrationsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listNotificationDestinations.mockResolvedValue({
      can_manage: true,
      destinations: [],
    });
  });

  it('refetches destinations when the project changes', async () => {
    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await flushPromises();

    expect(api.listNotificationDestinations).toHaveBeenCalledWith('project-a');

    await wrapper.setProps({ projectId: 'project-b' });
    await flushPromises();

    expect(api.listNotificationDestinations).toHaveBeenLastCalledWith('project-b');
    expect(api.listNotificationDestinations).toHaveBeenCalledTimes(2);
  });

  it('does not let a slower response from the previous project replace current data', async () => {
    let resolveA!: (value: object) => void;
    let resolveB!: (value: object) => void;
    api.listNotificationDestinations.mockImplementation((projectId: string) => (
      new Promise((resolve) => {
        if (projectId === 'project-a') resolveA = resolve;
        if (projectId === 'project-b') resolveB = resolve;
      })
    ));

    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await wrapper.setProps({ projectId: 'project-b' });
    resolveB({ can_manage: true, destinations: [destination('b', 'Project B alerts')] });
    await flushPromises();

    expect(wrapper.text()).toContain('Project B alerts');

    resolveA({ can_manage: true, destinations: [destination('a', 'Project A alerts')] });
    await flushPromises();

    expect(wrapper.text()).toContain('Project B alerts');
    expect(wrapper.text()).not.toContain('Project A alerts');
  });

  it('renders no mutation controls when the server denies management', async () => {
    api.listNotificationDestinations.mockResolvedValue({
      can_manage: false,
      destinations: [destination('readonly', 'Read-only alerts')],
    });

    const wrapper = mount(IntegrationsSettings, { props: { projectId: 'project-a' } });
    await flushPromises();

    expect(wrapper.text()).toContain('Read-only alerts');
    expect(wrapper.find('[data-testid="add-slack-form"]').exists()).toBe(false);
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('Test');
    expect(wrapper.text()).not.toContain('Delete');
  });
});
