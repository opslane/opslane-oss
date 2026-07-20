import { randomBytes } from 'node:crypto';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;

export async function writeFileAtomic(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const tempPath = `${filePath}.${process.pid}.${suffix}.tmp`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}
