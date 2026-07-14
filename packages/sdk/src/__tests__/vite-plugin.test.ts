import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { opslaneSourceMapPlugin } from '../../vite-plugin/index';

describe('Vite Source Map Plugin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return a valid Vite plugin object', () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    expect(plugin.name).toBe('opslane-source-map');
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('post');
    expect(typeof plugin.generateBundle).toBe('function');
    expect(typeof plugin.closeBundle).toBe('function');
  });

  it('should enable source maps in config', () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    const config = (plugin as any).config();
    expect(config.build.sourcemap).toBe('hidden');
  });

  it('should collect .map files in generateBundle and remove them from output', () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    const bundle: Record<string, any> = {
      'assets/index-abc123.js': {
        type: 'chunk',
        code: 'console.log("hello")',
        fileName: 'assets/index-abc123.js',
      },
      'assets/index-abc123.js.map': {
        type: 'asset',
        source: '{"mappings":"AAAA"}',
        fileName: 'assets/index-abc123.js.map',
      },
      'assets/vendor-def456.js': {
        type: 'chunk',
        code: 'var x = 1;',
        fileName: 'assets/vendor-def456.js',
      },
      'assets/vendor-def456.js.map': {
        type: 'asset',
        source: '{"mappings":"BBBB"}',
        fileName: 'assets/vendor-def456.js.map',
      },
    };

    // Call generateBundle
    (plugin.generateBundle as Function).call(plugin, {}, bundle);

    // .map files should be removed from the bundle
    expect(bundle['assets/index-abc123.js.map']).toBeUndefined();
    expect(bundle['assets/vendor-def456.js.map']).toBeUndefined();
    // JS files should remain
    expect(bundle['assets/index-abc123.js']).toBeDefined();
    expect(bundle['assets/vendor-def456.js']).toBeDefined();
  });

  it('should upload each source map individually via multipart FormData on closeBundle', async () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
      release: 'v1.0.0',
    });

    const bundle: Record<string, any> = {
      'assets/index-abc123.js.map': {
        type: 'asset',
        source: '{"mappings":"AAAA"}',
        fileName: 'assets/index-abc123.js.map',
      },
      'assets/vendor-def456.js.map': {
        type: 'asset',
        source: '{"mappings":"BBBB"}',
        fileName: 'assets/vendor-def456.js.map',
      },
    };

    (plugin.generateBundle as Function).call(plugin, {}, bundle);
    await (plugin.closeBundle as Function).call(plugin);

    // One request per source map file
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe('https://ingest.example.com/api/v1/sourcemaps');
      expect(options.method).toBe('POST');
      expect(options.headers['X-API-Key']).toBe('key-sm');
      // Body should be FormData (no Content-Type header set manually — browser sets it with boundary)
      expect(options.body).toBeInstanceOf(FormData);
    }
  });

  it('should not upload if no source maps were collected', async () => {
    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    await (plugin.closeBundle as Function).call(plugin);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses VITE_OPSLANE_RELEASE when no release option is given', async () => {
    const prev = process.env.VITE_OPSLANE_RELEASE;
    process.env.VITE_OPSLANE_RELEASE = 'sha-abc123';
    const plugin = opslaneSourceMapPlugin({ endpoint: 'https://i.com', apiKey: 'k' });
    const bundle: Record<string, any> = {
      'a.js.map': { type: 'asset', source: '{}', fileName: 'a.js.map' },
    };
    (plugin.generateBundle as Function).call(plugin, {}, bundle);
    await (plugin.closeBundle as Function).call(plugin);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('release')).toBe('sha-abc123');
    process.env.VITE_OPSLANE_RELEASE = prev;
  });

  it('warns loudly and does NOT upload when no release is set', async () => {
    const prev = process.env.VITE_OPSLANE_RELEASE;
    delete process.env.VITE_OPSLANE_RELEASE;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = opslaneSourceMapPlugin({ endpoint: 'https://i.com', apiKey: 'k' });
    const bundle: Record<string, any> = {
      'a.js.map': { type: 'asset', source: '{}', fileName: 'a.js.map' },
    };
    (plugin.generateBundle as Function).call(plugin, {}, bundle);
    await (plugin.closeBundle as Function).call(plugin);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('VITE_OPSLANE_RELEASE'));
    warn.mockRestore();
    process.env.VITE_OPSLANE_RELEASE = prev;
  });

  it('should log a warning on upload failure but not throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('upload failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plugin = opslaneSourceMapPlugin({
      endpoint: 'https://ingest.example.com',
      apiKey: 'key-sm',
    });

    const bundle: Record<string, any> = {
      'assets/index.js.map': {
        type: 'asset',
        source: '{}',
        fileName: 'assets/index.js.map',
      },
    };

    (plugin.generateBundle as Function).call(plugin, {}, bundle);

    // Should not throw
    await expect(
      (plugin.closeBundle as Function).call(plugin)
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[opslane]')
    );

    warnSpy.mockRestore();
  });
});
