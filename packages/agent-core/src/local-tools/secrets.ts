import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ToolSpec } from '../model-port.js';
import { atomicWriteFile, containedPath } from './paths.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class SecretVault {
  readonly #values = new Map<string, string>();
  readonly #sinks = new Set<string>();

  constructor(initial?: Readonly<Record<string, string>>) {
    for (const [ref, value] of Object.entries(initial ?? {})) this.set(ref, value);
  }

  set(ref: string, value: string): void {
    if (!ref.trim()) throw new Error('Secret ref must not be empty');
    if (!value) throw new Error('Secret value must not be empty');
    this.#values.set(ref, value);
  }

  get(ref: string): string | undefined {
    return this.#values.get(ref);
  }

  registerSink(path: string): void {
    this.#sinks.add(path);
  }

  isSecretPath(path: string): boolean {
    return this.#sinks.has(path);
  }

  redact(text: string): string {
    let redacted = text;
    const values = [...new Set(this.#values.values())].sort((a, b) => b.length - a.length);
    for (const value of values) redacted = redacted.split(value).join('[REDACTED]');
    return redacted;
  }
}

export function createSecretVault(initial?: Readonly<Record<string, string>>): SecretVault {
  return new SecretVault(initial);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function upsertEnv(contents: string, name: string, value: string): string {
  const assignment = `${name}=${JSON.stringify(value)}`;
  const lines = contents ? contents.split(/\r?\n/) : [];
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const index = lines.findIndex((line) => matcher.test(line));
  if (index >= 0) lines[index] = assignment;
  else lines.push(assignment);
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

export function createWriteSecretTool(root: string, vault: SecretVault): ToolSpec {
  return {
    name: 'write_secret',
    description: 'Write a host-provided secret reference to an environment file without exposing its value.',
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Host-provided secret reference' },
        path: { type: 'string', description: 'Environment file path inside the repository' },
        varName: { type: 'string', description: 'Environment variable name' },
      },
      required: ['ref', 'path', 'varName'],
      additionalProperties: false,
    },
    execute: async (input) => {
      const ref = requiredString(input, 'ref');
      const candidate = requiredString(input, 'path');
      const varName = requiredString(input, 'varName');
      if (!ENV_NAME.test(varName)) throw new Error('varName must be a valid environment variable name');

      const value = vault.get(ref);
      if (value === undefined) throw new Error(`Unknown secret ref: ${ref}`);
      const path = await containedPath(root, candidate);
      let contents = '';
      try {
        contents = await readFile(path, 'utf8');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }

      await atomicWriteFile(path, upsertEnv(contents, varName, value));
      vault.registerSink(path);
      return `Stored secret ref ${ref} in ${basename(candidate)} as ${varName}`;
    },
  };
}
