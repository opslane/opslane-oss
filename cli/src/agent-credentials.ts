import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface AgentCredentials {
  org_id: string;
  project_id: string;
  api_key: string;
  repo: string;
  api_url: string;
}

const DEFAULT_CREDENTIALS_DIR = join(homedir(), '.opslane');
const DEFAULT_CREDENTIALS_FILE = join(DEFAULT_CREDENTIALS_DIR, 'agent-credentials.json');

export async function saveAgentCredentials(
  creds: AgentCredentials,
  filePath: string = DEFAULT_CREDENTIALS_FILE,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function loadAgentCredentials(
  filePath: string = DEFAULT_CREDENTIALS_FILE,
): Promise<AgentCredentials | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as Record<string, unknown>)['org_id'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['project_id'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['api_key'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['repo'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['api_url'] === 'string'
    ) {
      return parsed as AgentCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

export function defaultCredentialsPath(): string {
  return DEFAULT_CREDENTIALS_FILE;
}
