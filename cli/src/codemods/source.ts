import { readFile } from 'node:fs/promises';

export async function readSource(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

const importPattern = /^import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[\s\S]*?\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+['"][^'"\r\n]+['"]\s*;?[ \t]*(?:\/\/[^\r\n]*)?$|^import\s+['"][^'"\r\n]+['"]\s*;?[ \t]*(?:\/\/[^\r\n]*)?$/gm;

/** Return the complete last import statement, including multiline imports. */
export function lastImportStatement(source: string): string {
  let last = '';
  for (const match of source.matchAll(importPattern)) {
    last = match[0];
  }
  return last;
}

/** Resolve the local name for a named import from @opslane/sdk. */
export function sdkImportLocalName(
  source: string,
  importedName: string,
): string | null {
  const pattern = /^import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s+from\s+['"]@opslane\/sdk['"]\s*;?/gm;

  for (const match of source.matchAll(pattern)) {
    const named = match[1] ?? '';

    for (const specifier of named.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts[0]?.trim() === importedName) {
        return parts[1]?.trim() || importedName;
      }
    }
  }

  return null;
}

export function hasCall(source: string, localName: string): boolean {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return new RegExp(`\\b${escaped}\\s*\\(`).test(withoutComments);
}

export interface CreateAppStatement {
  appName: string;
  statement: string;
}

/** Find the complete `const app = createApp(...)` statement. */
export function findCreateAppStatement(source: string): CreateAppStatement | null {
  const declaration = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*createApp\s*\(/g.exec(source);
  if (!declaration || declaration.index === undefined) return null;

  const openParen = source.indexOf('(', declaration.index);
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  let closeParen = -1;

  for (let index = openParen; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        closeParen = index;
        break;
      }
    }
  }

  if (closeParen === -1) return null;

  let end = closeParen + 1;
  while (end < source.length && source[end] !== '\n' && source[end] !== '\r') {
    end += 1;
  }

  return {
    appName: declaration[1]!,
    statement: source.slice(declaration.index, end).trimEnd(),
  };
}

export function bodyOpeningTag(source: string): string | null {
  return source.match(/<body(?:\s[^>]*)?>/)?.[0] ?? null;
}
