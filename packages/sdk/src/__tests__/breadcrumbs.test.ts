import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  addBreadcrumb,
  getBreadcrumbs,
  clearBreadcrumbs,
} from '../breadcrumbs';
import type { Breadcrumb } from '@opslane/shared';

describe('Breadcrumb Collector', () => {
  beforeEach(() => {
    clearBreadcrumbs();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearBreadcrumbs();
    vi.useRealTimers();
  });

  it('should add a breadcrumb and retrieve it', () => {
    const crumb: Breadcrumb = {
      type: 'click',
      timestamp: new Date().toISOString(),
      category: 'ui.click',
      message: 'button#submit clicked',
    };

    addBreadcrumb(crumb);
    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toEqual(crumb);
  });

  it('should evict breadcrumbs older than maxAge', () => {
    const now = Date.now();
    vi.setSystemTime(now);

    addBreadcrumb({
      type: 'click',
      timestamp: new Date(now).toISOString(),
      category: 'ui.click',
      message: 'old crumb',
    });

    // Advance time by 31 seconds (past the 30s max age)
    vi.setSystemTime(now + 31_000);

    addBreadcrumb({
      type: 'click',
      timestamp: new Date(now + 31_000).toISOString(),
      category: 'ui.click',
      message: 'new crumb',
    });

    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].message).toBe('new crumb');
  });

  it('should enforce max breadcrumb count', () => {
    const maxCount = 50;
    const now = Date.now();
    vi.setSystemTime(now);

    for (let i = 0; i < maxCount + 10; i++) {
      // Keep timestamps within the window so they are NOT evicted by age
      vi.setSystemTime(now + i * 100);
      addBreadcrumb({
        type: 'console',
        timestamp: new Date(now + i * 100).toISOString(),
        category: 'console.log',
        message: `log ${i}`,
      });
    }

    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(maxCount);
    // Oldest remaining should be #10 (first 10 were evicted by count)
    expect(crumbs[0].message).toBe('log 10');
  });

  it('should return a copy, not the internal buffer', () => {
    addBreadcrumb({
      type: 'click',
      timestamp: new Date().toISOString(),
      category: 'ui.click',
      message: 'crumb',
    });

    const crumbs1 = getBreadcrumbs();
    const crumbs2 = getBreadcrumbs();
    expect(crumbs1).not.toBe(crumbs2);
    expect(crumbs1).toEqual(crumbs2);
  });

  it('should clear all breadcrumbs', () => {
    addBreadcrumb({
      type: 'click',
      timestamp: new Date().toISOString(),
      category: 'ui.click',
      message: 'crumb',
    });

    clearBreadcrumbs();
    expect(getBreadcrumbs()).toHaveLength(0);
  });
});
