import { describe, it, expect, afterEach } from 'vitest';
import { defaultApiUrl } from '../config.js';

describe('defaultApiUrl', () => {
  const original = process.env['OPSLANE_API_URL'];
  afterEach(() => {
    if (original === undefined) delete process.env['OPSLANE_API_URL'];
    else process.env['OPSLANE_API_URL'] = original;
  });

  it('defaults to hosted Opslane', () => {
    delete process.env['OPSLANE_API_URL'];
    expect(defaultApiUrl()).toBe('https://api.opslane.com');
  });

  it('honors OPSLANE_API_URL when set', () => {
    process.env['OPSLANE_API_URL'] = 'http://localhost:8082';
    expect(defaultApiUrl()).toBe('http://localhost:8082');
  });
});
