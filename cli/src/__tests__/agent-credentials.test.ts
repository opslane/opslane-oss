import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialKey,
  loadAgentCredentials,
  resolveCredentials,
  saveAgentCredentials,
  type AgentCredentials,
} from '../agent-credentials.js';

describe('agent credentials v2', () => {
  let directory: string;
  let filePath: string;
  const creds: AgentCredentials = {
    org_id: 'org-1', project_id: 'project-1', api_key: 'key-1',
    repo: 'Acme/App', api_url: 'HTTPS://API.OPSLANE.COM:443/path',
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opslane-agent-creds-'));
    filePath = join(directory, 'agent-credentials.json');
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it('stores entries by canonical origin and case-insensitive repo', async () => {
    await saveAgentCredentials(creds, filePath);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(2);
    expect((raw['credentials'] as Record<string, unknown>)[credentialKey('https://api.opslane.com', 'acme/app')]).toBeTruthy();
    await expect(loadAgentCredentials({ filePath, apiUrl: 'https://api.opslane.com', repo: 'ACME/APP' }))
      .resolves.toMatchObject({ api_key: 'key-1' });
  });

  it('reads v1 and migrates it on the next save', async () => {
    await writeFile(filePath, JSON.stringify({ ...creds, api_url: 'https://api.opslane.com' }));
    await expect(loadAgentCredentials({ filePath, apiUrl: 'https://api.opslane.com', repo: 'acme/app' }))
      .resolves.toMatchObject({ project_id: 'project-1' });
    await saveAgentCredentials({ ...creds, repo: 'acme/other', project_id: 'project-2' }, filePath);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { version: number; credentials: Record<string, unknown> };
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.credentials)).toHaveLength(2);
  });

  it('never returns repo A for a known repo B', async () => {
    await saveAgentCredentials(creds, filePath);
    await expect(resolveCredentials({ filePath, apiUrl: 'https://api.opslane.com', repo: 'acme/other' }))
      .resolves.toBeNull();
  });

  it('allows single-entry fallback only without a repo and with matching origin', async () => {
    await saveAgentCredentials(creds, filePath);
    await expect(resolveCredentials({ filePath, apiUrl: 'https://api.opslane.com', repo: null }))
      .resolves.toMatchObject({ api_key: 'key-1' });
    await expect(resolveCredentials({ filePath, apiUrl: 'https://elsewhere.test', repo: null }))
      .resolves.toBeNull();
  });

  it('writes atomically with mode 0600 and leaves no temp files', async () => {
    await saveAgentCredentials(creds, filePath);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('returns null for missing and malformed files', async () => {
    await expect(loadAgentCredentials({ filePath, apiUrl: 'https://api.opslane.com', repo: 'acme/app' })).resolves.toBeNull();
    await writeFile(filePath, '{nope');
    await expect(loadAgentCredentials({ filePath, apiUrl: 'https://api.opslane.com', repo: 'acme/app' })).resolves.toBeNull();
  });
});
