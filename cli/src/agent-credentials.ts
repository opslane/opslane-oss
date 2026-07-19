import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { canonicalOrigin } from './origin.js';
import { withFileLock, writeFileAtomic } from './fsutil.js';

export interface AgentCredentials {
  org_id: string;
  project_id: string;
  api_key: string;
  repo: string;
  api_url: string;
}

interface CredentialsFileV2 {
  version: 2;
  credentials: Record<string, AgentCredentials>;
}

export interface CredentialLookup {
  apiUrl?: string;
  repo?: string | null;
  filePath?: string;
}

const DEFAULT_CREDENTIALS_FILE = join(homedir(), '.opslane', 'agent-credentials.json');

function isAgentCredentials(value: unknown): value is AgentCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['org_id', 'project_id', 'api_key', 'repo', 'api_url']
    .every((key) => typeof record[key] === 'string');
}

function isCredentialsFileV2(value: unknown): value is CredentialsFileV2 {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 2 || typeof record['credentials'] !== 'object' || record['credentials'] === null) {
    return false;
  }
  return Object.values(record['credentials'] as Record<string, unknown>).every(isAgentCredentials);
}

export function credentialKey(apiUrl: string, repo: string): string {
  return `${canonicalOrigin(apiUrl)}|${repo.toLowerCase()}`;
}

async function readCredentialsFile(filePath: string): Promise<CredentialsFileV2> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (isCredentialsFileV2(parsed)) return parsed;
    if (isAgentCredentials(parsed)) {
      return {
        version: 2,
        credentials: { [credentialKey(parsed.api_url, parsed.repo)]: parsed },
      };
    }
  } catch {
    // Missing, malformed, and unreadable files are treated as empty.
  }
  return { version: 2, credentials: {} };
}

export async function saveAgentCredentials(
  creds: AgentCredentials,
  filePath: string = DEFAULT_CREDENTIALS_FILE,
): Promise<void> {
  const normalized: AgentCredentials = {
    ...creds,
    api_url: canonicalOrigin(creds.api_url),
  };
  await withFileLock(filePath, async () => {
    const current = await readCredentialsFile(filePath);
    current.credentials[credentialKey(normalized.api_url, normalized.repo)] = normalized;
    await writeFileAtomic(filePath, `${JSON.stringify(current, null, 2)}\n`);
  });
}

export async function loadAgentCredentials(
  lookup: CredentialLookup,
): Promise<AgentCredentials | null> {
  const file = await readCredentialsFile(lookup.filePath ?? DEFAULT_CREDENTIALS_FILE);
  if (!lookup.apiUrl || !lookup.repo) return null;
  return file.credentials[credentialKey(lookup.apiUrl, lookup.repo)] ?? null;
}

export async function resolveCredentials(
  lookup: CredentialLookup = {},
): Promise<AgentCredentials | null> {
  const file = await readCredentialsFile(lookup.filePath ?? DEFAULT_CREDENTIALS_FILE);
  const entries = Object.values(file.credentials);

  if (lookup.repo) {
    if (!lookup.apiUrl) return null;
    return file.credentials[credentialKey(lookup.apiUrl, lookup.repo)] ?? null;
  }

  if (entries.length !== 1 || !lookup.apiUrl) return null;
  const only = entries[0];
  return only && canonicalOrigin(only.api_url) === canonicalOrigin(lookup.apiUrl) ? only : null;
}

export function defaultCredentialsPath(): string {
  return DEFAULT_CREDENTIALS_FILE;
}
