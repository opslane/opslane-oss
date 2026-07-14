import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectFramework } from '../detect.js';

describe('detectFramework', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-detect-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects react-vite from package.json with react + vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('react-vite');
  });

  it('detects nextjs from package.json with next', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nextjs');
  });

  it('detects vue-vite from package.json with vue + vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { vue: '^3.4.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('vue-vite');
  });

  it('detects nuxt from package.json with nuxt', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { nuxt: '^3.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nuxt');
  });

  it('returns unknown for bare package.json', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'bare-project',
        dependencies: {},
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('unknown');
  });

  it('returns unknown when no package.json exists', async () => {
    const result = await detectFramework(tmpDir);
    expect(result).toBe('unknown');
  });

  it('priority: next wins over react + vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nextjs');
  });

  it('priority: next wins over vue + vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^14.0.0', vue: '^3.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nextjs');
  });

  it('priority: nuxt wins over vue-vite', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { nuxt: '^3.0.0', vue: '^3.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nuxt');
  });

  it('priority: next > nuxt > vue-vite > react-vite', async () => {
    // All frameworks present — next should win
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          next: '^14.0.0',
          nuxt: '^3.0.0',
          vue: '^3.0.0',
          react: '^18.0.0',
        },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    expect(await detectFramework(tmpDir)).toBe('nextjs');

    // Remove next — nuxt should win
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          nuxt: '^3.0.0',
          vue: '^3.0.0',
          react: '^18.0.0',
        },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    expect(await detectFramework(tmpDir)).toBe('nuxt');

    // Remove nuxt — vue-vite should win
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { vue: '^3.0.0', react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    expect(await detectFramework(tmpDir)).toBe('vue-vite');

    // Remove vue — react-vite should win
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );

    expect(await detectFramework(tmpDir)).toBe('react-vite');
  });

  it('detects framework from devDependencies too', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        devDependencies: { next: '^14.0.0' },
      }),
    );

    const result = await detectFramework(tmpDir);
    expect(result).toBe('nextjs');
  });
});
