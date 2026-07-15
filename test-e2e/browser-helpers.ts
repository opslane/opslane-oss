/**
 * Browser-smoke harness: boots a fixture app under Vite with the SDK aliased
 * to source and init() config injected (real ingestion endpoint + seeded key).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
  entryPattern: RegExp;
  plugins: PluginOption[];
}): Promise<FixtureServer> {
  const { createServer } = await import('vite');
  const apiKey = JSON.stringify(opts.apiKey);
  const ingestionUrl = JSON.stringify(opts.ingestionUrl);
  const server = await createServer({
    root: opts.fixtureDir,
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: [
        // Order matters: subpaths before the bare specifier.
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

          const replaced = code.replace(
            /init\(\{[\s\S]*?\}\);/,
            `init({
              endpoint: ${ingestionUrl},
              apiKey: ${apiKey},
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
    close: () => server.close(),
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
