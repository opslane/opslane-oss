#!/usr/bin/env node
/**
 * License-boundary check for the MIT-published packages.
 *
 * @opslane/sdk and @opslane/cli ship under MIT, so every production
 * dependency in their tarballs must carry an MIT-compatible permissive
 * license. Copyleft (GPL/AGPL/LGPL) or unlicensed dependencies fail the
 * build. The AGPL server packages can consume anything permissive plus
 * AGPL itself, so they are not checked here.
 *
 * Usage: node scripts/check-licenses.mjs
 * (expects `pnpm install` to have run; reads the workspace via `pnpm list`)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIT_PACKAGES = ['@opslane/sdk', '@opslane/cli'];

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'MIT OR Apache-2.0',
  'Apache-2.0 OR MIT',
  '(MIT OR CC0-1.0)',
]);

const listJson = execFileSync(
  'pnpm',
  [
    'list',
    '--prod',
    '--depth',
    'Infinity',
    '--json',
    ...MIT_PACKAGES.flatMap((p) => ['--filter', p]),
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);

const projects = JSON.parse(listJson);
const seen = new Map(); // "name@version" -> path
function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const key = `${name}@${info.version}`;
    if (seen.has(key)) continue;
    seen.set(key, info.path);
    walk(info.dependencies);
  }
}
for (const project of projects) walk(project.dependencies);

const problems = [];
let checked = 0;
for (const [key, pkgPath] of seen) {
  // Workspace packages are NOT exempt: an MIT package depending on an AGPL
  // workspace package (e.g. @opslane/worker) violates the boundary just as
  // hard as a third-party copyleft dependency would.
  let license;
  try {
    const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
    license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
  } catch {
    problems.push(`${key}: cannot read package.json at ${pkgPath}`);
    continue;
  }
  checked += 1;
  if (!license) {
    problems.push(`${key}: no license declared`);
  } else if (!ALLOWED.has(license)) {
    problems.push(`${key}: license "${license}" is not on the MIT-boundary allowlist`);
  }
}

if (checked === 0) {
  console.error('License check inspected zero dependencies — something is wrong.');
  process.exit(1);
}
if (problems.length > 0) {
  console.error('License-boundary check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `License check OK: ${checked} production dependencies of ${MIT_PACKAGES.join(', ')} are MIT-compatible.`
);
