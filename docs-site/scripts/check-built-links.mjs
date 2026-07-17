import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const problems = [];
for (const file of await htmlFiles(fileURLToPath(new URL('../dist/', import.meta.url)))) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = match[1];
    if (!url) continue;
    // Absolute and protocol-relative URLs are external by definition; the
    // repo-file extension rule only applies to same-site (relative/rooted) URLs.
    const absolute = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url);
    const relative = /^\.\.?\//.test(url);
    const repoFile = !absolute && /\.(?:md|mjs|ts|go)(?:[?#]|$)/.test(url);
    if (relative || repoFile) problems.push(`${file}: ${url}`);
  }
}

if (problems.length > 0) {
  console.error(`Built documentation contains invalid repository-relative links:\n${problems.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Built documentation contains no repository-relative file links.');
}
