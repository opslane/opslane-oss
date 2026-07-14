import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ItemFilter } from '../ItemFilter';
import type { Item } from '../../types';

describe('ItemFilter', () => {
  const items: Item[] = [
    { id: '1', label: 'Apple', value: 1 },
    { id: '2', label: 'Banana', value: 2 },
    { id: '3', label: 'Cherry', value: 3 },
  ];

  it('filters items by label', () => {
    render(<ItemFilter items={items} />);

    expect(screen.getByTestId('item-1')).toBeInTheDocument();
    expect(screen.getByTestId('item-2')).toBeInTheDocument();
    expect(screen.getByTestId('item-3')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('filter-input'), {
      target: { value: 'ban' },
    });

    expect(screen.queryByTestId('item-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('item-2')).toBeInTheDocument();
    expect(screen.queryByTestId('item-3')).not.toBeInTheDocument();
  });

  it('handles throwing onSelect gracefully', () => {
    const throwingHandler = vi.fn(() => {
      throw new Error('Handler exploded');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ItemFilter items={items} onSelect={throwingHandler} />);

    fireEvent.click(screen.getByText('Apple'));

    expect(throwingHandler).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      'Selection handler error:',
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});
