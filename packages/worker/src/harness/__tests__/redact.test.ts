import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../redact.js';

describe('scrubSecrets', () => {
  it('scrubs credentials embedded in URLs', () => {
    expect(scrubSecrets('cloning https://x-access-token:ghs_abc@github.com/o/r.git'))
      .toBe('cloning https://***@github.com/o/r.git');
  });

  it('scrubs GitHub and Anthropic tokens', () => {
    expect(scrubSecrets('ghp_abc123 and github_pat_11AAA_bb and sk-ant-api03-xyz'))
      .toBe('[REDACTED] and [REDACTED] and [REDACTED]');
  });

  it('leaves clean text alone and does not truncate', () => {
    const long = 'a'.repeat(10_000);
    expect(scrubSecrets(long)).toBe(long);
  });
});
