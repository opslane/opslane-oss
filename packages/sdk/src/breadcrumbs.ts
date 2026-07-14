import type { Breadcrumb } from '@opslane/shared';
import { getConfig } from './config';

const DEFAULT_MAX_BREADCRUMBS = 50;
const DEFAULT_MAX_AGE_MS = 30_000;

let buffer: Breadcrumb[] = [];

type BreadcrumbListener = (crumb: Breadcrumb) => void;
let listeners: BreadcrumbListener[] = [];

/** Subscribe to breadcrumb additions. Returns unsubscribe function. */
export function onBreadcrumb(fn: BreadcrumbListener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function getMaxBreadcrumbs(): number {
  try { return getConfig().maxBreadcrumbs; } catch { return DEFAULT_MAX_BREADCRUMBS; }
}

function getMaxAge(): number {
  try { return getConfig().breadcrumbMaxAge; } catch { return DEFAULT_MAX_AGE_MS; }
}

function evictStale(): void {
  const cutoff = Date.now() - getMaxAge();
  buffer = buffer.filter((b) => new Date(b.timestamp).getTime() >= cutoff);
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  evictStale();
  buffer.push(crumb);

  const max = getMaxBreadcrumbs();
  // Enforce max count by dropping oldest
  if (buffer.length > max) {
    buffer = buffer.slice(buffer.length - max);
  }

  // Notify subscribers
  for (const fn of listeners) {
    try { fn(crumb); } catch { /* SDK must never throw */ }
  }
}

export function getBreadcrumbs(): Breadcrumb[] {
  evictStale();
  return [...buffer];
}

export function clearBreadcrumbs(): void {
  buffer = [];
  listeners = [];
}
