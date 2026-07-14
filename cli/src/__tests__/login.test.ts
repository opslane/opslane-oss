import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, stat, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generatePKCE,
  persistTokensTo,
  loadTokensFrom,
  clearTokensAt,
  type TokenPair,
} from '../auth.js';

describe('generatePKCE', () => {
  it('produces a code_verifier between 43 and 128 characters', () => {
    const { codeVerifier } = generatePKCE();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
  });

  it('produces a code_verifier with only URL-safe characters', () => {
    const { codeVerifier } = generatePKCE();
    // base64url alphabet: A-Z, a-z, 0-9, -, _
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a code_challenge in base64url format', () => {
    const { codeChallenge } = generatePKCE();
    // base64url: A-Z, a-z, 0-9, -, _ (no padding = required by PKCE)
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces different values on each call', () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });

  it('produces a code_challenge that is a SHA256 hash (43 chars base64url)', () => {
    const { codeChallenge } = generatePKCE();
    // SHA256 = 32 bytes = 43 chars in base64url (without padding)
    expect(codeChallenge.length).toBe(43);
  });
});

describe('persistTokens / loadTokens / clearTokens', () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-test-'));
    credFile = join(tmpDir, 'credentials.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('persistTokens writes to disk with mode 0o600', async () => {
    const tokens: TokenPair = {
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt: Date.now() + 3600_000,
    };

    await persistTokensTo(credFile, tokens);

    const stats = await stat(credFile);
    // Check file permissions (owner read/write only)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);

    const contents = JSON.parse(await readFile(credFile, 'utf-8')) as TokenPair;
    expect(contents.accessToken).toBe('access-123');
    expect(contents.refreshToken).toBe('refresh-456');
  });

  it('loadTokens returns tokens when file exists and not expired', async () => {
    const tokens: TokenPair = {
      accessToken: 'access-abc',
      refreshToken: 'refresh-def',
      expiresAt: Date.now() + 3600_000,
    };

    await persistTokensTo(credFile, tokens);
    const loaded = await loadTokensFrom(credFile);

    expect(loaded).not.toBeNull();
    expect(loaded?.accessToken).toBe('access-abc');
  });

  it('loadTokens returns null for missing file', async () => {
    const loaded = await loadTokensFrom(
      join(tmpDir, 'nonexistent.json'),
    );
    expect(loaded).toBeNull();
  });

  it('loadTokens returns null for expired tokens', async () => {
    const tokens: TokenPair = {
      accessToken: 'expired-token',
      refreshToken: 'expired-refresh',
      expiresAt: Date.now() - 1000, // expired 1 second ago
    };

    await persistTokensTo(credFile, tokens);
    const loaded = await loadTokensFrom(credFile);

    expect(loaded).toBeNull();
  });

  it('clearTokens removes the credentials file', async () => {
    const tokens: TokenPair = {
      accessToken: 'to-delete',
      refreshToken: 'to-delete',
      expiresAt: Date.now() + 3600_000,
    };

    await persistTokensTo(credFile, tokens);
    await clearTokensAt(credFile);

    const loaded = await loadTokensFrom(credFile);
    expect(loaded).toBeNull();
  });

  it('clearTokens does not throw when file does not exist', async () => {
    await expect(
      clearTokensAt(join(tmpDir, 'nonexistent.json')),
    ).resolves.not.toThrow();
  });

  it('persistTokens creates parent directory if needed', async () => {
    const nestedFile = join(tmpDir, 'nested', 'dir', 'creds.json');
    const tokens: TokenPair = {
      accessToken: 'nested-token',
      refreshToken: 'nested-refresh',
      expiresAt: Date.now() + 3600_000,
    };

    await persistTokensTo(nestedFile, tokens);
    const loaded = await loadTokensFrom(nestedFile);
    expect(loaded?.accessToken).toBe('nested-token');
  });
});
