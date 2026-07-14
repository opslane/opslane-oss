import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FetchData } from '../FetchData';

describe('FetchData', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders fetched data', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('Hello World'),
    });

    render(<FetchData url="/api/data" />);

    expect(screen.getByTestId('loading')).toHaveTextContent('Loading...');

    await waitFor(() => {
      expect(screen.getByTestId('data')).toHaveTextContent('Hello World');
    });
  });

  it('handles URL change correctly', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('First response'),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('Second response'),
      });

    const { rerender } = render(<FetchData url="/api/first" />);

    await waitFor(() => {
      expect(screen.getByTestId('data')).toHaveTextContent('First response');
    });

    rerender(<FetchData url="/api/second" />);

    await waitFor(() => {
      expect(screen.getByTestId('data')).toHaveTextContent('Second response');
    });
  });

  it('aborts previous fetch on URL change', async () => {
    let resolveFirst: (v: unknown) => void;
    const firstFetch = new Promise(r => { resolveFirst = r; });

    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockImplementationOnce((_url: string, opts?: { signal?: AbortSignal }) => {
        // Return a promise that resolves after we check the signal
        return firstFetch.then(() => {
          // If signal exists and is aborted, throw AbortError (real fetch behavior)
          if (opts?.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          return { ok: true, text: () => Promise.resolve('First') };
        });
      })
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, text: () => Promise.resolve('Second') }),
      );

    const { rerender } = render(<FetchData url="/api/first" />);

    // First fetch was called with a signal
    const firstCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[1]).toHaveProperty('signal');
    const signal = firstCall[1].signal as AbortSignal;

    // Change URL before first fetch resolves — should abort the first
    rerender(<FetchData url="/api/second" />);
    expect(signal.aborted).toBe(true);

    // Let first fetch resolve (it will throw AbortError, which is caught)
    resolveFirst!(undefined);

    await waitFor(() => {
      expect(screen.getByTestId('data')).toHaveTextContent('Second');
    });
  });
});
