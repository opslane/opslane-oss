// @vitest-environment node
//
// Real-browser chunked session capture contract.
// Drives a real Chromium (Playwright) running the Vue fixture with the LOCAL SDK
// (rrweb capture), triggers an early error, and captures the normal gzipped chunk
// uploaded immediately for that error. The current SDK must not call /replays/*.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

let playwrightAvailable = false;
try {
  const pw = await import('@playwright/test');
  if (pw.chromium) playwrightAvailable = true;
} catch {
  playwrightAvailable = false;
}

interface BrowserPage {
  goto(url: string): Promise<unknown>;
  click(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  close(): Promise<unknown>;
}
interface BrowserInstance { newPage(): Promise<BrowserPage>; close(): Promise<unknown>; }
interface ViteDevServer { listen(): Promise<unknown>; close(): Promise<unknown>; config: { server: { port: number } }; }

let mockServer: http.Server;
let mockPort: number;
let capturedChunk: { events: unknown[]; meta: Record<string, unknown> } | null;
let sessionInitBody: Record<string, unknown> | null;
let chunkPolicyBody: Record<string, unknown> | null;
let chunkCommitCount: number;
let legacyReplayRequestCount: number;
let viteServer: ViteDevServer;
let vitePort: number;
let browser: BrowserInstance;
let page: BrowserPage;

const FIXTURE_APP_DIR = resolve(__dirname, '../../../../test-fixtures/vue-app');

function extractMultipartFile(raw: Buffer, contentType: string): Buffer | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return null;
  const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'));
  if (headerEnd < 0) return null;
  const fileStart = headerEnd + 4;
  const fileEnd = raw.indexOf(Buffer.from(`\r\n--${boundary}`), fileStart);
  return fileEnd < 0 ? null : raw.subarray(fileStart, fileEnd);
}

describe.skipIf(!playwrightAvailable)('rrweb replay capture (real browser)', () => {
  beforeAll(async () => {
    capturedChunk = null;
    sessionInitBody = null;
    chunkPolicyBody = null;
    chunkCommitCount = 0;
    legacyReplayRequestCount = 0;

    mockServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

      const bodyParts: Buffer[] = [];
      req.on('data', (part: Buffer) => { bodyParts.push(part); });
      req.on('end', () => {
        const url = req.url ?? '';
        const rawBody = Buffer.concat(bodyParts);
        const body = rawBody.toString('utf8');
        if (url === '/api/v1/events') {
          res.writeHead(202, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ event_id: 'evt_test', group_id: 'grp_test', error_group_id: 'grp_test' }));
          return;
        }
        if (url === '/api/v1/sessions/init') {
          try { sessionInitBody = JSON.parse(body); } catch { sessionInitBody = null; }
          res.writeHead(200, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ recording: true, chunk_interval_ms: 30000, max_chunk_bytes: 5242880 }));
          return;
        }
        if (/^\/api\/v1\/sessions\/[^/]+\/chunks\/upload-url$/.test(url)) {
          try { chunkPolicyBody = JSON.parse(body); } catch { chunkPolicyBody = null; }
          res.writeHead(200, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ upload_url: `http://localhost:${mockPort}/chunk-upload`, form_data: {} }));
          return;
        }
        if (url === '/chunk-upload' && req.method === 'POST') {
          const compressed = extractMultipartFile(rawBody, req.headers['content-type'] ?? '');
          try {
            capturedChunk = compressed
              ? JSON.parse(gunzipSync(compressed).toString('utf8')) as typeof capturedChunk
              : null;
          } catch {
            capturedChunk = null;
          }
          res.writeHead(200).end();
          return;
        }
        if (/^\/api\/v1\/sessions\/[^/]+\/chunks\/\d+\/commit$/.test(url)) {
          chunkCommitCount += 1;
          res.writeHead(200).end('{}');
          return;
        }
        if (url.startsWith('/api/v1/replays')) legacyReplayRequestCount += 1;
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>(r => mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port; r();
    }));

    const { createServer } = await import('vite');
    const vue = (await import('@vitejs/plugin-vue')).default;
    const vs = await createServer({
      root: FIXTURE_APP_DIR,
      configFile: false,
      resolve: { alias: { '@opslane/sdk': resolve(__dirname, '../index.ts') } },
      server: { port: 0 },
      plugins: [
        vue(),
        {
          name: 'inject-sdk-init',
          transform(code: string, id: string) {
            if (id.endsWith('/main.ts')) {
              return code.replace(/init\(\{[\s\S]*?\}\);/, `init({
                endpoint: 'http://localhost:${mockPort}',
                apiKey: 'sk-test-browser',
                flushInterval: 200,
                maxBatchSize: 1,
                replay: { enabled: true },
              });`);
            }
          },
        },
      ],
    });
    await vs.listen();
    viteServer = vs as unknown as ViteDevServer;
    vitePort = viteServer.config.server.port!;

    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch() as unknown as BrowserInstance;
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await viteServer?.close();
    await new Promise<void>(r => mockServer?.close(() => r()));
  });

  it('flushes a self-contained normal chunk for an early error without a one-shot upload', async () => {
    await page.goto(`http://localhost:${vitePort}`);
    // Generate some DOM activity (rrweb incremental events) then trigger the bug.
    await page.click('[data-testid="nav-usercard"]');
    await page.click('[data-testid="edit-profile-btn"]');
    // Wait for event flush + chunk policy→multipart upload→commit round trip.
    await page.waitForTimeout(2500);

    expect(sessionInitBody?.session_id).toEqual(expect.any(String));
    expect(capturedChunk, 'an error-flushed chunk was uploaded through the session protocol').toBeTruthy();
    const chunk = capturedChunk!;
    expect(Array.isArray(chunk.events)).toBe(true);
    expect(chunk.events.length).toBeGreaterThan(1);
    expect(typeof chunk.meta.sdk_version).toBe('string');
    expect(chunk.meta.has_full_snapshot).toBe(true);
    expect(typeof chunk.meta.chunked_at).toBe('number');

    // Each chunk is independently playable: viewport Meta then FullSnapshot.
    const types = (chunk.events as Array<{ type: number; timestamp: number }>).map((event) => event.type);
    expect(types.slice(0, 2)).toEqual([4, 2]);
    const ts = (chunk.events as Array<{ timestamp: number }>).map((event) => event.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(chunkPolicyBody).toMatchObject({ seq: 0, has_full_snapshot: true });
    expect(chunkCommitCount).toBe(1);
    expect(legacyReplayRequestCount).toBe(0);
  }, 20_000);
});
