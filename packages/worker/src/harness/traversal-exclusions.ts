export const TRAVERSAL_EXCLUSIONS = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache',
  '.venv', 'venv', 'site-packages', '.pytest_cache', '*.egg-info',
] as const;

export function isExcludedTraversalDirectory(name: string): boolean {
  return TRAVERSAL_EXCLUSIONS.some((entry) =>
    entry === '*.egg-info' ? name.endsWith('.egg-info') : name === entry,
  );
}

export function grepExclusionArgs(): string[] {
  return TRAVERSAL_EXCLUSIONS.map((entry) => `--exclude-dir=${entry}`);
}
