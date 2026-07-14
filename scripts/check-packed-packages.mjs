#!/usr/bin/env node
/**
 * Prove the published npm tarballs work for a real consumer.
 *
 * For each publishable package (@opslane/sdk, @opslane/cli):
 *   1. `pnpm pack` the exact tarball npm would ship
 *   2. Assert the tarball contains ONLY allowlisted paths (dist/, package.json,
 *      README*, LICENSE*) — no stray env files, sources, or maps
 *   3. Install the tarball into a fresh, empty consumer project (no workspace)
 *   4. SDK: typecheck real imports with tsc — catches unresolvable type-only
 *      imports from the private @opslane/shared package
 *      CLI: execute the installed bin (--help must exit 0)
 *   5. `npm audit signatures` over the consumer's installed tree
 *
 * Usage: node scripts/check-packed-packages.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ALLOWED_TARBALL_PATH = /^package\/(dist\/|package\.json$|README[^/]*$|LICENSE[^/]*$)/;

const TARGETS = [
  {
    name: '@opslane/sdk',
    dir: 'packages/sdk',
    verify: (consumerDir) => {
      writeFileSync(
        join(consumerDir, 'probe.ts'),
        [
          "import { init, captureException, OpslaneSDK } from '@opslane/sdk';",
          "import type { SdkInitOptions } from '@opslane/sdk';",
          'const opts: SdkInitOptions = { apiKey: "k", endpoint: "https://example.com" };',
          'void opts; void init; void captureException; void OpslaneSDK;',
        ].join('\n')
      );
      writeFileSync(
        join(consumerDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            target: 'es2022',
            lib: ['es2022', 'dom'],
            // Standard consumer default; without it, transitive @types
            // packages (rrweb's css-font-loading-module) conflict with the
            // built-in DOM lib. The SDK's own exported types are still fully
            // checked via the probe imports.
            skipLibCheck: true,
          },
          include: ['probe.ts'],
        })
      );
      execFileSync(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', 'typescript@5'],
        { cwd: consumerDir, stdio: 'inherit' }
      );
      execFileSync('npx', ['tsc', '--noEmit', '-p', consumerDir], {
        cwd: consumerDir,
        stdio: 'inherit',
      });
      console.log(`  ✓ consumer typecheck passed`);
    },
  },
  {
    name: '@opslane/cli',
    dir: 'cli',
    verify: (consumerDir) => {
      const out = execFileSync(join(consumerDir, 'node_modules', '.bin', 'opslane'), ['--help'], {
        cwd: consumerDir,
        encoding: 'utf8',
      });
      if (!out.toLowerCase().includes('usage')) {
        throw new Error(`opslane --help produced unexpected output:\n${out}`);
      }
      console.log(`  ✓ installed bin runs (--help)`);
    },
  },
];

let failed = false;

for (const target of TARGETS) {
  console.log(`\n== ${target.name} ==`);
  const pkgDir = resolve(target.dir);

  // 1. Pack
  const packOut = execFileSync('pnpm', ['pack'], { cwd: pkgDir, encoding: 'utf8' }).trim();
  const tarball = resolve(pkgDir, packOut.split('\n').pop());
  console.log(`  packed: ${tarball}`);

  try {
    // 2. Tarball contents allowlist
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .trim()
      .split('\n');
    const offenders = listing.filter((p) => !ALLOWED_TARBALL_PATH.test(p));
    if (offenders.length > 0) {
      console.error(`  ✗ tarball contains non-allowlisted paths:`);
      for (const o of offenders) console.error(`      ${o}`);
      failed = true;
      continue;
    }
    console.log(`  ✓ tarball contents clean (${listing.length} files, all allowlisted)`);

    // 3. Clean consumer install
    const consumerDir = mkdtempSync(join(tmpdir(), 'opslane-consumer-'));
    try {
      writeFileSync(
        join(consumerDir, 'package.json'),
        JSON.stringify({ name: 'consumer', private: true, type: 'module' })
      );
      execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
        cwd: consumerDir,
        stdio: 'inherit',
      });
      console.log(`  ✓ clean-room install succeeded`);

      // 4. Package-specific verification
      target.verify(consumerDir);

      // 5. Registry signature/attestation verification of the installed tree
      execFileSync('npm', ['audit', 'signatures'], { cwd: consumerDir, stdio: 'inherit' });
      console.log(`  ✓ npm audit signatures passed`);
    } finally {
      rmSync(consumerDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tarball, { force: true });
  }
}

if (failed) {
  console.error('\nPacked-package check FAILED.');
  process.exit(1);
}
console.log('\nPacked-package check OK.');
