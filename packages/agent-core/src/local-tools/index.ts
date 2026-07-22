import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { ToolSpec } from '../model-port.js';
import { atomicWriteFile, containedPath } from './paths.js';
import type { SecretVault } from './secrets.js';

export const MAX_OUTPUT_CHARS = 12_000;
const MAX_SEARCH_FILES = 1_000;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache',
  '.venv', 'venv', 'site-packages', '.pytest_cache',
]);

function requiredString(input: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${key} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

export function capOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const marker = '\n... [output truncated] ...\n';
  const retained = MAX_OUTPUT_CHARS - marker.length;
  const first = Math.ceil(retained / 2);
  return output.slice(0, first) + marker + output.slice(-(retained - first));
}

async function readTextFile(path: string): Promise<string> {
  const buffer = await readFile(path);
  if (buffer.includes(0)) throw new Error(`Refusing to read binary file: ${basename(path)}`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Refusing to read binary file: ${basename(path)}`);
  }
}

async function safePath(root: string, candidate: string, vault?: SecretVault): Promise<string> {
  const path = await containedPath(root, candidate);
  if (vault?.isSecretPath(path)) throw new Error(`Refusing to access secret sink: ${candidate}`);
  return path;
}

function validateSearchPattern(pattern: string): RegExp {
  if (pattern.length > 256) throw new Error('Search pattern is too long');
  // JavaScript RegExp has no timeout. Accept a deliberately small, quantifier-
  // free subset so matching cost stays bounded by pattern and line length.
  // Character classes, anchors, grouping, alternation, and escaped literals
  // remain available; repetition, lookarounds, and backreferences do not.
  let escaped = false;
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (escaped) {
      if (/[1-9k]/.test(character)) {
        throw new Error('Search pattern may cause excessive backtracking');
      }
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    if (character === ']') inCharacterClass = false;
    if (!inCharacterClass && '*+?{|'.includes(character)) {
      throw new Error('Search pattern may cause excessive backtracking');
    }
  }
  if (pattern.includes('(?')) {
    throw new Error('Search pattern may cause excessive backtracking');
  }
  try {
    return new RegExp(pattern, 'u');
  } catch (error) {
    throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function globMatcher(glob: string | undefined): (path: string) => boolean {
  if (!glob) return () => true;
  if (glob.length > 128 || glob.includes('\0')) throw new Error('Invalid include pattern');
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
  const matcher = new RegExp(`^(?:${escaped}|.*/${escaped})$`, 'u');
  return (path) => matcher.test(path);
}

async function collectFiles(root: string, start: string): Promise<string[]> {
  const info = await stat(start);
  if (info.isFile()) return [start];
  if (!info.isDirectory()) throw new Error('Search path must be a file or directory');

  const files: string[] = [];
  const pending = [start];
  while (pending.length > 0 && files.length < MAX_SEARCH_FILES) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_SEARCH_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && !entry.name.endsWith('.egg-info')) pending.push(path);
      } else if (entry.isFile()) {
        // Every traversed result must remain under root even if the directory
        // tree changes while the search is in progress.
        files.push(await containedPath(root, path));
      }
    }
  }
  return files;
}

export function createFileTools(root: string, vault?: SecretVault): ToolSpec[] {
  const read: ToolSpec = {
    name: 'read',
    description: 'Read a UTF-8 text file inside the repository.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (input) => capOutput(await readTextFile(await safePath(root, requiredString(input, 'path'), vault))),
  };

  const write: ToolSpec = {
    name: 'write',
    description: 'Atomically write a UTF-8 text file inside the repository.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const candidate = requiredString(input, 'path');
      const content = requiredString(input, 'content', true);
      const path = await safePath(root, candidate, vault);
      await atomicWriteFile(path, content);
      return `Written to ${candidate}`;
    },
  };

  const edit: ToolSpec = {
    name: 'edit',
    description: 'Replace one exact, unique string in a UTF-8 text file.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const candidate = requiredString(input, 'path');
      const oldString = requiredString(input, 'old_string');
      const newString = requiredString(input, 'new_string', true);
      const path = await safePath(root, candidate, vault);
      const contents = await readTextFile(path);
      const first = contents.indexOf(oldString);
      if (first === -1) throw new Error(`old_string not found in ${candidate}`);
      if (contents.indexOf(oldString, first + oldString.length) !== -1) {
        throw new Error(`old_string must appear exactly once in ${candidate}`);
      }
      await atomicWriteFile(path, contents.slice(0, first) + newString + contents.slice(first + oldString.length));
      return `Applied edit to ${candidate}`;
    },
  };

  const search: ToolSpec = {
    name: 'search',
    description: 'Search repository text files with a bounded regular expression.',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', default: '.' },
        include: { type: 'string' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const pattern = validateSearchPattern(requiredString(input, 'pattern'));
      const candidate = input.path === undefined ? '.' : requiredString(input, 'path');
      const include = input.include === undefined ? undefined : requiredString(input, 'include');
      const start = await safePath(root, candidate, vault);
      const matchesGlob = globMatcher(include);
      const results: string[] = [];
      for (const path of await collectFiles(root, start)) {
        if (vault?.isSecretPath(path)) continue;
        const repoPath = relative(await containedPath(root, '.'), path);
        if (!matchesGlob(repoPath)) continue;
        const info = await stat(path);
        if (info.size > MAX_SEARCH_FILE_BYTES) continue;
        let contents: string;
        try {
          contents = await readTextFile(path);
        } catch {
          continue;
        }
        const lines = contents.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          pattern.lastIndex = 0;
          if (pattern.test(lines[index])) results.push(`${repoPath}:${index + 1}:${lines[index]}`);
          if (results.length >= MAX_SEARCH_MATCHES) break;
        }
        if (results.length >= MAX_SEARCH_MATCHES) break;
      }
      return capOutput(results.length > 0 ? results.join('\n') : 'No matches found.');
    },
  };

  return [read, write, edit, search];
}

export { atomicWriteFile, containedPath } from './paths.js';
export { SecretVault, createSecretVault, createWriteSecretTool } from './secrets.js';
export { createAddDependencyTool } from './add-dependency.js';
