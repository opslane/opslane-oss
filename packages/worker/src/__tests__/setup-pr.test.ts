import { describe, it, expect, vi } from 'vitest';
import { runSetupPr } from '../setup-pr.js';

const deps = () => ({
  getProject: vi.fn().mockResolvedValue({ github_repo: 'o/r', default_branch: 'main' }),
  getInstallToken: vi.fn().mockResolvedValue('tok'),
  findExistingPr: vi.fn().mockResolvedValue(null),
  clone: vi.fn().mockResolvedValue({ repoDir: '/tmp/r', cleanup: vi.fn().mockResolvedValue(undefined) }),
  runAgentSetup: vi.fn().mockResolvedValue({ status: 'setup_ready', diff: 'D', confidence: 'high', affectedFiles: ['package.json'] }),
  commitAndPush: vi.fn().mockResolvedValue(undefined),
  createPr: vi.fn().mockResolvedValue({ url: 'https://gh/pr/1', number: 1 }),
  assertLeaseOwned: vi.fn().mockResolvedValue(undefined),
  record: vi.fn().mockResolvedValue(undefined),
});

describe('runSetupPr', () => {
  it('opens a PR and records open', async () => {
    const d = deps();
    const r = await runSetupPr({
      jobId: 'j',
      projectId: 'p',
      apiKeyEnvVar: 'VITE_OPSLANE_API_KEY',
      releaseEnvVar: 'VITE_OPSLANE_RELEASE',
    }, d);

    expect(r.status).toBe('open');
    expect(d.createPr).toHaveBeenCalledOnce();
    expect(d.record).toHaveBeenCalledWith('p', 'open', { pr_url: 'https://gh/pr/1', pr_number: 1 });
  });

  it('reuses an existing open PR', async () => {
    const d = deps();
    d.findExistingPr.mockResolvedValue({ url: 'https://gh/pr/9', number: 9 });

    const r = await runSetupPr({ jobId: 'j', projectId: 'p', apiKeyEnvVar: 'X', releaseEnvVar: 'Y' }, d);

    expect(r.status).toBe('open');
    expect(d.clone).not.toHaveBeenCalled();
    expect(d.createPr).not.toHaveBeenCalled();
  });

  it('records failed when the agent needs a human', async () => {
    const d = deps();
    d.runAgentSetup.mockResolvedValue({
      status: 'needs_human',
      reason: { reason_code: 'tests_failed', reason_message: 'no build', remediation: 'manual' },
    });

    const r = await runSetupPr({ jobId: 'j', projectId: 'p', apiKeyEnvVar: 'X', releaseEnvVar: 'Y' }, d);

    expect(r.status).toBe('failed');
    expect(d.record).toHaveBeenCalledWith('p', 'failed', expect.objectContaining({ error: expect.any(String) }));
  });

  it('records failed when no install token', async () => {
    const d = deps();
    d.getInstallToken.mockResolvedValue(undefined);

    const r = await runSetupPr({ jobId: 'j', projectId: 'p', apiKeyEnvVar: 'X', releaseEnvVar: 'Y' }, d);

    expect(r.status).toBe('failed');
    expect(d.record).toHaveBeenCalledWith('p', 'failed', expect.objectContaining({ error: expect.any(String) }));
  });

  it('does not push when the lease is lost immediately before delivery', async () => {
    const d = deps();
    d.assertLeaseOwned
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Job lease lost'));

    const r = await runSetupPr(
      { jobId: 'j', projectId: 'p', apiKeyEnvVar: 'X', releaseEnvVar: 'Y' },
      d,
    );

    expect(r.status).toBe('failed');
    expect(d.commitAndPush).not.toHaveBeenCalled();
    expect(d.createPr).not.toHaveBeenCalled();
  });
});
