import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SDK_VERSION } from '../version';

describe('SDK_VERSION', () => {
  it('matches the package.json version at build/test time (not the old 0.0.1)', () => {
    // vitest runs with cwd at the package root (packages/sdk).
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SDK_VERSION).not.toBe('0.0.1');
  });
});
