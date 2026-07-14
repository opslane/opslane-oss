import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveAgentCredentials,
  loadAgentCredentials,
  type AgentCredentials,
} from '../agent-credentials.js';

describe('agent-credentials', () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-creds-'));
    credFile = join(tmpDir, 'agent-credentials.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads credentials', async () => {
    const creds: AgentCredentials = {
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: 'def_test-key',
      repo: 'acme/my-app',
      api_url: 'http://localhost:8082',
    };

    await saveAgentCredentials(creds, credFile);
    const loaded = await loadAgentCredentials(credFile);
    expect(loaded).toEqual(creds);
  });

  it('returns null for missing file', async () => {
    const loaded = await loadAgentCredentials(join(tmpDir, 'missing.json'));
    expect(loaded).toBeNull();
  });

  it('returns null for invalid schema', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(credFile, JSON.stringify({ foo: 'bar' }));
    const loaded = await loadAgentCredentials(credFile);
    expect(loaded).toBeNull();
  });

  it('writes file with secure permissions', async () => {
    const creds: AgentCredentials = {
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: 'def_test-key',
      repo: 'acme/my-app',
      api_url: 'http://localhost:8082',
    };

    await saveAgentCredentials(creds, credFile);
    const content = await readFile(credFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe('def_test-key');
  });
});
