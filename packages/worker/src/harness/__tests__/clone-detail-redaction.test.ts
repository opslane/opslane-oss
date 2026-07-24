import { describe, expect, it } from 'vitest';
import { redactCloneDetail } from '../redact.js';

describe('redactCloneDetail', () => {
  it('scrubs an x-access-token credential', () => {
    const output = redactCloneDetail(
      'fatal: https://x-access-token:ghs_SECRET@github.com/o/r.git not found',
    );
    expect(output).not.toContain('ghs_SECRET');
    expect(output).toContain('***@');
  });

  it('scrubs a bare userinfo credential', () => {
    expect(
      redactCloneDetail('https://user:pw@example.com/x'),
    ).not.toContain('pw@');
  });

  it('truncates adversarially long output', () => {
    const output = redactCloneDetail('x'.repeat(10_000));
    expect(output.length).toBeLessThan(2_100);
    expect(output).toContain('truncated');
  });

  it('keeps useful git failure detail', () => {
    expect(
      redactCloneDetail(
        'fatal: Remote branch main not found in upstream origin',
      ),
    ).toContain('Remote branch main not found');
  });
});
