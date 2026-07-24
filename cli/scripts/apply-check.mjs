#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = pathToFileURL(path.join(CLI_ROOT, 'dist', 'onboard', 'engine.js')).href;
const VERIFY = pathToFileURL(path.join(CLI_ROOT, 'dist', 'onboard', 'verify.js')).href;
const MAX_ELAPSED_MS = 10 * 60 * 1_000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required for the live Detect → Apply check.');
  process.exit(2);
}
if (process.argv.length < 3) {
  console.error('Usage: node cli/scripts/apply-check.mjs <app-dir> [app-dir...]');
  process.exit(2);
}

const { runApply, runDetect } = await import(ENGINE);
const { verifyApplied } = await import(VERIFY);

function filesUnder(root) {
  const files = [];
  const pending = [realpathSync(root)];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        files.push(absolute);
      } else if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  return files.sort();
}

function relative(root, absolute) {
  return path.relative(realpathSync(root), absolute).split(path.sep).join('/');
}

function snapshotTree(root) {
  return new Map(
    filesUnder(root).map((absolute) => {
      const metadata = lstatSync(absolute);
      const value = metadata.isSymbolicLink()
        ? `link:${readlinkSync(absolute)}`
        : createHash('sha256').update(readFileSync(absolute)).digest('hex');
      return [relative(root, absolute), value];
    }),
  );
}

function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

function dotenvSnapshots(root, canary) {
  const values = new Map();
  for (const absolute of filesUnder(root)) {
    if (!path.basename(absolute).toLowerCase().startsWith('.env')) continue;
    if (lstatSync(absolute).isSymbolicLink()) continue;
    const contents = `OPSLANE_APPLY_CHECK_CANARY=${canary}\n`;
    writeFileSync(absolute, contents);
    values.set(relative(root, absolute), Buffer.from(contents));
  }
  if (values.size === 0) {
    const absolute = path.join(root, '.env.opslane-apply-check');
    const contents = `OPSLANE_APPLY_CHECK_CANARY=${canary}\n`;
    writeFileSync(absolute, contents);
    values.set(relative(root, absolute), Buffer.from(contents));
  }
  return values;
}

function serializeMessage(message) {
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

async function check(source) {
  const absoluteSource = realpathSync(path.resolve(source));
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'opslane-apply-check-'));
  const fixture = path.join(tempRoot, 'fixture');
  cpSync(absoluteSource, fixture, { recursive: true, dereference: false });

  const canary = `opslane-apply-canary-${randomUUID()}`;
  const envBefore = dotenvSnapshots(fixture, canary);
  const treeBefore = snapshotTree(fixture);
  const transcript = [];
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_ELAPSED_MS);
  let plan;
  let applyReport;

  try {
    const detect = await runDetect({
      cwd: fixture,
      signal: controller.signal,
      onMessage: (message) => transcript.push(serializeMessage(message)),
      onPlan: (value) => {
        plan = value;
      },
      askUser: async ({ options }) => [options[0]],
    });
    if (!detect.ok || plan === undefined) {
      throw new Error(`Detect failed: ${detect.reason ?? detect.subtype ?? 'unknown'}`);
    }
    if (changedFiles(treeBefore, snapshotTree(fixture)).length !== 0) {
      throw new Error('Detect changed the read-only fixture');
    }

    const originals = {
      entry: readFileSync(path.join(fixture, plan.edit.file)),
      manifest: readFileSync(path.join(fixture, plan.edit.manifest_file)),
    };
    const apply = await runApply({
      cwd: fixture,
      plan,
      signal: controller.signal,
      onMessage: (message) => transcript.push(serializeMessage(message)),
      onReport: (report) => {
        applyReport = report;
      },
      requestApproval: async () => true,
    });
    if (!apply.ok || applyReport === undefined) {
      throw new Error(`Apply failed: ${apply.reason ?? apply.subtype ?? 'unknown'}`);
    }
    if (!applyReport.installRequired || typeof applyReport.installCommand !== 'string') {
      throw new Error('Apply did not report the required package-manager install');
    }

    const verification = verifyApplied({
      root: fixture,
      plan,
      editedFiles: applyReport.editedFiles,
      originals,
    });
    if (!verification.ok) {
      throw new Error(`Post-check failed: ${verification.failures.join('; ')}`);
    }

    const changed = changedFiles(treeBefore, snapshotTree(fixture));
    const expected = [plan.edit.file, plan.edit.manifest_file].sort();
    if (JSON.stringify(changed) !== JSON.stringify(expected)) {
      throw new Error(`Changed files ${JSON.stringify(changed)}, expected ${JSON.stringify(expected)}`);
    }
    for (const [file, contents] of envBefore) {
      if (!readFileSync(path.join(fixture, file)).equals(contents)) {
        throw new Error(`Apply changed dotenv file ${file}`);
      }
    }
    if (transcript.join('\n').includes(canary)) {
      throw new Error('The dotenv canary appeared in the agent transcript');
    }

    const elapsedMs = Date.now() - started;
    if (elapsedMs > MAX_ELAPSED_MS) {
      throw new Error(`Detect + Apply exceeded 10 minutes (${elapsedMs}ms)`);
    }
    console.log(
      JSON.stringify({
        source: absoluteSource,
        ok: true,
        entry: plan.edit.file,
        manifest: plan.edit.manifest_file,
        changedFiles: changed,
        installCommand: applyReport.installCommand,
        elapsedMs,
      }),
    );
  } finally {
    clearTimeout(timeout);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

for (const source of process.argv.slice(2)) {
  await check(source);
}
