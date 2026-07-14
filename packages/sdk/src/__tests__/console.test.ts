import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { patchConsole, unpatchConsole } from '../console';
import { clearBreadcrumbs, getBreadcrumbs } from '../breadcrumbs';

describe('Console Patcher', () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  beforeEach(() => {
    clearBreadcrumbs();
  });

  afterEach(() => {
    unpatchConsole();
    clearBreadcrumbs();
    // Restore originals in case unpatch failed
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it('should add a breadcrumb for console.log', () => {
    patchConsole();
    console.log('hello', 'world');

    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].type).toBe('console');
    expect(crumbs[0].category).toBe('console.log');
    expect(crumbs[0].message).toBe('hello world');
    expect(crumbs[0].level).toBe('info');
  });

  it('should add a breadcrumb for console.warn', () => {
    patchConsole();
    console.warn('be careful');

    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].category).toBe('console.warn');
    expect(crumbs[0].message).toBe('be careful');
    expect(crumbs[0].level).toBe('warning');
  });

  it('should add a breadcrumb for console.error', () => {
    patchConsole();
    console.error('something broke');

    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].category).toBe('console.error');
    expect(crumbs[0].message).toBe('something broke');
    expect(crumbs[0].level).toBe('error');
  });

  it('should still call the original console methods', () => {
    const origLog = vi.fn();
    console.log = origLog;

    patchConsole();
    console.log('test');

    expect(origLog).toHaveBeenCalledWith('test');
  });

  it('should serialize object arguments to JSON', () => {
    patchConsole();
    console.log('user:', { name: 'Alice', id: 1 });

    const crumbs = getBreadcrumbs();
    expect(crumbs[0].message).toBe('user: {"name":"Alice","id":1}');
  });

  it('should handle circular references gracefully', () => {
    patchConsole();
    const obj: any = { a: 1 };
    obj.self = obj;
    console.log('circular:', obj);

    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(1);
    // Should not throw; message should contain something reasonable
    expect(crumbs[0].message).toContain('circular:');
  });

  it('should restore original console methods on unpatch', () => {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    patchConsole();
    unpatchConsole();

    expect(console.log).toBe(origLog);
    expect(console.warn).toBe(origWarn);
    expect(console.error).toBe(origError);
  });

  it('should never throw even if breadcrumb adding fails', () => {
    patchConsole();
    // This should not throw regardless of internal state
    expect(() => console.log('safe')).not.toThrow();
  });

  it('redacts secrets from captured console args', () => {
    patchConsole();
    console.log('logging in with password=hunter2');

    const crumbs = getBreadcrumbs();
    expect(crumbs[0].message).not.toContain('hunter2');
    expect(crumbs[0].message).toContain('[redacted]');
  });
});
