import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Directories whose contents are credentials rather than source. `.git` is here
 * because `.git/config` routinely holds a GitHub token in the remote URL.
 */
const CREDENTIAL_DIRECTORIES = new Set(['.aws', '.git', '.gnupg', '.ssh']);

const CREDENTIAL_FILENAMES = new Set([
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.pypirc',
  'credentials',
]);

/** Basename prefixes. `.env` covers `.env`, `.env.*`, `.env-*`, and `.envrc`. */
const CREDENTIAL_PREFIXES = [
  '.env',
  'credentials.',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'secrets.',
];

const CREDENTIAL_EXTENSIONS = ['.jks', '.key', '.keystore', '.p12', '.pem', '.pfx', '.tfvars'];

/**
 * True for anything holding credentials, not just dotenv files. Detect only
 * needs manifests, configs, and source; a repo checkout routinely carries
 * `.npmrc` auth tokens, `.git/config` remote PATs, and private keys, and any
 * file this returns false for can be read straight into the model transcript.
 */
export function isSecretFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return (
    CREDENTIAL_DIRECTORIES.has(name) ||
    CREDENTIAL_FILENAMES.has(name) ||
    CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    CREDENTIAL_EXTENSIONS.some((extension) => name.endsWith(extension))
  );
}

/** True when any segment of a repo-relative path is a credential file or directory. */
export function hasSecretSegment(repoRelativePath: string): boolean {
  return repoRelativePath.split('/').some((segment) => isSecretFile(segment));
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
