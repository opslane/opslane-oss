import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { reactViteCodemod } from '../codemods/react-vite.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');

describe('codemod SDK type compatibility', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('compiles the generated init snippet against the real SDK source types', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opslane-sdk-types-'));
    const patches = await reactViteCodemod.generate(tempDir);
    const snippet = patches.find((patch) => patch.insertContent?.includes('OpslaneSDK.init'))?.insertContent;
    expect(snippet).toBeDefined();
    expect(snippet).toContain("environment: 'production'");

    await writeFile(join(tempDir, 'generated.ts'), `${snippet}\n`);
    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        baseUrl: repoRoot,
        paths: {
          '@opslane/sdk': ['packages/sdk/src/index.ts'],
          '@opslane/shared': ['shared/src/types.ts'],
        },
      },
      files: [join(tempDir, 'generated.ts')],
    }));

    const tsc = join(repoRoot, 'cli/node_modules/typescript/bin/tsc');
    await expect(execFileAsync(process.execPath, [tsc, '--project', join(tempDir, 'tsconfig.json')]))
      .resolves.toMatchObject({ stderr: '' });
  });
});
