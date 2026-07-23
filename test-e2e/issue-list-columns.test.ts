// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dashboardMockFixtures,
  isDashboardBrowserAvailable,
  startDashboardMockHarness,
  type DashboardHarness,
} from './dashboard-mock-harness.js';

const browserAvailable = await isDashboardBrowserAvailable();

describe.skipIf(!browserAvailable)('issue list responsive layout', () => {
  let harness: DashboardHarness;

  beforeAll(async () => {
    harness = await startDashboardMockHarness(dashboardMockFixtures.success);
    await harness.page.emulateMedia({ reducedMotion: 'reduce' });
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('uses stacked issues and a sort control below 640px', async () => {
    await harness.page.setViewportSize({ width: 390, height: 844 });
    await harness.page.goto(harness.url);
    await expect.poll(
      async () => harness.page.getByRole('heading', { name: 'Issues', exact: true }).count(),
    ).toBe(1);

    await expect.poll(
      async () => harness.page.locator('[data-testid="stacked-issue"]').count(),
    ).toBeGreaterThan(0);
    await expect.poll(
      async () => harness.page.getByLabel('Sort issues').isVisible(),
    ).toBe(true);
    expect(await harness.page.locator('table[aria-label="Issues"]').isVisible()).toBe(false);
    harness.assertClean();
  });

  for (const width of [640, 1024, 1280]) {
    it(`aligns visible headers and cells at ${width}px`, async () => {
      await harness.page.setViewportSize({ width, height: 900 });
      await harness.page.goto(harness.url);
      await expect.poll(
        async () => harness.page.getByRole('heading', { name: 'Issues', exact: true }).count(),
      ).toBe(1);

      const layout = await harness.page.evaluate(() => {
        const visibleRects = (selector: string) =>
          [...document.querySelectorAll<HTMLElement>(selector)]
            .map((element) => element.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => ({ left: rect.left, right: rect.right }));

        return {
          headers: visibleRects('table[aria-label="Issues"] thead th'),
          cells: visibleRects('table[aria-label="Issues"] tbody tr:first-child td'),
          stackedVisible: visibleRects('[data-testid="stacked-issues-list"]').length > 0,
        };
      });

      expect(layout.stackedVisible).toBe(false);
      expect(layout.headers.length).toBeGreaterThan(0);
      expect(layout.headers).toHaveLength(layout.cells.length);
      for (let index = 0; index < layout.headers.length; index += 1) {
        expect(Math.abs(layout.headers[index]!.left - layout.cells[index]!.left)).toBeLessThan(1);
        expect(Math.abs(layout.headers[index]!.right - layout.cells[index]!.right)).toBeLessThan(1);
      }
      harness.assertClean();
    });
  }
});
