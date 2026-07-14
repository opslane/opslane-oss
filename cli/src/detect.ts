import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Framework =
  | 'react-vite'
  | 'nextjs'
  | 'vue-vite'
  | 'nuxt'
  | 'unknown';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Detect the framework used in the project at `cwd`.
 *
 * Priority order: next > nuxt > vue-vite > react-vite > unknown
 */
export async function detectFramework(cwd: string): Promise<Framework> {
  const pkgPath = join(cwd, 'package.json');

  let pkg: PackageJson;
  try {
    const raw = await readFile(pkgPath, 'utf-8');
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    return 'unknown';
  }

  const deps = typeof pkg.dependencies === 'object' && pkg.dependencies !== null
    ? Object.keys(pkg.dependencies)
    : [];
  const devDeps = typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null
    ? Object.keys(pkg.devDependencies)
    : [];
  const allDeps = new Set<string>([...deps, ...devDeps]);

  // Priority: next > nuxt > vue-vite > react-vite
  if (allDeps.has('next')) {
    return 'nextjs';
  }

  if (allDeps.has('nuxt')) {
    return 'nuxt';
  }

  if (allDeps.has('vue') && allDeps.has('vite')) {
    return 'vue-vite';
  }

  if (allDeps.has('react') && allDeps.has('vite')) {
    return 'react-vite';
  }

  return 'unknown';
}
