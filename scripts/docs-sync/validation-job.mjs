#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlayStagedDocs } from './publish.mjs';
import {
  checkedRunner,
  loadSnippetManifest,
  runRunnableSnippets,
  validateCheckoutSite,
} from './validation.mjs';

export function validateProposedDocs({
  stagingDir,
  map,
  artifact,
  checkoutRoot,
  headSha,
  snippetManifest = loadSnippetManifest(),
  runner = checkedRunner,
  snippetRunner = runRunnableSnippets,
  siteValidator = validateCheckoutSite,
  reportWarning = (warning) => console.warn(`::warning title=Docs sync quality::${warning.message}`),
}) {
  const { staged } = overlayStagedDocs({
    stagingDir,
    map,
    artifact,
    checkoutRoot,
    expectedHeadSha: headSha,
    snippetManifest,
    reportWarning,
  });
  if (staged.length === 0) return { validated: false, reason: 'empty' };

  runner('pnpm', ['--dir', checkoutRoot, '--filter', '@opslane/sdk', 'build'], { cwd: checkoutRoot });
  snippetRunner({
    checkoutRoot,
    fixtureRepoRoot: checkoutRoot,
    docPaths: staged,
    snippetManifest,
    runner,
  });
  siteValidator({ checkoutRoot, runner });
  return { validated: true, changed: staged };
}

function main() {
  const [stagingDir, mapPath, checkoutRoot] = process.argv.slice(2);
  if (!stagingDir || !mapPath || !checkoutRoot) {
    throw new Error('usage: validation-job.mjs <staging-dir> <map.json> <pr-checkout>');
  }
  const resolvedStaging = resolve(stagingDir);
  validateProposedDocs({
    stagingDir: resolvedStaging,
    map: JSON.parse(readFileSync(resolve(mapPath), 'utf8')),
    artifact: JSON.parse(readFileSync(resolve(resolvedStaging, 'artifact.json'), 'utf8')),
    checkoutRoot: resolve(checkoutRoot),
    headSha: process.env.HEAD_SHA ?? '',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
