import type { Breadcrumb } from '@opslane/shared';
import { addBreadcrumb } from './breadcrumbs';
import { scrubText } from './scrub';

type ConsoleLevel = 'log' | 'warn' | 'error';

const LEVEL_MAP: Record<ConsoleLevel, Breadcrumb['level']> = {
  log: 'info',
  warn: 'warning',
  error: 'error',
};

let originals: Record<ConsoleLevel, (...args: unknown[]) => void> | null = null;

function serializeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function serializeArgs(args: unknown[]): string {
  return args.map(serializeArg).join(' ');
}

function wrapConsoleMethod(level: ConsoleLevel): (...args: unknown[]) => void {
  const original = console[level].bind(console);

  return function (...args: unknown[]): void {
    try {
      const crumb: Breadcrumb = {
        type: 'console',
        timestamp: new Date().toISOString(),
        category: `console.${level}`,
        message: scrubText(serializeArgs(args)),
        level: LEVEL_MAP[level],
      };
      addBreadcrumb(crumb);
    } catch {
      // SDK must never throw
    }

    original(...args);
  };
}

export function patchConsole(): void {
  if (originals) return; // already patched

  originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  console.log = wrapConsoleMethod('log');
  console.warn = wrapConsoleMethod('warn');
  console.error = wrapConsoleMethod('error');
}

export function unpatchConsole(): void {
  if (!originals) return;

  console.log = originals.log;
  console.warn = originals.warn;
  console.error = originals.error;

  originals = null;
}
