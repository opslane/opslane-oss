// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dashboardMockFixtures,
  isDashboardBrowserAvailable,
  startDashboardMockHarness,
  type DashboardHarness,
} from './dashboard-mock-harness.js';

const ROOT = resolve(__dirname, '..');
const DASHBOARD = resolve(ROOT, 'packages/dashboard');
const DOCS = resolve(ROOT, 'docs/design/dashboard-v1');
const BASE_COMMIT = '11b8e2607406a90fe926ec1e379ca66605ef96ae';

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
}

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) result.push(...sourceFiles(path));
    else if (['.ts', '.vue', '.css'].includes(extname(path))) result.push(path);
  }
  return result;
}

describe('dashboard V1 safeguards', () => {
  it('pins API types, requests, and router source to the reviewed baseline', () => {
    const requestManifest = JSON.parse(read('docs/design/dashboard-v1/request-manifest.json')) as {
      sourceHashes: Record<string, string>;
      requests: Array<{ method: string; path: string }>;
    };
    for (const [path, expected] of Object.entries(requestManifest.sourceHashes)) {
      expect(sha256(path), `${path} changed outside the frozen frontend contract`).toBe(expected);
    }
    expect(requestManifest.requests.length).toBeGreaterThan(40);
    const keys = requestManifest.requests.map((request) => `${request.method} ${request.path}`);
    expect(new Set(keys).size).toBe(keys.length);

    const declarations = read('docs/design/dashboard-v1/api-baseline.d.ts');
    expect(declarations).toContain('export interface Incident');
    expect(declarations).toContain('export interface Project');
    expect(declarations).toContain(`Captured from commit ${BASE_COMMIT}`);
  });

  it('keeps dashboard package changes limited to the Tailwind 4 toolchain', () => {
    const before = JSON.parse(execFileSync('git', ['show', `${BASE_COMMIT}:packages/dashboard/package.json`], { cwd: ROOT, encoding: 'utf8' })) as Record<string, unknown>;
    const after = JSON.parse(read('packages/dashboard/package.json')) as Record<string, unknown>;
    const beforeDev = before.devDependencies as Record<string, string>;
    const afterDev = after.devDependencies as Record<string, string>;
    const dependencyNames = new Set([...Object.keys(beforeDev), ...Object.keys(afterDev)]);
    const changed = [...dependencyNames].filter((name) => beforeDev[name] !== afterDev[name]).sort();
    expect(changed).toEqual(['@tailwindcss/vite', 'autoprefixer', 'postcss', 'tailwindcss']);
    expect(after.dependencies).toEqual(before.dependencies);
    expect(after.scripts).toEqual(before.scripts);
    execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: ROOT, stdio: 'pipe' });
  }, 60_000);

  it('enforces the deny-first changed-path scope', () => {
    expect(() => execFileSync('bash', ['scripts/check-frontend-scope.sh'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
  });

  it('finishes the governed bridge countdown at zero', () => {
    const source = sourceFiles(resolve(DASHBOARD, 'src')).map((path) => readFileSync(path, 'utf8')).join('\n');
    // The prefix group must allow Tailwind's directional/axis suffixes (border-l-*,
    // border-t-*, ...) and the value group must include the compound legacy names
    // (text-faint, text-muted, surface-2). Without both, `border-l-amber`,
    // `bg-text-faint` and `fill-text-muted` pass a "zero remaining" countdown while
    // emitting no CSS at all — which is exactly how they shipped.
    const palette = source.match(
      /(?:bg|text|border|ring|divide|outline|from|to|via|fill|stroke)(?:-[trblxyse])?-(?:teal|purple|indigo|green|amber|red|text-faint|text-muted|surface-2|border-subtle)(?![\w-])/g,
    )?.length ?? 0;
    const recipes = source.match(/(?:btn-primary|btn-secondary|tab-active|tab-inactive)/g)?.length ?? 0;
    expect(palette + recipes).toBe(0);
    expect(existsSync(resolve(DASHBOARD, 'src/styles/bridge.css'))).toBe(false);
  });

  it('requires a documented production consumer for every owned component', () => {
    const matrix = read('docs/design/dashboard-v1/consumer-matrix.md');
    const ownedRoots = ['ui', 'layout', 'evidence', 'incidents'];
    const production = sourceFiles(resolve(DASHBOARD, 'src')).filter((path) =>
      !/\.(?:test|spec)\.ts$/.test(path) &&
      !path.includes('/__tests__/') &&
      !path.endsWith('/index.ts')
    );
    for (const root of ownedRoots) {
      for (const component of sourceFiles(resolve(DASHBOARD, 'src/components', root)).filter((path) => extname(path) === '.vue')) {
        const name = basename(component);
        expect(matrix, `${name} is absent from consumer-matrix.md`).toContain(`\`${name}\``);
        const symbol = basename(component, '.vue');
        const importPattern = new RegExp(`from ['\"][^'\"]*/${symbol}\\.vue['\"]`);
        const consumers = production.filter((path) => path !== component && importPattern.test(readFileSync(path, 'utf8')));
        expect(consumers.length, `${name} has no production consumer`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps test fixtures and design evidence out of production imports', () => {
    for (const path of sourceFiles(resolve(DASHBOARD, 'src'))) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/test-e2e|dashboard-mock-harness|docs\/design|\.omx/);
    }
  });

  it('keeps captured mock screenshot provenance reproducible', () => {
    const manifestPath = resolve(ROOT, 'docs/design/dashboard-v1/screenshots/after/manifest.json');
    if (!existsSync(manifestPath)) {
      // Captures are absent by design right now: the previous set was deleted
      // because it predated the design fixes and no longer showed the shipped
      // UI. Absence is only acceptable while it stays recorded as a deviation —
      // this assertion is what keeps "no evidence" from passing as "evidence".
      expect(
        read('docs/design/dashboard-v1/known-deviations.md'),
        'screenshots are absent but known-deviations.md does not record it',
      ).toContain('No captured screenshots are committed');
      return;
    }
    const captureManifest = JSON.parse(read('docs/design/dashboard-v1/screenshots/after/manifest.json')) as {
      files: Array<{ name: string; fixture: string; bytes: number; sha256: string }>;
      referenceComparison: string;
    };
    expect(captureManifest.referenceComparison).toContain('not performed');
    expect(captureManifest.files.length).toBeGreaterThan(0);
    for (const capture of captureManifest.files) {
      expect(capture.fixture).toMatch(/-mock$/);
      expect(capture.name).toContain('-mock-');
      const relativePath = `docs/design/dashboard-v1/screenshots/after/${capture.name}`;
      expect(statSync(resolve(ROOT, relativePath)).size).toBe(capture.bytes);
      expect(sha256(relativePath)).toBe(capture.sha256);
    }
  });

  it('holds built JavaScript and CSS to the recorded hard thresholds', () => {
    const baseline = JSON.parse(read('docs/design/dashboard-v1/baseline.json')) as {
      thresholds: { javascriptMaxBytes: number; cssMaxBytes: number };
    };
    const assets = resolve(DASHBOARD, 'dist/assets');
    // Never pass by omission: a job that skipped the build must fail loudly rather
    // than report success while enforcing neither threshold.
    expect(existsSync(assets), 'dist/assets missing — run `pnpm --filter @opslane/dashboard build` before the bundle gate').toBe(true);
    const totals = readdirSync(assets).reduce((sum, file) => {
      const bytes = statSync(resolve(assets, file)).size;
      if (file.endsWith('.js')) sum.js += bytes;
      if (file.endsWith('.css')) sum.css += bytes;
      return sum;
    }, { js: 0, css: 0 });
    const violations: string[] = [];
    if (totals.js > baseline.thresholds.javascriptMaxBytes) {
      violations.push(`JavaScript ${totals.js} B exceeds ${baseline.thresholds.javascriptMaxBytes} B`);
    }
    if (totals.css > baseline.thresholds.cssMaxBytes) {
      violations.push(`CSS ${totals.css} B exceeds ${baseline.thresholds.cssMaxBytes} B`);
    }
    expect(violations).toEqual([]);
  });
});

const browserAvailable = await isDashboardBrowserAvailable();

describe.skipIf(!browserAvailable)('dashboard deterministic Chromium smoke', () => {
  let harness: DashboardHarness;

  beforeAll(async () => {
    harness = await startDashboardMockHarness(dashboardMockFixtures.success);
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  const routes: Array<{ path: string; identity: RegExp }> = [
    { path: '/setup', identity: /Connect GitHub/i },
    { path: '/', identity: /Incidents/i },
    { path: '/incidents/incident-1', identity: /Mock incident title/i },
    { path: '/accounts', identity: /Accounts/i },
    { path: '/accounts/account-1', identity: /Mock Account/i },
    { path: '/sessions', identity: /Sessions/i },
    { path: '/sessions/session-1', identity: /Session details/i },
    { path: '/settings', identity: /Settings/i },
    { path: '/admin', identity: /System observability/i },
  ];

  for (const route of routes) {
    it(`${route.path} has one main landmark and no page-level overflow`, async () => {
      await harness.page.goto(`${harness.url}${route.path}`);
      await expect.poll(async () => harness.page.getByText(route.identity).count()).toBeGreaterThan(0);
      expect(await harness.page.locator('main').count()).toBe(1);
      await harness.page.setViewportSize({ width: 390, height: 844 });
      const layout = await harness.page.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        offenders: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.left < -1 || bounds.right > document.documentElement.clientWidth + 1;
          })
          .slice(0, 8)
          .map((element) => ({ tag: element.tagName, className: element.className, text: element.innerText.slice(0, 60) })),
      }));
      expect(layout.fits, JSON.stringify(layout, null, 2)).toBe(true);
      let activeTag = await harness.page.evaluate(() => document.activeElement?.tagName);
      for (let attempt = 0; attempt < 5 && activeTag === 'BODY'; attempt += 1) {
        await harness.page.keyboard.press('Tab');
        activeTag = await harness.page.evaluate(() => document.activeElement?.tagName);
      }
      expect(activeTag).not.toBe('BODY');
      await harness.page.setViewportSize({ width: 1440, height: 1000 });
      harness.assertClean();
    });
  }

  it('wires Settings tabs to real tabpanels', async () => {
    await harness.page.goto(`${harness.url}/settings`);
    await expect.poll(async () => harness.page.locator('[role="tab"]').count()).toBeGreaterThan(0);

    const wiring = await harness.page.evaluate(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
      return tabs.map((tab) => {
        const controls = tab.getAttribute('aria-controls');
        const panel = controls ? document.getElementById(controls) : null;
        return {
          id: tab.id,
          controls,
          selected: tab.getAttribute('aria-selected'),
          tabindex: tab.getAttribute('tabindex'),
          // a panel only exists for the visible tab; when present it must be a
          // real tabpanel pointing back at its tab
          panelRole: panel?.getAttribute('role') ?? null,
          panelLabelledBy: panel?.getAttribute('aria-labelledby') ?? null,
        };
      });
    });

    expect(wiring.length).toBeGreaterThan(1);
    for (const tab of wiring) {
      expect(tab.id, 'every tab needs an id for aria-labelledby').toBeTruthy();
      expect(tab.controls, 'every tab must declare aria-controls').toBeTruthy();
    }
    // exactly one selected tab, and it owns a rendered tabpanel
    const selected = wiring.filter((tab) => tab.selected === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.tabindex).toBe('0');
    expect(selected[0]?.panelRole).toBe('tabpanel');
    expect(selected[0]?.panelLabelledBy).toBe(selected[0]?.id);
    // roving tabindex: unselected tabs are removed from the tab order
    for (const tab of wiring.filter((entry) => entry.selected !== 'true')) {
      expect(tab.tabindex).toBe('-1');
    }

    // ArrowRight moves selection and focus to the next tab
    await harness.page.locator('[role="tab"][aria-selected="true"]').focus();
    await harness.page.keyboard.press('ArrowRight');
    const moved = await harness.page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return { role: active?.getAttribute('role'), selected: active?.getAttribute('aria-selected') };
    });
    expect(moved.role).toBe('tab');
    expect(moved.selected).toBe('true');

    harness.assertClean();
  });

  it('does not fall through to a live API for an unknown request', async () => {
    const result = await harness.page.evaluate(async () => {
      try {
        await fetch('/api/v1/not-in-the-manifest');
        return 'resolved';
      } catch {
        return 'rejected';
      }
    });
    expect(result).toBe('rejected');
    expect(harness.unexpectedRequests).toContain('GET /api/v1/not-in-the-manifest');
  });
});
