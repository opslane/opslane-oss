import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listErrors, getError } from '../errors.js';
import { saveAgentCredentials } from '../agent-credentials.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

describe('listErrors', () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-errors-'));
    credFile = join(tmpDir, 'credentials.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when no credentials', async () => {
    await listErrors({
      credentialsPath: join(tmpDir, 'missing.json'),
      fetchFn: async () => new Response(null, { status: 200 }),
    });
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('fetches and outputs incidents list', async () => {
    await saveAgentCredentials({
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: 'def_key',
      repo: 'acme/app',
      api_url: 'http://localhost:8082',
    }, credFile);

    const incidents = [
      { id: '1', error_type: 'TypeError', message: 'null ref', count: 5, status: 'open' },
    ];

    await listErrors({
      credentialsPath: credFile,
      apiUrl: 'http://localhost:8082',
      repo: 'acme/app',
      fetchFn: async () => new Response(JSON.stringify(incidents), { status: 200 }),
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('TypeError'));
  });
});

describe('getError', () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-errors-'));
    credFile = join(tmpDir, 'credentials.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('fetches and outputs a single incident', async () => {
    await saveAgentCredentials({
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: 'def_key',
      repo: 'acme/app',
      api_url: 'http://localhost:8082',
    }, credFile);

    const incident = {
      id: '1',
      error_type: 'TypeError',
      message: 'null ref',
      stack_trace: 'at foo.ts:1',
    };

    await getError('1', {
      credentialsPath: credFile,
      apiUrl: 'http://localhost:8082',
      repo: 'acme/app',
      fetchFn: async () => new Response(JSON.stringify(incident), { status: 200 }),
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('TypeError'));
  });
});
