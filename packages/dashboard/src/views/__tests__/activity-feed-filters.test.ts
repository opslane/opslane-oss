// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident } from '../../types/api';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listIncidents: vi.fn(),
  replace: vi.fn(),
  route: { query: {} as Record<string, string> },
}));

vi.mock('../../api', () => ({
  listAccounts: mocks.listAccounts,
  listIncidents: mocks.listIncidents,
}));

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
}));

import ActivityFeed from '../ActivityFeed.vue';

function incident(
  id: string,
  title: string,
  platform: string | null,
  kind: 'error' | 'friction' = 'error',
): Incident {
  return {
    id,
    project_id: 'p1',
    kind,
    platform,
    fingerprint: `fingerprint-${id}`,
    title,
    status: kind === 'friction' ? 'insight' : 'new',
    first_seen: '2026-07-19T00:00:00Z',
    last_seen: '2026-07-19T00:00:00Z',
    occurrence_count: 1,
    affected_users_count: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mountFeed() {
  return mount(ActivityFeed, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  });
}

describe('ActivityFeed URL filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccounts.mockResolvedValue([]);
    mocks.route.query = {};
    window.history.replaceState({}, '', '/');
  });

  it('uses URL-derived platform and end-user filters for the only initial request', async () => {
    mocks.route.query = {
      project_id: 'p1',
      platform: 'python',
      end_user_id: 'user-123',
    };
    window.history.replaceState(
      {},
      '',
      '/?project_id=p1&platform=python&end_user_id=user-123',
    );
    mocks.listIncidents.mockResolvedValue([
      incident('python', 'Python failure', 'python'),
    ]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(mocks.listIncidents).toHaveBeenCalledTimes(1);
    expect(mocks.listIncidents).toHaveBeenCalledWith('p1', {
      platform: 'python',
      end_user_id: 'user-123',
    });
    expect(wrapper.text()).toContain('Python failure');
    expect(wrapper.text()).toContain('Python');

    wrapper.unmount();
  });

  it('ignores a stale response after the platform filter changes', async () => {
    mocks.route.query = {
      project_id: 'p1',
      platform: 'python',
      end_user_id: 'user-123',
    };
    window.history.replaceState(
      {},
      '',
      '/?project_id=p1&platform=python&end_user_id=user-123',
    );
    const firstRequest = deferred<Incident[]>();
    mocks.listIncidents
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce([incident('javascript', 'JavaScript failure', 'javascript')]);

    const wrapper = mountFeed();
    await flushPromises();
    await wrapper.findAll('select')[2]!.setValue('javascript');
    await flushPromises();

    expect(wrapper.text()).toContain('JavaScript failure');
    expect(mocks.replace).toHaveBeenCalledWith({
      query: {
        project_id: 'p1',
        platform: 'javascript',
        end_user_id: 'user-123',
      },
    });

    firstRequest.resolve([incident('python', 'Stale Python failure', 'python')]);
    await flushPromises();

    expect(wrapper.text()).toContain('JavaScript failure');
    expect(wrapper.text()).not.toContain('Stale Python failure');

    wrapper.unmount();
  });

  it('shows friction only in the unfiltered feed and omits a platform badge for it', async () => {
    mocks.route.query = { project_id: 'p1' };
    window.history.replaceState({}, '', '/?project_id=p1');
    mocks.listIncidents.mockResolvedValue([
      incident('friction', 'Checkout friction', null, 'friction'),
      incident('python', 'Python failure', 'python'),
    ]);

    const wrapper = mountFeed();
    await flushPromises();

    expect(mocks.listIncidents).toHaveBeenCalledWith('p1', {});
    const rows = wrapper.findAll('tbody tr');
    const frictionRow = rows.find((row) => row.text().includes('Checkout friction'));
    const pythonRow = rows.find((row) => row.text().includes('Python failure'));
    expect(frictionRow?.text()).toContain('Friction');
    expect(frictionRow?.text()).not.toContain('Python');
    expect(frictionRow?.text()).not.toContain('JavaScript');
    expect(pythonRow?.text()).toContain('Python');

    wrapper.unmount();
  });
});
