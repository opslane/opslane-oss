import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TodoList } from '../TodoList';
import type { Todo } from '../../types';

describe('TodoList', () => {
  const todos: Todo[] = [
    { id: '1', text: 'Buy milk', completed: false },
    { id: '2', text: 'Write tests', completed: true },
    { id: '3', text: 'Ship code', completed: false },
  ];

  it('renders todos with correct text', () => {
    const onToggle = vi.fn();
    render(<TodoList todos={todos} onToggle={onToggle} />);

    expect(screen.getByTestId('todo-1')).toHaveTextContent('Buy milk');
    expect(screen.getByTestId('todo-2')).toHaveTextContent('Write tests');
    expect(screen.getByTestId('todo-3')).toHaveTextContent('Ship code');
  });

  it('maintains correct state after toggle', () => {
    const onToggle = vi.fn();
    render(<TodoList todos={todos} onToggle={onToggle} />);

    const checkbox = screen.getByTestId('todo-1').querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(onToggle).toHaveBeenCalledWith('1');
  });
});
