import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Counter } from '../Counter';

describe('Counter', () => {
  it('increments count on click', () => {
    render(<Counter />);

    expect(screen.getByTestId('count')).toHaveTextContent('0');

    fireEvent.click(screen.getByTestId('increment'));

    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('compares threshold correctly with number', () => {
    render(<Counter initialCount={0} threshold={5} />);

    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByTestId('increment'));
    }

    expect(screen.getByTestId('count')).toHaveTextContent('6');
    expect(screen.getByTestId('warning')).toBeInTheDocument();
  });
});
