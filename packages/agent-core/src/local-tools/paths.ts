import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

/**
 * Resolve a path without allowing it to escape the repository root.
 *
 * Existing paths are checked after resolving every symlink. For a new file,
 * its existing parent is resolved instead. This closes both final-component
 * and nested-symlink escapes while still allowing callers to create a file in
 * a real directory under the root.
 */
export async function containedPath(root: string, candidate: string): Promise<string> {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    throw new Error('Path must be a non-empty string');
  }

  const rootAbsolute = resolve(root);
  const rootReal = await realpath(rootAbsolute);
  const requested = resolve(rootAbsolute, candidate);

  try {
    const targetReal = await realpath(requested);
    if (!isWithin(rootReal, targetReal)) {
      throw new Error(`Path escapes repository root through a symlink: ${candidate}`);
    }
    return targetReal;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;

    try {
      if ((await lstat(requested)).isSymbolicLink()) {
        throw new Error(`Path escapes repository root through a dangling symlink: ${candidate}`);
      }
    } catch (lstatError) {
      if (!(lstatError instanceof Error) || !('code' in lstatError) || lstatError.code !== 'ENOENT') {
        throw lstatError;
      }
    }

    const parentReal = await realpath(dirname(requested));
    if (!isWithin(rootReal, parentReal)) {
      throw new Error(`Path escapes repository root through a symlink: ${candidate}`);
    }
    return resolve(parentReal, basename(requested));
  }
}

/** Write via a fresh no-follow file and rename it into place. */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const temporaryPath = resolve(dirname(path), `.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    created = false;
  } finally {
    if (created) await unlink(temporaryPath).catch(() => undefined);
  }
}
