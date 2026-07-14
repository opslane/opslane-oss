import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reactViteCodemod } from '../codemods/react-vite.js';
import { nextjsCodemod } from '../codemods/nextjs.js';
import { vueViteCodemod } from '../codemods/vue-vite.js';
import { nuxtCodemod } from '../codemods/nuxt.js';
import { getCodemod } from '../codemods/registry.js';
import { generateFallbackPatches } from '../ai-fallback.js';

describe('react-vite codemod', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-codemod-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct framework name', () => {
    expect(reactViteCodemod.framework).toBe('react-vite');
  });

  it('generates patches for src/main.tsx', async () => {
    await writeFile(join(tmpDir, 'src', 'main.tsx'), 'import React from "react";\n');

    const patches = await reactViteCodemod.generate(tmpDir);

    const mainPatch = patches.find((p) => p.filePath === 'src/main.tsx');
    expect(mainPatch).toBeDefined();
    expect(mainPatch?.action).toBe('modify');
    expect(mainPatch?.insertContent).toContain('@opslane/sdk');
    expect(mainPatch?.insertContent).toContain('OpslaneSDK.init');
    expect(mainPatch?.insertContent).toContain('apiKey');
    expect(mainPatch?.insertContent).not.toContain('dsn');
    expect(mainPatch?.insertContent).not.toContain('@opslane/browser-sdk');
  });

  it('does not generate opslane.config.ts', async () => {
    await writeFile(join(tmpDir, 'src', 'main.tsx'), '');

    const patches = await reactViteCodemod.generate(tmpDir);

    const configPatch = patches.find(
      (p) => p.filePath === 'opslane.config.ts',
    );
    expect(configPatch).toBeUndefined();
  });

  it('prefers main.tsx over main.jsx when both exist', async () => {
    await writeFile(join(tmpDir, 'src', 'main.tsx'), '');
    await writeFile(join(tmpDir, 'src', 'main.jsx'), '');

    const patches = await reactViteCodemod.generate(tmpDir);
    const mainPatch = patches.find((p) => p.filePath.includes('main'));
    expect(mainPatch?.filePath).toBe('src/main.tsx');
  });

  it('falls back to main.jsx when main.tsx does not exist', async () => {
    await writeFile(join(tmpDir, 'src', 'main.jsx'), '');

    const patches = await reactViteCodemod.generate(tmpDir);
    const mainPatch = patches.find((p) => p.filePath.includes('main'));
    expect(mainPatch?.filePath).toBe('src/main.jsx');
  });
});

describe('nextjs codemod', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-codemod-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct framework name', () => {
    expect(nextjsCodemod.framework).toBe('nextjs');
  });

  it('generates patches for app/layout.tsx (app router)', async () => {
    await mkdir(join(tmpDir, 'app'), { recursive: true });
    await writeFile(join(tmpDir, 'app', 'layout.tsx'), 'export default function RootLayout() {}\n');

    const patches = await nextjsCodemod.generate(tmpDir);

    const layoutPatch = patches.find(
      (p) => p.filePath === 'app/layout.tsx',
    );
    expect(layoutPatch).toBeDefined();
    expect(layoutPatch?.action).toBe('modify');
    expect(layoutPatch?.insertContent).toContain('OpslaneSDK');
  });

  it('falls back to pages/_app.tsx when app router not found', async () => {
    await mkdir(join(tmpDir, 'pages'), { recursive: true });
    await writeFile(join(tmpDir, 'pages', '_app.tsx'), 'export default function App() {}\n');

    const patches = await nextjsCodemod.generate(tmpDir);

    const appPatch = patches.find(
      (p) => p.filePath === 'pages/_app.tsx',
    );
    expect(appPatch).toBeDefined();
    expect(appPatch?.action).toBe('modify');
  });

  it('uses @opslane/sdk and apiKey', async () => {
    const patches = await nextjsCodemod.generate(tmpDir);
    const layoutPatch = patches.find((p) => p.action === 'modify');
    expect(layoutPatch?.insertContent).toContain('@opslane/sdk');
    expect(layoutPatch?.insertContent).toContain('apiKey');
    expect(layoutPatch?.insertContent).not.toContain('dsn');
    expect(layoutPatch?.insertContent).not.toContain('@opslane/browser-sdk');
  });

  it('does not generate opslane.config.ts', async () => {
    const patches = await nextjsCodemod.generate(tmpDir);

    const configPatch = patches.find(
      (p) => p.filePath === 'opslane.config.ts',
    );
    expect(configPatch).toBeUndefined();
  });
});

