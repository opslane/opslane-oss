import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Codemod } from '../codemods/types.js';
import { nextjsCodemod } from '../codemods/nextjs.js';
import { nuxtCodemod } from '../codemods/nuxt.js';
import { reactViteCodemod } from '../codemods/react-vite.js';
import { vueViteCodemod } from '../codemods/vue-vite.js';
import { applyPatches } from '../init.js';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
interface FixtureCase {
  name: string;
  directory: string;
  codemod: Codemod;
}

function runTypecheck(fixtureRoot: string, projectRoot: string): void {
  const result = spawnSync(
    'pnpm',
    ['run', 'check'],
    {
      cwd: fixtureRoot,
      encoding: 'utf-8',
      env: { ...process.env, CODEMOD_PROJECT: projectRoot },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    );
  }
}

const fixtures: FixtureCase[] = [
  {
    name: 'React + Vite',
    directory: 'codemod-react',
    codemod: reactViteCodemod,
  },
  {
    name: 'Vue + Vite',
    directory: 'codemod-vue',
    codemod: vueViteCodemod,
  },
  {
    name: 'Next.js',
    directory: 'codemod-next',
    codemod: nextjsCodemod,
  },
  {
    name: 'Nuxt',
    directory: 'codemod-nuxt',
    codemod: nuxtCodemod,
  },
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('codemod fixture application', () => {
  it.each(fixtures)(
    'applies the $name codemod once and leaves valid TypeScript',
    async ({ directory, codemod }) => {
      const fixture = join(repositoryRoot, 'test-fixtures', directory);
      const entries = await readdir(fixture, { withFileTypes: true });
      const copyRoot = await mkdtemp(join(fixture, '.codemod-check-'));
      temporaryDirectories.push(copyRoot);
      await Promise.all(entries
        .filter((entry) => entry.name !== 'node_modules' && !entry.name.startsWith('.codemod-check-'))
        .map((entry) => cp(join(fixture, entry.name), join(copyRoot, entry.name), { recursive: true })));

      const patches = await codemod.generate(copyRoot);
      expect(patches.length).toBeGreaterThan(0);
      await applyPatches(copyRoot, patches);
      expect(await codemod.generate(copyRoot)).toEqual([]);

      if (process.env['CODEMOD_BUILD'] === '1') {
        runTypecheck(fixture, copyRoot);
      }
    },
  );
});
