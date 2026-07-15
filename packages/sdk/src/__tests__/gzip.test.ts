// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { gzip, gzipSupported } from '../gzip';

describe('gzip', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports support when CompressionStream exists', () => {
    expect(gzipSupported()).toBe(true);
  });

  it('produces real gzip that inflates back to the input', async () => {
    const original = JSON.stringify({ events: Array.from({ length: 50 }, (_, i) => ({ type: 3, i })) });
    const out = await gzip(original);
    expect(gunzipSync(Buffer.from(out!)).toString('utf8')).toBe(original);
    expect(out?.[0]).toBe(0x1f);
    expect(out?.[1]).toBe(0x8b);
  });

  it('compresses repetitive rrweb-like payloads', async () => {
    const original = JSON.stringify({ events: Array.from({ length: 500 }, () => ({ type: 3, data: { source: 2, x: 1, y: 2 } })) });
    expect((await gzip(original))!.byteLength).toBeLessThan(original.length / 5);
  });

  it('handles unicode without corruption', async () => {
    const original = JSON.stringify({ text: 'héllo 世界 🎉' });
    expect(gunzipSync(Buffer.from((await gzip(original))!)).toString('utf8')).toBe(original);
  });

  it('returns null when CompressionStream is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    expect(gzipSupported()).toBe(false);
    expect(await gzip('{"a":1}')).toBeNull();
  });

  it('returns null rather than throwing when compression fails', async () => {
    vi.stubGlobal('CompressionStream', class { constructor() { throw new Error('boom'); } });
    expect(await gzip('{"a":1}')).toBeNull();
  });
});
