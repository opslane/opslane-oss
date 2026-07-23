import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { containedRepoRelative, isSecretFile } from '../paths.js';

describe('onboarding path policy', () => {
  it('treats every dotenv-shaped basename as secret', () => {
    for (const filename of ['.env', '.env.production', '.env.local', '.env-example', '.envrc']) {
      expect(isSecretFile(`/x/${filename}`)).toBe(true);
    }
    expect(isSecretFile('/x/src/env.ts')).toBe(false);
  });

  it('contains canonical paths and rejects escapes through paths or symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'opslane-paths-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.ts'), '');
    symlinkSync('/etc', join(root, 'link'));

    expect(containedRepoRelative(root, join(root, 'src', 'main.ts'))).toBe('src/main.ts');
    expect(containedRepoRelative(root, join(root, 'pkg', '..', 'src', 'main.ts'))).toBe('src/main.ts');
    expect(() => containedRepoRelative(root, '/etc/passwd')).toThrow(/contain/i);
    expect(() => containedRepoRelative(root, join(root, 'link', 'passwd'))).toThrow(/contain/i);
    expect(containedRepoRelative(root, join(root, 'src', 'new.ts'))).toBe('src/new.ts');
  });
});
