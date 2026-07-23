import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { containedRepoRelative, isSecretFile } from './paths.js';

const MAX_RESULTS = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const BINARY_PREFIX_BYTES = 8 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

function globRegex(glob: string): RegExp {
  let source = '^';
  const normalized = glob.replaceAll('\\', '/');
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === '*' && normalized[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function search(root: string, query: string, glob?: string): string[] {
  const matches: string[] = [];
  const filter = glob === undefined ? undefined : globRegex(glob);
  let totalBytes = 0;
  let exhausted = false;

  const walk = (directory: string): void => {
    if (exhausted) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch {
      return;
    }

    for (const entry of entries) {
      if (exhausted) break;
      if (IGNORED_DIRECTORIES.has(entry.name) || isSecretFile(entry.name)) continue;

      const absolute = path.join(directory, entry.name);
      let relative: string;
      try {
        relative = containedRepoRelative(root, absolute);
      } catch {
        continue;
      }

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || (filter !== undefined && !filter.test(relative))) continue;

      let size: number;
      try {
        size = statSync(absolute).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      if (totalBytes + size > MAX_TOTAL_BYTES) {
        exhausted = true;
        break;
      }

      let buffer: Buffer;
      try {
        buffer = readFileSync(absolute);
      } catch {
        continue;
      }
      totalBytes += buffer.byteLength;
      if (buffer.subarray(0, BINARY_PREFIX_BYTES).includes(0)) continue;

      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index]!.includes(query)) continue;
        matches.push(`${relative}:${index + 1}`);
        if (matches.length >= MAX_RESULTS) {
          exhausted = true;
          break;
        }
      }
    }
  };

  walk(root);
  return matches;
}

export function createSearchTool(root: string) {
  return tool(
    'search',
    'Search repository text files for a literal substring without exposing secret files.',
    { query: z.string().min(1), glob: z.string().optional() },
    async ({ query, glob }) => ({
      content: [{ type: 'text', text: search(root, query, glob).join('\n') }],
    }),
  );
}
