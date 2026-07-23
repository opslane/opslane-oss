import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function isSecretFile(filePath: string): boolean {
  return path.basename(filePath).startsWith('.env');
}

export function containedRepoRelative(root: string, candidatePath: string): string {
  const realRoot = realpathSync(root);
  const normalized = candidatePath.replaceAll(/[\\/]/g, path.sep);
  const absolute = path.resolve(realRoot, normalized);

  let existingAncestor = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Path is not contained in repository: ${candidatePath}`);
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  const resolved = path.join(realpathSync(existingAncestor), ...missingSegments);
  const relative = path.relative(realRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is not contained in repository: ${candidatePath}`);
  }

  return relative.split(path.sep).join('/');
}
