import { describe, it, expect, vi } from 'vitest';
import { normalizeRepoURL } from '../setup.js';

vi.spyOn(console, 'log').mockImplementation(() => {});

describe('normalizeRepoURL', () => {
  it('extracts owner/repo from HTTPS URL', () => {
    expect(normalizeRepoURL('https://github.com/acme/my-app.git')).toBe('acme/my-app');
  });

  it('extracts owner/repo from SSH URL', () => {
    expect(normalizeRepoURL('git@github.com:acme/my-app.git')).toBe('acme/my-app');
  });

  it('handles URL without .git suffix', () => {
    expect(normalizeRepoURL('https://github.com/acme/my-app')).toBe('acme/my-app');
  });

  it('returns null for non-GitHub URL', () => {
    expect(normalizeRepoURL('https://gitlab.com/acme/my-app')).toBeNull();
  });

  it('returns owner/repo for already-normalized format', () => {
    expect(normalizeRepoURL('acme/my-app')).toBe('acme/my-app');
  });
});
