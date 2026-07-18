// @vitest-environment node
import { afterAll, beforeAll, describe, it } from 'vitest';
import { resolve } from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { preview, type PreviewServer } from 'vite';
import { isPlaywrightAvailable } from './browser-helpers.js';

const DASHBOARD = resolve(__dirname, '../packages/dashboard');
const playwrightAvailable = await isPlaywrightAvailable();

describe.skipIf(!playwrightAvailable)('login social buttons', () => {
  let server: PreviewServer;
  let browser: Browser;
  let origin: string;

  beforeAll(async () => {
    server = await preview({
      root: DASHBOARD,
      appType: 'spa',
      preview: { port: 0 },
    });

    const address = server.httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Dashboard preview server did not bind to a TCP port');
    }

    origin = `http://localhost:${address.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (!server) return;
    await new Promise<void>((resolveClose, reject) => {
      server.httpServer.close((error) => {
        if (error) reject(error);
        else resolveClose();
      });
    });
  });

  async function loadLoginWithConfig(config: unknown): Promise<Page> {
    const page = await browser.newPage();
    try {
      await page.route('**/auth/config', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(config),
        })
      );
      await page.goto(`${origin}/login`);
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  it('renders a button per provider, in order, with correct hrefs', async () => {
    const page = await loadLoginWithConfig({
      provider: 'workos',
      supports_password: true,
      supports_signup: true,
      supports_reset: true,
      social_providers: ['github', 'google'],
    });

    try {
      const links = page.locator('a[href^="/auth/login?provider="]');
      await expect(links).toHaveCount(2);
      await expect(links.nth(0)).toHaveAttribute('href', '/auth/login?provider=github');
      await expect(links.nth(1)).toHaveAttribute('href', '/auth/login?provider=google');
      await expect(page.getByText('or continue with email')).toBeVisible();
    } finally {
      await page.close();
    }
  });

  it('renders no social buttons when the list is empty', async () => {
    const page = await loadLoginWithConfig({
      provider: 'workos',
      supports_password: true,
      supports_signup: true,
      supports_reset: true,
      social_providers: [],
    });

    try {
      await expect(page.locator('a[href^="/auth/login?provider="]')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  it('renders social buttons above the redirect control when password login is disabled', async () => {
    const page = await loadLoginWithConfig({
      provider: 'workos',
      supports_password: false,
      supports_signup: false,
      supports_reset: false,
      social_providers: ['github', 'google'],
    });

    try {
      const links = page.locator('a[href^="/auth/login?provider="]');
      const redirectControl = page.getByRole('button', { name: 'Continue to sign in' });
      await expect(links).toHaveCount(2);
      await expect(page.getByText('or', { exact: true })).toBeVisible();
      await expect(redirectControl).toBeVisible();

      const lastSocialButton = await links.last().boundingBox();
      const redirectButton = await redirectControl.boundingBox();
      expect(lastSocialButton).not.toBeNull();
      expect(redirectButton).not.toBeNull();
      expect(lastSocialButton!.y + lastSocialButton!.height).toBeLessThan(redirectButton!.y);
    } finally {
      await page.close();
    }
  });
});
