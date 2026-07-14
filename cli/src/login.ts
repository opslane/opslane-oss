import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import chalk from 'chalk';
import {
  generatePKCE,
  persistTokens,
  type AuthConfig,
  type TokenPair,
} from './auth.js';

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  apiUrl: process.env['OPSLANE_API_URL'] ?? 'http://localhost:8082',
  clientId: process.env['OPSLANE_CLIENT_ID'] ?? 'opslane-cli',
};

/**
 * Exchange an authorization code for tokens.
 */
async function exchangeCode(
  apiUrl: string,
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenPair> {
  const response = await fetch(`${apiUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

/**
 * Start a temporary local HTTP server to receive the OAuth callback.
 * Returns the authorization code. Verifies the state parameter for CSRF protection.
 */
function waitForCallback(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Login Failed</h1><p>You can close this window.</p></body></html>',
        );
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        if (returnedState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h1>Login Failed</h1><p>State mismatch — possible CSRF attack. You can close this window.</p></body></html>',
          );
          server.close();
          reject(new Error('OAuth state mismatch — possible CSRF attack'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Login Successful</h1><p>You can close this window and return to the terminal.</p></body></html>',
        );
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing code parameter');
    });

    server.listen(port, '127.0.0.1');
    server.on('error', reject);

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Login timed out waiting for callback'));
    }, 5 * 60 * 1000);

    server.on('close', () => clearTimeout(timeout));
  });
}

/**
 * Run the PKCE-based login flow.
 */
export async function login(
  config: AuthConfig = DEFAULT_AUTH_CONFIG,
): Promise<void> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = randomBytes(16).toString('hex');

  // Use a random high port
  const port = 19384 + Math.floor(Math.random() * 1000);
  const redirectUri = `http://localhost:${port}/callback`;

  const authUrl = [
    `${config.apiUrl}/oauth/authorize`,
    `?client_id=${encodeURIComponent(config.clientId)}`,
    `&code_challenge=${encodeURIComponent(codeChallenge)}`,
    '&code_challenge_method=S256',
    `&redirect_uri=${encodeURIComponent(redirectUri)}`,
    '&response_type=code',
    `&state=${encodeURIComponent(state)}`,
  ].join('');

  console.log(chalk.bold('\nOpslane Login\n'));
  console.log('Open this URL in your browser to authenticate:\n');
  console.log(chalk.cyan(authUrl));
  console.log('\nWaiting for authentication...\n');

  try {
    const code = await waitForCallback(port, state);

    console.log(chalk.dim('Exchanging authorization code for tokens...'));

    const tokens = await exchangeCode(
      config.apiUrl,
      config.clientId,
      code,
      codeVerifier,
      redirectUri,
    );

    await persistTokens(tokens);

    console.log(
      chalk.green('\nLogin successful! Credentials saved to ~/.opslane/credentials.json'),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\nLogin failed: ${message}`));
    process.exitCode = 1;
  }
}
