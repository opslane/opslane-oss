// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateProject } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project settings API', () => {
  it('sends the draft posture as a partial project PATCH', async () => {
    const project = {
      id: 'project-1',
      name: 'Example',
      github_repo: 'acme/example',
      friction_autonomy: 'ask_first' as const,
      pr_posture: 'draft_when_unverified' as const,
      created_at: '2026-07-17T00:00:00Z',
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => project,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateProject('project-1', {
      pr_posture: 'draft_when_unverified',
    })).resolves.toEqual(project);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects/project-1', expect.objectContaining({
      method: 'PATCH',
      credentials: 'include',
      body: JSON.stringify({ pr_posture: 'draft_when_unverified' }),
    }));
  });
});
