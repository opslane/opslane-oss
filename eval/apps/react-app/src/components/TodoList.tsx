import type { Todo } from '../types';

interface Props {
  todos: Todo[];
  onToggle: (id: string) => void;
}

export function TodoList({ todos, onToggle }: Props) {
  return (
    <ul data-testid="todo-list">
      {todos.map(todo => (
        <li key={todo.id} data-testid={`todo-${todo.id}`}>
          <label>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => onToggle(todo.id)}
            />
            <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
              {todo.text}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
