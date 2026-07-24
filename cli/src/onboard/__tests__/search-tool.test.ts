import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { createSearchTool } from '../search-tool.js';

const text = async (root: string, input: { query: string; glob?: string }) => {
  const result = await createSearchTool(root).handler({ query: input.query, glob: input.glob }, {});
  return (result.content[0] as { type: 'text'; text: string }).text;
};

describe('secret-aware onboarding search', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opslane-search-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'src', 'main.ts'), 'first\nneedle here\nlast\n');
    writeFileSync(join(root, 'src', 'other.js'), 'needle in javascript\n');
    writeFileSync(join(root, '.env.production'), 'needle=secret\n');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'needle dependency\n');
    writeFileSync(join(root, '.git', 'config'), 'needle git\n');
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  });

  it('returns repo-relative line matches while excluding secrets and ignored content', async () => {
    const result = await text(root, { query: 'needle' });

    expect(result).toContain('src/main.ts:2');
    expect(result).toContain('src/other.js:1');
    expect(result).not.toMatch(/\.env|node_modules|\.git|binary/);
  });

  it('matches literal text and applies an optional glob', async () => {
    writeFileSync(join(root, 'src', 'literal.ts'), 'const value = "a.b";\nconst other = "axb";\n');

    const result = await text(root, { query: 'a.b', glob: '**/*.ts' });

    expect(result).toContain('src/literal.ts:1');
    expect(result).not.toContain('src/other.js');
  });

  it('does not traverse a symlink outside the repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'opslane-search-outside-'));
    writeFileSync(join(outside, 'outside.ts'), 'needle outside\n');
    symlinkSync(outside, join(root, 'linked'));

    const result = await text(root, { query: 'needle' });

    expect(result).not.toContain('linked');
    expect(result).not.toContain('outside.ts');
  });

  it('caps the number of returned matches', async () => {
    writeFileSync(join(root, 'src', 'many.ts'), Array.from({ length: 150 }, () => 'needle').join('\n'));

    const result = await text(root, { query: 'needle' });

    expect(result.split('\n')).toHaveLength(100);
  });

  it('skips files above the per-file scan limit', async () => {
    writeFileSync(join(root, 'src', 'huge.ts'), `${'x'.repeat(1024 * 1024)}needle`);

    const result = await text(root, { query: 'needle' });

    expect(result).not.toContain('huge.ts');
  });

  it('skips past the total byte limit without ending the walk', async () => {
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(root, `a${index}.txt`), 'x'.repeat(900 * 1024));
    }
    writeFileSync(join(root, 'z-after-limit.txt'), 'past-total-limit');

    const result = await text(root, { query: 'past-total-limit' });

    // Files that would blow the budget are skipped, but alphabetically later
    // files are still visited — one heavy subtree must not hide the repo.
    expect(result).toBe('z-after-limit.txt:1');
  });

  it('does not scan generated output directories', async () => {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'bundle.js'), 'generated-needle');
    writeFileSync(join(root, 'src', 'main.ts'), 'generated-needle');

    const result = await text(root, { query: 'generated-needle' });

    expect(result).toBe('src/main.ts:1');
  });
});
