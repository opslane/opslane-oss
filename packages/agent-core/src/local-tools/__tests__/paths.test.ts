import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { containedPath } from '../paths.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opslane-paths-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('containedPath', () => {
  it('resolves an existing path inside the root', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'inside.txt'), 'ok');
    await expect(containedPath(root, 'inside.txt')).resolves.toBe(join(await realpath(root), 'inside.txt'));
  });

  it('rejects a lexical parent escape', async () => {
    const root = await temporaryRoot();
    await expect(containedPath(root, '../outside.txt')).rejects.toThrow(/escapes repository root/);
  });

  it('rejects an existing final-component symlink outside the root', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(join(outside, 'secret'), join(root, 'link'));
    await expect(containedPath(root, 'link')).rejects.toThrow(/symlink/);
  });

  it('rejects a dangling final-component symlink', async () => {
    const root = await temporaryRoot();
    await symlink(join(root, '..', 'missing-secret'), join(root, 'link'));
    await expect(containedPath(root, 'link')).rejects.toThrow(/symlink/);
  });

  it('rejects a nested symlink escape', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(join(outside, 'nested'));
    await writeFile(join(outside, 'nested', 'secret'), 'secret');
    await symlink(join(outside, 'nested'), join(root, 'linked-dir'));
    await expect(containedPath(root, 'linked-dir/secret')).rejects.toThrow(/symlink/);
  });

  it('allows a new file whose real parent is inside the root', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'src'));
    await expect(containedPath(root, 'src/new.ts')).resolves.toBe(join(await realpath(root), 'src', 'new.ts'));
  });
});
