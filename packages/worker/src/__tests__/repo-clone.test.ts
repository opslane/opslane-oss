import { describe, expect, it } from 'vitest';
import { cloneRepo } from '../repo-clone.js';

// These inputs are rejected before any git process runs, so no network/git is needed.
describe('cloneRepo input validation (git argument-injection guard)', () => {
  const base = { githubRepo: 'owner/repo', defaultBranch: 'main', jobId: 'j1', githubToken: 'tok' };

  it('rejects a branch that could be parsed as a git option', async () => {
    await expect(
      cloneRepo({ ...base, defaultBranch: '--upload-pack=touch /tmp/pwned' }),
    ).rejects.toThrow(/unsafe branch name/);
  });

  it('rejects a branch containing whitespace', async () => {
    await expect(cloneRepo({ ...base, defaultBranch: 'main foo' })).rejects.toThrow(/unsafe branch name/);
  });

  it('rejects a repo that is not owner/name', async () => {
    await expect(cloneRepo({ ...base, githubRepo: '--foo' })).rejects.toThrow(/unsafe repository name/);
  });
});
