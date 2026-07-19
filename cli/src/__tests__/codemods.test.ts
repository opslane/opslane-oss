import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFallbackPatches } from '../ai-fallback.js';
import { nextjsCodemod } from '../codemods/nextjs.js';
import { nuxtCodemod } from '../codemods/nuxt.js';
import { reactViteCodemod } from '../codemods/react-vite.js';
import { getCodemod } from '../codemods/registry.js';
import type { Codemod, FilePatch } from '../codemods/types.js';
import { vueViteCodemod } from '../codemods/vue-vite.js';
import { applyPatches } from '../init.js';

async function patchAndRead(
  root: string,
  codemod: Codemod,
  file: string,
): Promise<{ content: string; patches: FilePatch[] }> {
  const patches = await codemod.generate(root);
  await applyPatches(root, patches);
  return { content: await readFile(join(root, file), 'utf-8'), patches };
}

describe('structural codemods', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'opslane-codemod-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('patches React after the complete import block with the real env-based API', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src/main.tsx'),
      [
        "import React from 'react';",
        'import {',
        '  createRoot,',
        "} from 'react-dom/client'; // adjacent comment",
        '',
        "createRoot(document.getElementById('root')!).render(<div />);",
        '',
      ].join('\n'),
    );

    const { content } = await patchAndRead(root, reactViteCodemod, 'src/main.tsx');
    expect(content).toContain("import { init } from '@opslane/sdk';");
    expect(content).toContain('apiKey: import.meta.env.VITE_OPSLANE_API_KEY');
    expect(content.indexOf("from 'react-dom/client'"))
      .toBeLessThan(content.indexOf("from '@opslane/sdk'"));
    expect(content).not.toContain('OpslaneSDK');
    expect(content).not.toContain('environment:');
    expect(content).not.toContain('<YOUR_API_KEY>');
    expect(await reactViteCodemod.generate(root)).toEqual([]);
  });

  it('handles React import-only, init-only, unrelated SDK imports, and aliases per aspect', async () => {
    const cases = [
      {
        source: "import { init } from '@opslane/sdk';\nexport {};\n",
        expected: 'init({',
      },
      {
        source: "import React from 'react';\ninit({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY });\n",
        expected: "import { init } from '@opslane/sdk';",
      },
      {
        source: "import { captureException } from '@opslane/sdk';\nexport {};\n",
        expected: "import { init } from '@opslane/sdk';",
      },
      {
        source: "import { init as startOpslane } from '@opslane/sdk';\nstartOpslane({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY });\n",
        expected: null,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const caseRoot = join(root, String(index));
      await mkdir(join(caseRoot, 'src'), { recursive: true });
      await writeFile(join(caseRoot, 'src/main.tsx'), testCase.source);
      const patches = await reactViteCodemod.generate(caseRoot);
      if (testCase.expected === null) expect(patches).toEqual([]);
      else expect(patches.some((patch) => patch.insertContent?.includes(testCase.expected!))).toBe(true);
    }
  });

  it('anchors Vue plugin registration after a multiline createApp statement', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src/main.ts'),
      [
        "import { createApp } from 'vue';",
        "import App from './App.vue';",
        '',
        'const app = createApp(',
        '  App,',
        '); // preserve this comment',
        "app.mount('#app');",
        '',
      ].join('\n'),
    );

    const { content } = await patchAndRead(root, vueViteCodemod, 'src/main.ts');
    expect(content).toContain("import { init, opslaneVuePlugin } from '@opslane/sdk';");
    expect(content).toContain('apiKey: import.meta.env.VITE_OPSLANE_API_KEY');
    expect(content).toContain(
      "); // preserve this comment\napp.use(opslaneVuePlugin);\napp.mount('#app')",
    );
    expect(await vueViteCodemod.generate(root)).toEqual([]);
  });

  it('respects aliased Vue SDK imports and independently adds missing registration', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src/main.ts'),
      [
        "import { createApp } from 'vue';",
        "import { init as boot, opslaneVuePlugin as plugin } from '@opslane/sdk';",
        'boot({ apiKey: import.meta.env.VITE_OPSLANE_API_KEY });',
        'const client = createApp({});',
        "client.mount('#app');",
      ].join('\n'),
    );
    const { content } = await patchAndRead(root, vueViteCodemod, 'src/main.ts');
    expect(content).toContain('client.use(plugin);');
    expect(content.match(/boot\s*\(/g)).toHaveLength(1);
    expect(content.match(/@opslane\/sdk/g)).toHaveLength(1);
  });

  it('creates and renders a client component for the Next App Router', async () => {
    await mkdir(join(root, 'app'));
    await writeFile(
      join(root, 'app/layout.tsx'),
      [
        "import type { ReactNode } from 'react';",
        '',
        'export default function RootLayout({ children }: { children: ReactNode }) {',
        '  return <html><body className="app">{children}</body></html>;',
        '}',
        '',
      ].join('\n'),
    );

    const patches = await nextjsCodemod.generate(root);
    expect(JSON.stringify(patches)).not.toContain('RegExp');
    await applyPatches(root, patches);
    const client = await readFile(join(root, 'app/opslane-client.tsx'), 'utf-8');
    const layout = await readFile(join(root, 'app/layout.tsx'), 'utf-8');
    expect(client.startsWith("'use client';")).toBe(true);
    expect(client).toContain("import { init } from '@opslane/sdk';");
    expect(client).toContain('process.env.NEXT_PUBLIC_OPSLANE_API_KEY');
    expect(client).toContain('if (!initialized && apiKey');
    expect(layout).toContain("import { OpslaneClient } from './opslane-client';");
    expect(layout).toContain('<body className="app">\n<OpslaneClient />');
    expect(layout).not.toContain("from '@opslane/sdk'");
    expect(await nextjsCodemod.generate(root)).toEqual([]);
  });

  it('initializes from a public env var in the Next Pages Router', async () => {
    await mkdir(join(root, 'pages'));
    await writeFile(
      join(root, 'pages/_app.tsx'),
      "import type { AppProps } from 'next/app';\nexport default function App({ Component, pageProps }: AppProps) { return <Component {...pageProps} />; }\n",
    );
    const { content } = await patchAndRead(root, nextjsCodemod, 'pages/_app.tsx');
    expect(content).toContain("import { init } from '@opslane/sdk';");
    expect(content).toContain('process.env.NEXT_PUBLIC_OPSLANE_API_KEY');
    expect(content).not.toContain('environment:');
    expect(await nextjsCodemod.generate(root)).toEqual([]);
  });

  it('repairs a partial Next client component without discarding custom code', async () => {
    await mkdir(join(root, 'app'));
    await writeFile(
      join(root, 'app/layout.tsx'),
      "import { OpslaneClient } from './opslane-client';\nexport default function Layout() { return <body><OpslaneClient /></body>; }\n",
    );
    await writeFile(
      join(root, 'app/opslane-client.tsx'),
      [
        "'use client';",
        "import { captureException } from '@opslane/sdk';",
        'export function OpslaneClient() {',
        "  const keepMe = () => captureException(new Error('custom'));",
        '  void keepMe;',
        '  return null;',
        '}',
        '',
      ].join('\n'),
    );

    const { content, patches } = await patchAndRead(root, nextjsCodemod, 'app/opslane-client.tsx');
    expect(patches).toContainEqual(expect.objectContaining({ action: 'replace' }));
    expect(content).toContain('captureException');
    expect(content).toContain('void keepMe;');
    expect(content).toContain("import { init } from '@opslane/sdk';");
    expect(content).toContain('process.env.NEXT_PUBLIC_OPSLANE_API_KEY');
    expect(content).toContain('if (!initialized && apiKey');
    expect(await nextjsCodemod.generate(root)).toEqual([]);
  });

  it('removes a stale literal key from an existing Next client component', async () => {
    await mkdir(join(root, 'app'));
    await writeFile(
      join(root, 'app/layout.tsx'),
      "import { OpslaneClient } from './opslane-client';\nexport default function Layout() { return <body><OpslaneClient /></body>; }\n",
    );
    await writeFile(
      join(root, 'app/opslane-client.tsx'),
      "'use client';\nimport { init } from '@opslane/sdk';\nexport function OpslaneClient() {\n  init({ apiKey: 'literal-secret' });\n  return null;\n}\n",
    );

    const { content } = await patchAndRead(root, nextjsCodemod, 'app/opslane-client.tsx');
    expect(content).not.toContain('literal-secret');
    expect(content).toContain('process.env.NEXT_PUBLIC_OPSLANE_API_KEY');
    expect(content).toContain('if (!initialized && apiKey');
    expect(await nextjsCodemod.generate(root)).toEqual([]);
  });

  it('creates a Nuxt client plugin backed by public runtime config', async () => {
    await writeFile(
      join(root, 'nuxt.config.ts'),
      "export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n",
    );
    const patches = await nuxtCodemod.generate(root);
    await applyPatches(root, patches);
    const plugin = await readFile(join(root, 'plugins/opslane.client.ts'), 'utf-8');
    const config = await readFile(join(root, 'nuxt.config.ts'), 'utf-8');
    expect(plugin).toContain("import { init } from '@opslane/sdk';");
    expect(plugin).toContain('useRuntimeConfig()');
    expect(plugin).toContain('config.public.opslaneApiKey');
    expect(config).toContain("runtimeConfig: { public: { opslaneApiKey: '' } }");
    expect(await nuxtCodemod.generate(root)).toEqual([]);
  });

  it('adds missing Nuxt initialization inside an existing plugin callback', async () => {
    await mkdir(join(root, 'plugins'));
    await writeFile(
      join(root, 'plugins/opslane.client.ts'),
      "export default defineNuxtPlugin(() => {\n  // existing client setup\n});\n",
    );
    await writeFile(
      join(root, 'nuxt.config.ts'),
      "export default defineNuxtConfig({ runtimeConfig: { public: { opslaneApiKey: '' } } });\n",
    );
    const { content } = await patchAndRead(root, nuxtCodemod, 'plugins/opslane.client.ts');
    expect(content).toContain("import { init } from '@opslane/sdk';");
    expect(content).toContain('defineNuxtPlugin(() => {\n  const config = useRuntimeConfig();');
    expect(content).toContain('init({ apiKey: config.public.opslaneApiKey });');
    expect(await nuxtCodemod.generate(root)).toEqual([]);
  });

  it('emits a real, env-based SDK fallback with no placeholder API', async () => {
    const [patch] = await generateFallbackPatches(root);
    expect(patch?.content).toContain(
      "import { captureException, init } from '@opslane/sdk';",
    );
    expect(patch?.content).toContain('process.env.OPSLANE_API_KEY');
    expect(patch?.content).toContain('init({');
    expect(patch?.content).not.toContain('OpslaneSDK');
    expect(patch?.content).not.toContain('<YOUR_API_KEY>');
  });
});

describe('codemod registry', () => {
  it.each([
    ['react-vite', reactViteCodemod],
    ['nextjs', nextjsCodemod],
    ['vue-vite', vueViteCodemod],
    ['nuxt', nuxtCodemod],
  ])('returns the %s codemod', (framework, expected) => {
    expect(getCodemod(framework)).toBe(expected);
  });

  it('returns null for unknown frameworks', () => {
    expect(getCodemod('angular')).toBeNull();
  });
});
