/**
 * The single place a provisioned API key touches disk. Names come from the
 * agent's validated OnboardingPlan (tools.ts validatePlan); values come from
 * provisioning. Atomic write (fsutil), 0600 always.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

export async function writeEnvLocal(
  dir: string,
  vars: Record<string, string>,
): Promise<string> {
  for (const name of Object.keys(vars)) {
    if (!ENV_VAR_NAME.test(name)) {
      throw new Error(`invalid environment variable name: ${JSON.stringify(name)}`);
    }
    if (/[\r\n]/.test(vars[name] ?? '')) {
      throw new Error(`invalid environment variable value for ${name}: line breaks are not allowed`);
    }
  }

  const envPath = join(dir, '.env.local');
  let current = '';
  try {
    current = await readFile(envPath, 'utf8');
  } catch {
    // Create the file below.
  }

  let next = current;
  for (const [name, value] of Object.entries(vars)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    next = pattern.test(next)
      ? next.replace(pattern, line)
      : `${next}${next && !next.endsWith('\n') ? '\n' : ''}${line}\n`;
  }

  await writeFileAtomic(envPath, next);
  await chmod(envPath, 0o600);

  const gitignorePath = join(dir, '.gitignore');
  let gitignore = '';
  try {
    gitignore = await readFile(gitignorePath, 'utf8');
  } catch {
    // Create the file below.
  }
  if (!gitignore.split(/\r?\n/).includes('.env.local')) {
    gitignore += `${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}.env.local\n`;
    await writeFile(gitignorePath, gitignore, 'utf8');
  }

  return envPath;
}
