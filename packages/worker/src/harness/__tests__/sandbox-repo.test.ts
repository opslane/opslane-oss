import { describe, it, expect } from 'vitest';
import { selectBuildCommand, parseAffectedFiles } from '../sandbox-repo.js';

describe('selectBuildCommand', () => {
  it('prefers the build script', () => {
    expect(selectBuildCommand({ scripts: { build: 'vite build' } }, true)).toBe('npm run build');
  });

  it('uses pnpm when pnpm-lock present', () => {
    expect(selectBuildCommand({ scripts: { build: 'x' } }, false, 'pnpm')).toBe('pnpm run build');
  });

  it('falls back to tsc --noEmit when a build script is absent but tsconfig exists', () => {
    expect(selectBuildCommand({}, true)).toBe('npx tsc --noEmit');
  });

  it('returns null when nothing to run', () => {
    expect(selectBuildCommand({}, false)).toBeNull();
  });
});

describe('parseAffectedFiles', () => {
  it('extracts +++ b/ paths', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+1\n';
    expect(parseAffectedFiles(diff)).toEqual(['x']);
  });
});
