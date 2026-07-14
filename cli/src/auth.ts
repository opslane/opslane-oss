import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

const CREDENTIALS_DIR = join(homedir(), '.opslane');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

/**
 * Generate a PKCE code_verifier and code_challenge (S256).
 * code_verifier: 43-128 chars from unreserved URL-safe characters.
 * code_challenge: Base64url-encoded SHA256 of the verifier.
 */
export function generatePKCE(): PKCEPair {
  // Generate 32 random bytes -> 43 base64url chars
  const codeVerifier = randomBytes(32)
    .toString('base64url')
    .slice(0, 43);

  const hash = createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = hash.toString('base64url');

  return { codeVerifier, codeChallenge };
}

/**
 * Persist tokens to ~/.opslane/credentials.json with mode 0o600.
 */
export async function persistTokens(tokens: TokenPair): Promise<void> {
  await persistTokensTo(CREDENTIALS_FILE, tokens);
}

/**
 * Load tokens from disk. Returns null if file missing or tokens expired.
 */
export async function loadTokens(): Promise<TokenPair | null> {
  return loadTokensFrom(CREDENTIALS_FILE);
}

/**
 * Delete credentials file.
 */
export async function clearTokens(): Promise<void> {
  await clearTokensAt(CREDENTIALS_FILE);
}

/**
 * Persist tokens to a specific path (for testing / custom config).
 */
export async function persistTokensTo(
  filePath: string,
  tokens: TokenPair,
): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
}

/**
 * Load tokens from a specific path (for testing / custom config).
 */
export async function loadTokensFrom(
  filePath: string,
): Promise<TokenPair | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const tokens = JSON.parse(raw) as TokenPair;

    if (Date.now() >= tokens.expiresAt) {
      return null;
    }

    return tokens;
  } catch {
    return null;
  }
}

/**
 * Clear tokens at a specific path (for testing / custom config).
 */
export async function clearTokensAt(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // File may not exist; that's fine
  }
}
