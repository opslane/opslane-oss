// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import SessionsList from './SessionsList.vue';
import { listEnvironments, listSessions } from '../api';
import type { SessionListResponse, SessionSummary } from '../types/api';

vi.mock('../api', () => ({
  listEnvironments: vi.fn(),
  listSessions: vi.fn(),
}));

function session(pageUrl: string): SessionSummary {
  return {
    id: `session-${pageUrl.replace(/[^a-z]/g, '').slice(-24)}`,
    started_at: '2026-07-19T00:00:00Z',
    status: 'recording',
    chunk_count: 1,
    playable_chunk_count: 1,
    bytes_stored: 100,
    page_url: pageUrl,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SessionsList environment pagination', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('opslane_project_id', 'project-1');
    localStorage.setItem('opslane_environment_id', 'env-production');
    vi.mocked(listEnvironments).mockResolvedValue({
      environments: [
        { id: 'env-production', project_id: 'project-1', name: 'production', created_at: '' },
        { id: 'env-staging', project_id: 'project-1', name: 'staging', created_at: '' },
      ],
      rollup_ready: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('drops an in-flight old cursor page when the environment changes', async () => {
    const initialUnfiltered = deferred<SessionListResponse>();
    const oldPage = deferred<SessionListResponse>();
    vi.mocked(listSessions).mockImplementation(async (_projectId, filters, cursor) => {
      if (cursor === 'cursor-production') return oldPage.promise;
      if (filters?.environment_id === 'env-production') {
        return { sessions: [session('https://production.example.test')], next_cursor: 'cursor-production' };
      }
      if (filters?.environment_id === 'env-staging') {
        return { sessions: [session('https://staging.example.test')], next_cursor: null };
      }
      return initialUnfiltered.promise;
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/sessions', component: SessionsList },
        { path: '/sessions/:sessionId', name: 'session-detail', component: { template: '<div />' } },
      ],
    });
    await router.push('/sessions');
    await router.isReady();
    const wrapper = mount(SessionsList, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain('https://production.example.test');
    const loadMore = wrapper.findAll('button').find((button) => button.text().includes('Load more'));
    expect(loadMore).toBeDefined();
    await loadMore!.trigger('click');
    const environmentSelect = wrapper.get('select');
    await environmentSelect.setValue('env-staging');
    await environmentSelect.trigger('change');
    await flushPromises();

    expect(wrapper.text()).toContain('https://staging.example.test');
    expect(wrapper.text()).not.toContain('https://production.example.test');
    expect(vi.mocked(listSessions)).toHaveBeenLastCalledWith(
      'project-1',
      expect.objectContaining({ environment_id: 'env-staging' }),
      undefined,
    );

    oldPage.resolve({ sessions: [session('https://stale-page.example.test')], next_cursor: null });
    initialUnfiltered.resolve({ sessions: [session('https://stale-initial.example.test')], next_cursor: null });
    await flushPromises();

    expect(wrapper.text()).toContain('https://staging.example.test');
    expect(wrapper.text()).not.toContain('https://stale-page.example.test');
    expect(wrapper.text()).not.toContain('https://stale-initial.example.test');
    wrapper.unmount();
  });
});
