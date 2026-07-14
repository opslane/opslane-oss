import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../core', () => ({ captureException: vi.fn() }));
import { captureException } from '../core';
import { OpslaneErrorBoundary } from '../react';

function Boom(): JSX.Element {
  throw new Error('render exploded');
}

describe('OpslaneErrorBoundary', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('captures a render error and shows the fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); // React logs boundary errors
    const { getByText } = render(
      <OpslaneErrorBoundary fallback={<div>something broke</div>}>
        <Boom />
      </OpslaneErrorBoundary>
    );
    expect(captureException).toHaveBeenCalledTimes(1);
    expect((captureException as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(Error);
    expect(getByText('something broke')).toBeTruthy();
    spy.mockRestore();
  });

  it('renders children when there is no error', () => {
    const { getByText } = render(
      <OpslaneErrorBoundary><span>ok</span></OpslaneErrorBoundary>
    );
    expect(getByText('ok')).toBeTruthy();
    expect(captureException).not.toHaveBeenCalled();
  });
});
