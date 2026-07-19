import { randomBytes, createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { canonicalOrigin } from './origin.js';
import { withFileLock, writeFileAtomic } from './fsutil.js';

export interface AuthConfig {
  apiUrl: string;
  clientId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

interface TokenFileV2 {
  version: 2;
  tokens: Record<string, TokenPair>;
}

const CREDENTIALS_FILE = join(homedir(), '.opslane', 'credentials.json');
let legacyNoticePrinted = false;

export function generatePKCE(): PKCEPair {
  const codeVerifier = randomBytes(32).toString('base64url').slice(0, 43);
  const hash = createHash('sha256').update(codeVerifier).digest();
  return { codeVerifier, codeChallenge: hash.toString('base64url') };
}

function isTokenPair(value: unknown): value is TokenPair {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['accessToken'] === 'string' &&
    typeof record['refreshToken'] === 'string' &&
    typeof record['expiresAt'] === 'number';
}

function isTokenFileV2(value: unknown): value is TokenFileV2 {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 2 || typeof record['tokens'] !== 'object' || record['tokens'] === null) {
    return false;
  }
  return Object.values(record['tokens'] as Record<string, unknown>).every(isTokenPair);
}

async function readTokenFile(filePath: string, warnLegacy: boolean): Promise<TokenFileV2> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (isTokenFileV2(parsed)) return parsed;
    if (isTokenPair(parsed) && warnLegacy && !legacyNoticePrinted) {
      legacyNoticePrinted = true;
      console.error('Legacy login credentials have no server origin and cannot be reused safely. Run "opslane login" again.');
    }
  } catch {
    // Missing or malformed files are treated as empty.
  }
  return { version: 2, tokens: {} };
}

export async function persistTokens(apiUrl: string, tokens: TokenPair): Promise<void> {
  await persistTokensTo(CREDENTIALS_FILE, apiUrl, tokens);
}

export async function loadTokens(apiUrl: string): Promise<TokenPair | null> {
  return loadTokensFrom(CREDENTIALS_FILE, apiUrl);
}

export async function clearTokens(apiUrl: string): Promise<void> {
  await clearTokensAt(CREDENTIALS_FILE, apiUrl);
}

export async function persistTokensTo(
  filePath: string,
  apiUrl: string,
  tokens: TokenPair,
): Promise<void> {
  await withFileLock(filePath, async () => {
    const current = await readTokenFile(filePath, false);
    current.tokens[canonicalOrigin(apiUrl)] = tokens;
    await writeFileAtomic(filePath, `${JSON.stringify(current, null, 2)}\n`);
  });
}

export async function loadTokensFrom(
  filePath: string,
  apiUrl: string,
): Promise<TokenPair | null> {
  const file = await readTokenFile(filePath, true);
  const tokens = file.tokens[canonicalOrigin(apiUrl)];
  if (!tokens || Date.now() >= tokens.expiresAt) return null;
  return tokens;
}

export async function clearTokensAt(filePath: string, apiUrl?: string): Promise<void> {
  if (!apiUrl) {
    await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }

  await withFileLock(filePath, async () => {
    const current = await readTokenFile(filePath, false);
    delete current.tokens[canonicalOrigin(apiUrl)];
    if (Object.keys(current.tokens).length === 0) {
      await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } else {
      await writeFileAtomic(filePath, `${JSON.stringify(current, null, 2)}\n`);
    }
  });
}

export function defaultTokenPath(): string {
  return CREDENTIALS_FILE;
}
