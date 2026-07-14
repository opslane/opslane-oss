import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSnippet } from '../snippet.js';

vi.spyOn(console, 'log').mockImplementation(() => {});

describe('getSnippet', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-snippet-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects react-vite framework from package.json', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );
    await writeFile(join(tmpDir, 'src', 'main.tsx'), 'import React from "react";');

    const result = await getSnippet({ cwd: tmpDir, apiKey: 'def_test' });
    expect(result.framework).toBe('react-vite');
    expect(result.install).toContain('@opslane/sdk');
  });

  it('returns unknown framework when no package.json', async () => {
    const result = await getSnippet({ cwd: tmpDir, apiKey: 'def_test' });
    expect(result.framework).toBe('unknown');
  });

  it('uses --framework flag when provided', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: {} }),
    );

    const result = await getSnippet({ cwd: tmpDir, framework: 'vue-vite', apiKey: 'def_test' });
    expect(result.framework).toBe('vue-vite');
  });
});
