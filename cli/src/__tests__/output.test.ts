import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonOutput, exitWithError, exitWithStatus } from '../output.js';

describe('jsonOutput', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  it('prints JSON to stdout', () => {
    jsonOutput({ status: 'ok' });
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ status: 'ok' }, null, 2));
  });

  it('exitWithError prints error JSON and exits with code 1', () => {
    exitWithError('something failed');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"error"')
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exitWithStatus prints a status-shaped body and exits with the given code', () => {
    exitWithStatus('expired', { message: 'm' }, 1);
    const printed = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(JSON.parse(printed)).toEqual({ status: 'expired', message: 'm' });
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exitWithStatus can exit 0 for non-error terminal states', () => {
    exitWithStatus('pending', {}, 0);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
