import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = dirname(fileURLToPath(import.meta.url));

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return vueFiles(full);
    return full.endsWith('.vue') ? [full] : [];
  });
}

/**
 * base.css paints the select chevron at `right 0.75rem`, so every select needs
 * roughly 2rem of right padding to keep the arrow off the option text.
 * Tailwind v4 places utilities in a later layer than @layer base, so a base-layer
 * padding rule loses to any px-* utility — this has to be a class on each control.
 */
describe('select chevron clearance', () => {
  it('gives every <select> at least pr-8 of right padding', () => {
    const offenders: string[] = [];

    for (const file of vueFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const tag of source.matchAll(/<select\b[\s\S]*?>/g)) {
        const classAttr = /\bclass="([^"]*)"/.exec(tag[0])?.[1] ?? '';
        if (!/\bpr-(8|9|10|11|12)\b/.test(classAttr)) offenders.push(relative(SRC, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
