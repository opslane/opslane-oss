#!/usr/bin/env node
// Maps changed files to prose docs via covers: frontmatter.
// Pure + dependency-free (cf. check-docs-drift.mjs). No git calls.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function normalizePath(path) {
  if (typeof path !== 'string') return null;
  const normalized = path.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  return normalized || null;
}

export function isProseTierDoc(path) {
  const relative = normalizePath(path);
  if (!relative?.endsWith('.md')) return false;
  if (relative === 'docs/install.md') return true;
  return /^docs\/(guides|architecture|quickstart)\//.test(relative);
}

export function readCovers(source) {
  if (typeof source !== 'string') throw new TypeError('frontmatter source must be a string');

  const normalized = source.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return [];

  const lines = normalized.split('\n');
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end === -1) throw new Error('unterminated frontmatter');

  const frontmatter = lines.slice(1, end);
  const coversLines = frontmatter
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^covers:\s*/.test(line));
  if (coversLines.length === 0) return [];
  if (coversLines.length > 1) throw new Error('duplicate covers field');

  const { line, index } = coversLines[0];
  const inlineValue = line.slice(line.indexOf(':') + 1).trim();
  if (inlineValue === '[]') throw new Error('empty covers list');
  if (inlineValue) throw new Error('covers must be a YAML list');

  const covers = [];
  for (const candidate of frontmatter.slice(index + 1)) {
    if (/^\s*$/.test(candidate) || /^\s+#/.test(candidate)) continue;
    if (!/^\s/.test(candidate)) break;

    const item = candidate.match(/^\s+-\s+(.+?)\s*$/);
    if (!item) throw new Error('covers must contain only list items');

    let value = item[1].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (!value.endsWith(quote) || value.length < 2) {
        throw new Error('unterminated quoted covers item');
      }
      value = value.slice(1, -1);
    }
    if (!value) throw new Error('empty covers item');
    covers.push(value);
  }

  if (covers.length === 0) throw new Error('empty covers list');
  return covers;
}

export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new TypeError('cover glob must be a non-empty string');
  }

  let expression = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if ('.+?^${}()|[]\\/'.includes(character)) {
      expression += `\\${character}`;
    } else {
      expression += character;
    }
  }
  return new RegExp(`^${expression}$`);
}

function isCodePath(path) {
  if (path.startsWith('docs/')) return false;
  if (/(^|\/)__tests__\//.test(path)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /_test\.go$/.test(path)) return false;
  const basename = path.split('/').at(-1);
  if (
    /^(?:\.dockerignore|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|Dockerfile|Makefile|go\.(?:mod|sum)|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
      basename,
    ) ||
    /\.config\.[cm]?[jt]s$/.test(basename) ||
    /\.(?:lock|toml)$/.test(basename)
  ) {
    return false;
  }
  if (
    /(^|\/)(?:package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|.*\.ya?ml|.*\.md)$/.test(
      path,
    )
  ) {
    return false;
  }
  return true;
}

export function mapChangedPaths(changedPaths, docsIndex) {
  const compiled = docsIndex.map((doc) => ({
    path: normalizePath(doc.path),
    patterns: doc.covers.map(globToRegExp),
  }));
  const matched = new Set();
  const uncovered = new Set();

  for (const rawPath of changedPaths) {
    const path = normalizePath(rawPath);
    if (!path) continue;

    let hit = false;
    for (const doc of compiled) {
      if (doc.patterns.some((pattern) => pattern.test(path))) {
        matched.add(doc.path);
        hit = true;
      }
    }
    if (!hit && isCodePath(path)) uncovered.add(path);
  }

  return {
    matched: [...matched].sort(),
    uncovered: [...uncovered].sort(),
  };
}

function* walkMarkdown(root, directory) {
  const absoluteDirectory = join(root, directory);
  if (!existsSync(absoluteDirectory)) return;

  const entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(root, relative);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield relative.split(sep).join('/');
  }
}

export function buildDocsIndex(root = DEFAULT_ROOT) {
  const index = [];
  for (const relative of walkMarkdown(root, 'docs')) {
    if (!isProseTierDoc(relative)) continue;

    try {
      index.push({
        path: relative,
        covers: readCovers(readFileSync(join(root, relative), 'utf8')),
      });
    } catch (error) {
      throw new Error(`${relative}: ${error.message}`, { cause: error });
    }
  }
  return index.sort((left, right) => left.path.localeCompare(right.path));
}

export function findUncoveredProseDocs(index) {
  return index
    .filter((doc) => doc.covers.length === 0)
    .map((doc) => doc.path)
    .sort();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const changedPaths = readFileSync(0, 'utf8')
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean);
  const result = mapChangedPaths(changedPaths, buildDocsIndex());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