describe('vue-vite codemod', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-codemod-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct framework name', () => {
    expect(vueViteCodemod.framework).toBe('vue-vite');
  });

  it('generates patches for src/main.ts', async () => {
    await writeFile(join(tmpDir, 'src', 'main.ts'), "import { createApp } from 'vue';\n");

    const patches = await vueViteCodemod.generate(tmpDir);

    const mainPatch = patches.find((p) => p.filePath === 'src/main.ts');
    expect(mainPatch).toBeDefined();
    expect(mainPatch?.action).toBe('modify');
  });

  it('includes OpslaneSDK and opslaneVuePlugin import from @opslane/sdk', async () => {
    await writeFile(join(tmpDir, 'src', 'main.ts'), '');

    const patches = await vueViteCodemod.generate(tmpDir);
    const importPatch = patches.find(
      (p) =>
        p.action === 'modify' &&
        p.insertContent?.includes('opslaneVuePlugin'),
    );
    expect(importPatch).toBeDefined();
    expect(importPatch?.insertContent).toContain('@opslane/sdk');
    expect(importPatch?.insertContent).toContain('OpslaneSDK');
    expect(importPatch?.insertContent).toContain('apiKey');
    expect(importPatch?.insertContent).not.toContain('@opslane/browser-sdk');
  });

  it('includes app.use(opslaneVuePlugin) call without arguments', async () => {
    await writeFile(join(tmpDir, 'src', 'main.ts'), '');

    const patches = await vueViteCodemod.generate(tmpDir);
    const usePatch = patches.find(
      (p) =>
        p.action === 'modify' &&
        p.insertContent?.includes('app.use(opslaneVuePlugin)'),
    );
    expect(usePatch).toBeDefined();
  });

  it('does not generate opslane.config.ts', async () => {
    await writeFile(join(tmpDir, 'src', 'main.ts'), '');

    const patches = await vueViteCodemod.generate(tmpDir);
    const configPatch = patches.find(
      (p) => p.filePath === 'opslane.config.ts',
    );
    expect(configPatch).toBeUndefined();
  });
});

describe('nuxt codemod', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-codemod-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct framework name', () => {
    expect(nuxtCodemod.framework).toBe('nuxt');
  });

  it('creates plugins/opslane.client.ts with correct SDK import and config', async () => {
    const patches = await nuxtCodemod.generate(tmpDir);

    const pluginPatch = patches.find(
      (p) => p.filePath === 'plugins/opslane.client.ts',
    );
    expect(pluginPatch).toBeDefined();
    expect(pluginPatch?.action).toBe('create');
    expect(pluginPatch?.content).toContain('defineNuxtPlugin');
    expect(pluginPatch?.content).toContain('OpslaneSDK.init');
    expect(pluginPatch?.content).toContain('@opslane/sdk');
    expect(pluginPatch?.content).toContain('apiKey');
    expect(pluginPatch?.content).not.toContain('dsn');
    expect(pluginPatch?.content).not.toContain('@opslane/browser-sdk');
  });

  it('does not create opslane.config.ts', async () => {
    const patches = await nuxtCodemod.generate(tmpDir);

    const configPatch = patches.find(
      (p) => p.filePath === 'opslane.config.ts',
    );
    expect(configPatch).toBeUndefined();
  });
});

describe('codemod registry', () => {
  it('returns react-vite codemod', () => {
    const codemod = getCodemod('react-vite');
    expect(codemod).not.toBeNull();
    expect(codemod?.framework).toBe('react-vite');
  });

  it('returns nextjs codemod', () => {
    const codemod = getCodemod('nextjs');
    expect(codemod).not.toBeNull();
    expect(codemod?.framework).toBe('nextjs');
  });

  it('returns vue-vite codemod', () => {
    const codemod = getCodemod('vue-vite');
    expect(codemod).not.toBeNull();
    expect(codemod?.framework).toBe('vue-vite');
  });

  it('returns nuxt codemod', () => {
    const codemod = getCodemod('nuxt');
    expect(codemod).not.toBeNull();
    expect(codemod?.framework).toBe('nuxt');
  });

  it('returns null for unknown framework', () => {
    const codemod = getCodemod('unknown');
    expect(codemod).toBeNull();
  });

  it('returns null for arbitrary string', () => {
    const codemod = getCodemod('angular');
    expect(codemod).toBeNull();
  });
});

describe('AI fallback', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-fallback-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a opslane-init.ts template file', async () => {
    const patches = await generateFallbackPatches(tmpDir);

    expect(patches).toHaveLength(1);
    expect(patches[0].filePath).toBe('opslane-init.ts');
    expect(patches[0].action).toBe('create');
  });

  it('template includes SDK import', async () => {
    const patches = await generateFallbackPatches(tmpDir);

    expect(patches[0].content).toContain(
      "import { OpslaneSDK } from '@opslane/sdk'",
    );
    expect(patches[0].content).not.toContain('@opslane/browser-sdk');
  });

  it('template includes init call with apiKey', async () => {
    const patches = await generateFallbackPatches(tmpDir);

    expect(patches[0].content).toContain('OpslaneSDK.init');
    expect(patches[0].content).toContain('apiKey');
    expect(patches[0].content).not.toContain('dsn');
  });

  it('template includes setup instructions as comments', async () => {
    const patches = await generateFallbackPatches(tmpDir);

    expect(patches[0].content).toContain('npm install @opslane/sdk');
    expect(patches[0].content).toContain(
      'Your framework was not automatically detected',
    );
  });
});
