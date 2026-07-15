// @vitest-environment node
//
// Real-browser rrweb replay capture contract.
// Drives a real Chromium (Playwright) running the Vue fixture with the LOCAL SDK
// (rrweb capture), triggers an uncaught error, and captures the exact
// `recording.json` the SDK uploads. Asserts the C4 shape and writes the captured
// recording to a fixture so it can be inspected (and replayed) from a PR.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

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
let capturedRecording: { events: unknown[]; meta: Record<string, unknown> } | null;
let initBody: Record<string, unknown> | null;
let completeBody: Record<string, unknown> | null;
let viteServer: ViteDevServer;
let vitePort: number;
let browser: BrowserInstance;
let page: BrowserPage;

const FIXTURE_APP_DIR = resolve(__dirname, '../../../../test-fixtures/vue-app');
const OUT_DIR = resolve(__dirname, 'fixtures');

describe.skipIf(!playwrightAvailable)('rrweb replay capture (real browser)', () => {
  beforeAll(async () => {
    capturedRecording = null; initBody = null; completeBody = null;

    mockServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const url = req.url ?? '';
        if (url === '/api/v1/events') {
          res.writeHead(202, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ event_id: 'evt_test', group_id: 'grp_test', error_group_id: 'grp_test' }));
          return;
        }
        if (url === '/api/v1/sessions/init') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ recording: true, chunk_interval_ms: 30000, max_chunk_bytes: 5242880 }));
          return;
        }
        if (url === '/api/v1/replays/init') {
          try { initBody = JSON.parse(body); } catch { initBody = null; }
          res.writeHead(200, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ replay_id: 'rep_test', upload_url: `http://localhost:${mockPort}/upload` }));
          return;
        }
        if (url === '/upload' && req.method === 'PUT') {
          try { capturedRecording = JSON.parse(body); } catch { capturedRecording = null; }
          res.writeHead(200).end();
          return;
        }
        if (url.endsWith('/complete')) {
          try { completeBody = JSON.parse(body); } catch { completeBody = null; }
          res.writeHead(200).end('{}');
          return;
        }
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

  it('captures a valid rrweb recording.json and uploads it on an uncaught error', async () => {
    await page.goto(`http://localhost:${vitePort}`);
    // Generate some DOM activity (rrweb incremental events) then trigger the bug.
    await page.click('[data-testid="nav-usercard"]');
    await page.click('[data-testid="edit-profile-btn"]');
    // Wait for flush (200ms) + replay init→PUT→complete round trip.
    await page.waitForTimeout(2500);

    // A recording was uploaded
    expect(capturedRecording, 'recording.json was PUT to the upload URL').toBeTruthy();
    const rec = capturedRecording!;

    // C4 shape: events array + meta with epoch-ms crash_timestamp
    expect(Array.isArray(rec.events)).toBe(true);
    expect(rec.events.length).toBeGreaterThan(0);
    expect(typeof rec.meta.crash_timestamp).toBe('number');
    expect(typeof rec.meta.started_at).toBe('number');
    expect(typeof rec.meta.sdk_version).toBe('string');
    // page_url scrubbed (no query string)
    expect(String(rec.meta.page_url)).not.toContain('?');

    // Valid rrweb: a FullSnapshot (type 2) is present and events are sorted ascending.
    const types = (rec.events as Array<{ type: number; timestamp: number }>).map(e => e.type);
    expect(types).toContain(2); // FullSnapshot — required for playback
    const ts = (rec.events as Array<{ timestamp: number }>).map(e => e.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));

    // init body is the C4 7-field shape (no masking_profile / content_type)
    expect(initBody).toBeTruthy();
    expect(initBody!).not.toHaveProperty('masking_profile');
    expect(initBody!).not.toHaveProperty('content_type');
    // complete body has signals, no artifacts
    expect(completeBody).toBeTruthy();
    expect(completeBody!).not.toHaveProperty('artifacts');
    expect(completeBody!).toHaveProperty('signals');

    // Refresh the committed sample only when explicitly capturing, so normal test
    // runs don't dirty the working tree. The checked-in fixture is a captured artifact.
    if (process.env['CAPTURE_REPLAY_FIXTURE']) {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(resolve(OUT_DIR, 'sample-rrweb-recording.json'), JSON.stringify(rec, null, 2));
    }
  }, 20_000);
});
