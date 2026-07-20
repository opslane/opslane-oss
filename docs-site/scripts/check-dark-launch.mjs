import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDraft } from './frontmatter.mjs';

const docsSiteRoot = fileURLToPath(new URL('../', import.meta.url));
const distRoot = path.join(docsSiteRoot, 'dist');
const canonicalDoc = fileURLToPath(new URL('../../docs/quickstart/agent.md', import.meta.url));
const renderedPage = path.join(distRoot, 'quickstart/agent/index.html');
const rawEndpoint = path.join(distRoot, 'agent.md');
const sentinels = ['quickstart/agent', '# Agent quickstart', 'Hand the auth link to your human'];

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? htmlFiles(target) : entry.name.endsWith('.html') ? [target] : [];
    }),
  );
  return nested.flat();
}

async function searchableOutputs() {
  const outputs = await htmlFiles(distRoot);
  for (const name of ['llms.txt', 'llms-full.txt', 'llms-small.txt']) {
    const target = path.join(distRoot, name);
    if (existsSync(target)) outputs.push(target);
  }
  return outputs;
}

const problems = [];
let draft;

try {
  draft = parseDraft(await readFile(canonicalDoc, 'utf8'));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  problems.push(`${canonicalDoc}: ${detail}`);
}

if (draft === true) {
  if (existsSync(path.dirname(renderedPage))) {
    problems.push(`${path.dirname(renderedPage)} exists while the quickstart is draft`);
  }
  if (existsSync(rawEndpoint)) {
    problems.push(`${rawEndpoint} exists while the quickstart is draft`);
  }

  for (const file of await searchableOutputs()) {
    const content = await readFile(file, 'utf8');
    for (const sentinel of sentinels) {
      if (content.includes(sentinel)) problems.push(`${file}: contains ${JSON.stringify(sentinel)}`);
    }
  }
} else if (draft === false) {
  if (!existsSync(renderedPage)) problems.push(`${renderedPage} is missing while the quickstart is live`);
  if (!existsSync(rawEndpoint)) {
    problems.push(`${rawEndpoint} is missing while the quickstart is live`);
  } else if (!(await readFile(rawEndpoint, 'utf8')).includes('# Agent quickstart')) {
    problems.push(`${rawEndpoint}: missing the agent quickstart heading`);
  }
}

if (problems.length > 0) {
  console.error(`Agent quickstart dark-launch check failed:\n${problems.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Agent quickstart ${draft ? 'draft' : 'live'} artifacts match the canonical flag.`);
}
