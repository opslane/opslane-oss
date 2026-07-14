import { describe, it, expect } from 'vitest';
import { scrubUrl, scrubText, scrubEvent } from '../scrub';
import type { ErrorEventPayload } from '@opslane/shared';

describe('scrubUrl', () => {
  it('strips query string', () => {
    expect(scrubUrl('https://app.com/p?token=abc&x=1')).toBe('https://app.com/p');
  });
  it('strips userinfo credentials', () => {
    expect(scrubUrl('https://user:pass@app.com/p')).toBe('https://app.com/p');
  });
  it('blanks token-bearing hash fragments but keeps route hashes', () => {
    expect(scrubUrl('https://app.com/#access_token=xyz')).toBe('https://app.com/');
    expect(scrubUrl('https://app.com/#/users/123')).toBe('https://app.com/#/users/123');
  });
  it('best-effort strips query from non-parseable input', () => {
    expect(scrubUrl('weird://x?secret=1')).toBe('weird://x');
  });
});

describe('scrubText', () => {
  it('redacts Bearer tokens', () => {
    expect(scrubText('Authorization: Bearer ab.cd-ef')).toContain('[redacted]');
    expect(scrubText('Authorization: Bearer ab.cd-ef')).not.toContain('ab.cd-ef');
  });
  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJ';
    expect(scrubText(`token=${jwt}`)).not.toContain(jwt);
  });
  it('redacts key=value for denylisted keys', () => {
    expect(scrubText('password=hunter2 other=ok')).toContain('other=ok');
    expect(scrubText('password=hunter2')).not.toContain('hunter2');
  });
  it('leaves benign text untouched', () => {
    expect(scrubText('user clicked the save button')).toBe('user clicked the save button');
  });

  it('redacts secrets inside JSON-serialized objects (the common console case)', () => {
    expect(scrubText(JSON.stringify({ password: 'hunter2' }))).not.toContain('hunter2');
    const multi = scrubText(JSON.stringify({ user: 'a', password: 'hunter2', id: 1 }));
    expect(multi).not.toContain('hunter2');
    expect(multi).toContain('"user":"a"'); // non-secret keys preserved
    expect(multi).toContain('"id":1');
  });

  it('redacts quoted values that contain spaces', () => {
    const out = scrubText('password: "hunter2 with spaces"');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('with spaces');
  });
});

describe('scrubEvent', () => {
  it('scrubs context.url and breadcrumb urls/messages in a copy', () => {
    const event: ErrorEventPayload = {
      timestamp: 't', error: { type: 'E', message: 'boom', stack: '' },
      breadcrumbs: [{
        type: 'fetch', timestamp: 't', category: 'fetch',
        message: 'GET https://api.com/x?api_key=SECRET',
        data: { method: 'GET', url: 'https://api.com/x?api_key=SECRET', status_code: 500 },
      }],
      context: { url: 'https://app.com/p?token=abc', user_agent: 'ua' },
      sdk_version: '0.0.0',
    };
    const out = scrubEvent(event);
    expect(out.context.url).toBe('https://app.com/p');
    expect(out.breadcrumbs[0].message).not.toContain('SECRET');
    expect((out.breadcrumbs[0].data!.url as string)).toBe('https://api.com/x');
  });

  it('scrubs secrets out of error.message and error.stack', () => {
    const event: ErrorEventPayload = {
      timestamp: 't',
      error: {
        type: 'Error',
        message: 'failed to auth with token=ghp_abcdef123456',
        stack: 'Error: leaked password=hunter2\n    at fn (app.js:1:1)',
      },
      breadcrumbs: [],
      context: { url: 'https://app.com/' },
      sdk_version: '0',
    };
    const out = scrubEvent(event);
    expect(out.error.message).not.toContain('ghp_abcdef123456');
    expect(out.error.stack).not.toContain('hunter2');
  });

  it('strips query-string PII from breadcrumb messages, not just the data.url field', () => {
    const event: ErrorEventPayload = {
      timestamp: 't',
      error: { type: 'E', message: 'boom', stack: '' },
      breadcrumbs: [{
        type: 'fetch', timestamp: 't', category: 'fetch',
        message: 'GET https://api.com/x?email=user@example.com&ssn=123-45-6789',
        data: { method: 'GET', url: 'https://api.com/x?email=user@example.com', status_code: 200 },
      }],
      context: { url: 'https://app.com/' },
      sdk_version: '0',
    };
    const out = scrubEvent(event);
    expect(out.breadcrumbs[0].message).not.toContain('user@example.com');
    expect(out.breadcrumbs[0].message).not.toContain('123-45-6789');
  });

  it('does not throw when context is absent (late-bound at flush time)', () => {
    const event = {
      timestamp: 't', error: { type: 'E', message: 'boom', stack: '' },
      breadcrumbs: [], sdk_version: '0',
      context: undefined as unknown as ErrorEventPayload['context'],
    } as ErrorEventPayload;
    expect(() => scrubEvent(event)).not.toThrow();
    expect(scrubEvent(event).context).toBeUndefined();
  });
});
