import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonOutput, exitWithError } from '../output.js';

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
});
