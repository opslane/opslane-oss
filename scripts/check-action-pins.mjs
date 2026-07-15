#!/usr/bin/env node
/**
 * Enforce that every third-party GitHub Action and container image used in
 * workflows is pinned to an immutable reference:
 *   - `uses: owner/repo@<40-hex-sha>` for actions
 *   - `docker://...@sha256:<64-hex>` for container actions
 *   - `image: ...@sha256:<64-hex>` for job/service containers
 * Local actions (`./...`) are exempt. Tag or branch refs fail.
 *
 * Usage: node scripts/check-action-pins.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = '.github/workflows';
let files = [];
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
} catch {
  console.error(`No ${dir} directory found.`);
  process.exit(1);
}

const problems = [];
let checked = 0;

for (const file of files) {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const uses = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
    if (uses) {
      const ref = uses[1].replace(/^["']|["']$/g, '');
      if (ref.startsWith('./')) return; // local composite action
      checked += 1;
      if (ref.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) {
          problems.push(`${file}:${i + 1} container image not digest-pinned: ${ref}`);
        }
        return;
      }
      if (!/@[0-9a-f]{40}$/.test(ref)) {
        problems.push(`${file}:${i + 1} action not pinned to a full commit SHA: ${ref}`);
      }
      return;
    }
    // Job containers and service containers: `image: <ref>`
    const image = line.match(/^\s*image:\s*(\S+)/);
    if (image) {
      const ref = image[1].replace(/^["']|["']$/g, '');
      // A YAML flow sequence (e.g. a matrix axis named "image") is not a
      // container reference.
      if (ref.startsWith('[')) return;
      checked += 1;
      if (!/@sha256:[0-9a-f]{64}$/.test(ref)) {
        problems.push(`${file}:${i + 1} service/job container image not digest-pinned: ${ref}`);
      }
    }
  });
}

if (checked === 0) {
  console.error('Action-pin check inspected zero `uses:` references — something is wrong.');
  process.exit(1);
}
if (problems.length > 0) {
  console.error('Action-pin check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Action-pin check OK: ${checked} references are SHA-pinned.`);
