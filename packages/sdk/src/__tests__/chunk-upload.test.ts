import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetChunkUploadState, flushInline, uploadChunk } from '../chunk-upload';
import { loadConfig, resetConfig } from '../config';

const ENDPOINT = 'https://ingest.example.com';

function policyResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      upload_url: 'https://storage.example.com/opslane-replays',
      form_data: { key: 'sessions/p/s/chunk-000000.json.gz', policy: 'abc', 'x-amz-signature': 'sig' },
    }),
  };
}

describe('uploadChunk', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetConfig();
    _resetChunkUploadState();
    loadConfig({ apiKey: 'test-key', endpoint: ENDPOINT });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('runs upload-url -> storage POST -> commit in order', async () => {
    fetchMock
      .mockResolvedValueOnce(policyResponse())
      .mockResolvedValueOnce({ ok: true, status: 204 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).toBe(true);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${ENDPOINT}/api/v1/sessions/sess_abc/chunks/upload-url`,
      'https://storage.example.com/opslane-replays',
      `${ENDPOINT}/api/v1/sessions/sess_abc/chunks/0/commit`,
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ seq: 0, has_full_snapshot: true });
  });

  it('declares the exact compressed byte length and appends file last', async () => {
    let declared = -1;
    let sent = -1;
    let order: string[] = [];
    fetchMock
      .mockImplementationOnce(async (_url, options) => {
        declared = JSON.parse(options.body).size_bytes;
        return policyResponse();
      })
      .mockImplementationOnce(async (_url, options) => {
        const form = options.body as FormData;
        sent = (form.get('file') as Blob).size;
        order = Array.from(form.keys());
        return { ok: true, status: 204 };
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true);
    expect(declared).toBe(sent);
    expect(order.at(-1)).toBe('file');
  });

  it('does not commit when storage fails', async () => {
    fetchMock.mockResolvedValueOnce(policyResponse()).mockResolvedValueOnce({ ok: false, status: 400 });
    expect(await uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports stop on 403 and 410', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).toBe('stop');
    _resetChunkUploadState();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 410 });
    expect(await uploadChunk('sess_abc', 1, [{ type: 2, timestamp: 1 }] as never, true)).toBe('stop');
  });

  it('never throws and skips empty chunks', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).resolves.toBe(false);
    fetchMock.mockClear();
    expect(await uploadChunk('sess_abc', 0, [] as never, true)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flushInline', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetConfig();
    _resetChunkUploadState();
    loadConfig({ apiKey: 'test-key', endpoint: ENDPOINT });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends one keepalive request with gzip inline', async () => {
    expect(await flushInline('sess_abc', 3, [{ type: 2, timestamp: 1 }] as never)).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/api/v1/sessions/sess_abc/chunks/3/inline`);
    expect(options).toMatchObject({ keepalive: true, headers: { 'Content-Type': 'application/gzip' } });
  });

  it('drops an over-budget tail and never throws', async () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => ({
      type: 3, timestamp: i, data: { text: `unique-${Math.random()}-${i}` },
    }));
    expect(await flushInline('sess_abc', 4, huge as never)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error('page gone'));
    await expect(flushInline('sess_abc', 5, [{ type: 2, timestamp: 1 }] as never)).resolves.toBe(false);
  });
});
