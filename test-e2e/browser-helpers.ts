/**
 * Browser-smoke harness: boots a fixture app under Vite with the SDK aliased
 * to source and init() config injected (real ingestion endpoint + seeded key).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PluginOption } from 'vite';

const SDK_SRC = resolve(__dirname, '../packages/sdk/src');

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

export async function startFixture(opts: {
  fixtureDir: string;
  apiKey: string;
  ingestionUrl: string;
  environment?: string;
  entryPattern: RegExp;
  plugins: PluginOption[];
}): Promise<FixtureServer> {
  const { createServer } = await import('vite');
  const apiKey = JSON.stringify(opts.apiKey);
  const ingestionUrl = JSON.stringify(opts.ingestionUrl);
  const environment = opts.environment === undefined
    ? ''
    : `\n              environment: ${JSON.stringify(opts.environment)},`;
  // Parallel test files boot the same fixture concurrently; a shared default
  // cache (node_modules/.vite) would have two optimizers racing over one dir.
  const cacheDir = mkdtempSync(join(tmpdir(), 'opslane-vite-cache-'));
  const server = await createServer({
    root: opts.fixtureDir,
    configFile: false,
    cacheDir,
    logLevel: 'error',
    resolve: {
      alias: [
        // Order matters: subpaths before the bare specifier. '_replay' is a
        // test-only alias — the published SDK exports map has no './_replay'.
        { find: '@opslane/sdk/react', replacement: resolve(SDK_SRC, 'react.tsx') },
        { find: '@opslane/sdk/_replay', replacement: resolve(SDK_SRC, 'replay.ts') },
        { find: '@opslane/sdk', replacement: resolve(SDK_SRC, 'index.ts') },
      ],
    },
    server: { port: 0 },
    plugins: [
      ...opts.plugins,
      {
        name: 'inject-sdk-init',
        transform(code: string, id: string) {
          if (!opts.entryPattern.test(id)) return;

          // Replacer function, not a string: a '$' in the injected values
          // would otherwise be interpreted as a replacement pattern ($&, $1).
          const replaced = code.replace(
            /init\(\{[\s\S]*?\}\);/,
            () => `init({
              endpoint: ${ingestionUrl},
              apiKey: ${apiKey},
              ${environment}
              flushInterval: 200,
              maxBatchSize: 1,
              replay: { enabled: true },
            });`
          );
          if (replaced === code) {
            throw new Error(`Fixture entry ${id} has no replaceable init() block`);
          }

          // Replay starts asynchronously (session registration + dynamic
          // rrweb import), so expose readiness instead of sleeping.
          return [
            `import { _replayStarted as __opslaneReplayStarted } from '@opslane/sdk/_replay';`,
            replaced,
            `const __opslaneReadyTimer = setInterval(() => {`,
            `  if (__opslaneReplayStarted()) {`,
            `    Object.assign(window, { __opslaneReplayReady: true });`,
            `    clearInterval(__opslaneReadyTimer);`,
            `  }`,
            `}, 50);`,
          ].join('\n');
        },
      },
    ],
  });
  await server.listen();
  const port = server.config.server.port;
  return {
    url: `http://localhost:${port}`,
    close: async () => {
      await server.close();
      rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}

export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('@playwright/test');
    const executablePath = chromium.executablePath();
    return !!executablePath && existsSync(executablePath);
  } catch {
    return false;
  }
}
