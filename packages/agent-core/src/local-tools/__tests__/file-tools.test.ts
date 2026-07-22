import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolSpec } from '../../model-port.js';
import { createFileTools, MAX_OUTPUT_CHARS } from '../index.js';

let root: string;
let tools: Map<string, ToolSpec>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opslane-tools-'));
  tools = new Map(createFileTools(root).map((tool) => [tool.name, tool]));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function tool(name: string): ToolSpec {
  const result = tools.get(name);
  if (!result) throw new Error(`Missing tool ${name}`);
  return result;
}

describe('local file tools', () => {
  it('reads text and caps the output at 12,000 characters', async () => {
    await writeFile(join(root, 'long.txt'), 'x'.repeat(20_000));
    const output = await tool('read').execute({ path: 'long.txt' });
    expect(output).toHaveLength(MAX_OUTPUT_CHARS);
    expect(output).toContain('output truncated');
  });

  it('refuses binary files', async () => {
    await writeFile(join(root, 'image.bin'), Buffer.from([1, 0, 2]));
    await expect(tool('read').execute({ path: 'image.bin' })).rejects.toThrow(/binary/);
  });

  it('writes atomically with restrictive permissions', async () => {
    await chmod(root, 0o777);
    await tool('write').execute({ path: 'new.txt', content: 'hello' });
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('hello');
    expect((await lstat(join(root, 'new.txt'))).mode & 0o777).toBe(0o600);
  });

  it('edits one exact anchor and fails when it is absent or ambiguous', async () => {
    await writeFile(join(root, 'source.ts'), 'const before = 1;');
    await tool('edit').execute({ path: 'source.ts', old_string: 'before', new_string: 'after' });
    expect(await readFile(join(root, 'source.ts'), 'utf8')).toBe('const after = 1;');
    await expect(tool('edit').execute({ path: 'source.ts', old_string: 'missing', new_string: 'x' })).rejects.toThrow(/not found/);
    await writeFile(join(root, 'source.ts'), 'same same');
    await expect(tool('edit').execute({ path: 'source.ts', old_string: 'same', new_string: 'x' })).rejects.toThrow(/exactly once/);
  });

  it('searches text while excluding dependency and VCS directories', async () => {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'src', 'a.ts'), 'needle\n');
    await writeFile(join(root, 'node_modules', 'hidden.ts'), 'needle\n');
    await writeFile(join(root, '.git', 'hidden.ts'), 'needle\n');
    const output = await tool('search').execute({ pattern: 'needle', path: '.', include: '*.ts' });
    expect(output).toContain('src/a.ts:1:needle');
    expect(output).not.toContain('hidden');
  });

  it('rejects ReDoS-prone patterns and path escapes', async () => {
    await expect(tool('search').execute({ pattern: '(a+)+$', path: '.' })).rejects.toThrow(/backtracking/);
    await expect(tool('search').execute({ pattern: '(a|aa)+$', path: '.' })).rejects.toThrow(/backtracking/);
    await expect(tool('search').execute({ pattern: 'a*a*a*a*a*a*a*a*b', path: '.' })).rejects.toThrow(/backtracking/);
    await expect(tool('search').execute({ pattern: '(a|aa)(a|aa)(a|aa)(a|aa)b', path: '.' })).rejects.toThrow(/backtracking/);
    await expect(tool('write').execute({ path: '../escape', content: 'no' })).rejects.toThrow(/escapes/);
  });

  it('caps search matches and output', async () => {
    const lines = Array.from({ length: 150 }, (_, index) => `needle ${index} ${'x'.repeat(200)}`).join('\n');
    await writeFile(join(root, 'many.txt'), lines);
    const output = await tool('search').execute({ pattern: 'needle', path: '.' });
    expect(output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(output).not.toContain('needle 149 ');
  });
});
