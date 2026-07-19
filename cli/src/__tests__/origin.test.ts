import { describe, it, expect } from 'vitest';
import { canonicalOrigin } from '../origin.js';

describe('canonicalOrigin', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalOrigin('HTTPS://API.Opslane.com')).toBe('https://api.opslane.com');
  });

  it('strips default ports but keeps explicit non-default ones', () => {
    expect(canonicalOrigin('https://api.opslane.com:443')).toBe('https://api.opslane.com');
    expect(canonicalOrigin('http://localhost:80')).toBe('http://localhost');
    expect(canonicalOrigin('http://localhost:8082')).toBe('http://localhost:8082');
  });

  it('drops path, query, and trailing slash', () => {
    expect(canonicalOrigin('https://api.opslane.com/api/v1/?x=1')).toBe('https://api.opslane.com');
  });

  it('throws on a non-URL', () => {
    expect(() => canonicalOrigin('not a url')).toThrow();
  });

  it.each(['file:///tmp/opslane', 'data:text/plain,opslane', 'ftp://api.opslane.com'])(
    'rejects non-HTTP origin %s',
    (input) => expect(() => canonicalOrigin(input)).toThrow(/http or https/),
  );
});
