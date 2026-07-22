import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolSpec } from '../../model-port.js';
import { createFileTools } from '../index.js';
import { SecretVault, createWriteSecretTool } from '../secrets.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opslane-secrets-'));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function byName(tools: ToolSpec[], name: string): ToolSpec {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

describe('SecretVault', () => {
  it('upserts an escaped env value without returning it', async () => {
    const secret = 'quote" and\nnewline';
    const vault = new SecretVault({ api: secret });
    await writeFile(join(root, '.env'), 'KEEP="yes"\nTOKEN="old"\n');
    const output = await createWriteSecretTool(root, vault).execute({ ref: 'api', path: '.env', varName: 'TOKEN' });
    const contents = await readFile(join(root, '.env'), 'utf8');

    expect(contents).toContain(`TOKEN=${JSON.stringify(secret)}`);
    expect(contents.match(/^TOKEN=/gm)).toHaveLength(1);
    expect(output).not.toContain(secret);
    expect((await lstat(join(root, '.env'))).mode & 0o777).toBe(0o600);
  });

  it('redacts all known values longest first', () => {
    const vault = new SecretVault({ short: 'token', long: 'token-value' });
    expect(vault.redact('token-value token')).toBe('[REDACTED] [REDACTED]');
  });

  it('prevents read and direct search of a registered secret sink', async () => {
    const vault = new SecretVault({ api: 'raw-secret' });
    await createWriteSecretTool(root, vault).execute({ ref: 'api', path: '.env', varName: 'TOKEN' });
    const tools = createFileTools(root, vault);
    await expect(byName(tools, 'read').execute({ path: '.env' })).rejects.toThrow(/secret sink/);
    await expect(byName(tools, 'search').execute({ pattern: 'secret', path: '.env' })).rejects.toThrow(/secret sink/);
  });
});
