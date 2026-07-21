/** Internal routing token for the fix pipeline. */
export type Platform = 'javascript' | 'python';

/** Feature gate for the Python pipeline. Default off. */
export function pythonPipelineEnabled(): boolean {
  const raw = process.env['OPSLANE_PYTHON_PIPELINE']?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** Resolve the platform once, before the durable investigate/fix boundary. */
export function effectivePlatform(
  groupPlatform: string | null | undefined,
  flagOn: boolean,
): Platform {
  return flagOn && groupPlatform === 'python' ? 'python' : 'javascript';
}
