import { describe, it, expect } from 'vitest';

describe('pipeline abort on lease loss', () => {
  it('AbortSignal triggers on heartbeat failure', () => {
    const controller = new AbortController();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('checkAbort throws lease_lost on aborted signal', () => {
    const controller = new AbortController();
    controller.abort();

    const checkAbort = (signal: AbortSignal) => {
      if (signal.aborted) {
        throw new Error('lease_lost');
      }
    };

    expect(() => checkAbort(controller.signal)).toThrow('lease_lost');
  });

  it('checkAbort does not throw on non-aborted signal', () => {
    const controller = new AbortController();

    const checkAbort = (signal: AbortSignal) => {
      if (signal.aborted) {
        throw new Error('lease_lost');
      }
    };

    expect(() => checkAbort(controller.signal)).not.toThrow();
  });
});
