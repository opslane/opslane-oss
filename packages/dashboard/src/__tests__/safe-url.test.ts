import { describe, expect, it } from 'vitest';
import { GITHUB_PR_URL_OPTIONS, safeUrl } from '../utils';

describe('safeUrl — default (permissive) mode', () => {
  it('accepts https', () => {
    expect(safeUrl('https://example.test/a')).toBe('https://example.test/a');
  });

  it('still accepts http, which AdminView trace links depend on', () => {
    expect(safeUrl('http://langfuse.internal:3000/trace/abc'))
      .toBe('http://langfuse.internal:3000/trace/abc');
  });

  it('rejects javascript:', () => expect(safeUrl('javascript:alert(1)')).toBeUndefined());
  it('rejects data:', () => expect(safeUrl('data:text/html,<script>')).toBeUndefined());
  it('rejects a malformed URL', () => expect(safeUrl('not a url')).toBeUndefined());
  it('returns undefined for undefined', () => expect(safeUrl(undefined)).toBeUndefined());
  it('returns undefined for empty string', () => expect(safeUrl('')).toBeUndefined());

  it('rejects credentials in the authority even in permissive mode', () => {
    expect(safeUrl('https://github.com@evil.example/a')).toBeUndefined();
  });
});

describe('safeUrl — GitHub PR mode', () => {
  const check = (url: string | undefined) => safeUrl(url, GITHUB_PR_URL_OPTIONS);

  it('accepts an https github.com pull request URL', () => {
    expect(check('https://github.com/acme/web/pull/42'))
      .toBe('https://github.com/acme/web/pull/42');
  });

  it('accepts the www host', () => {
    expect(check('https://www.github.com/acme/web/pull/42')).toBeDefined();
  });

  it('is case-insensitive about the host', () => {
    expect(check('https://GitHub.com/acme/web/pull/42')).toBeDefined();
  });

  it('rejects an attacker domain starting with "github."', () => {
    expect(check('https://github.evil.com/acme/web/pull/42')).toBeUndefined();
  });

  it('rejects an attacker domain starting with "github.com."', () => {
    expect(check('https://github.com.evil.example/acme/web/pull/42')).toBeUndefined();
  });

  it('rejects a lookalike suffix host', () => {
    expect(check('https://notgithub.com/acme/web/pull/42')).toBeUndefined();
  });

  it('rejects a valid https URL on a non-allowlisted host', () => {
    expect(check('https://gitlab.com/acme/web/-/merge_requests/42')).toBeUndefined();
  });

  it('rejects plain http even on an allowlisted host', () => {
    expect(check('http://github.com/acme/web/pull/42')).toBeUndefined();
  });

  it('rejects javascript: on an allowlisted-looking string', () => {
    expect(check('javascript:alert(1)')).toBeUndefined();
  });
});
