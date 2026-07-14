import { useState } from 'react';

interface Props {
  initialCount?: number;
  threshold?: number;
}

export function Counter({ initialCount = 0, threshold = 10 }: Props) {
  const [count, setCount] = useState(initialCount);

  const isOverThreshold = count > threshold;

  return (
    <div className="counter">
      <span data-testid="count">{count}</span>
      <button data-testid="increment" onClick={() => setCount(c => c + 1)}>+</button>
      <button data-testid="decrement" onClick={() => setCount(c => c - 1)}>-</button>
      {isOverThreshold && <span data-testid="warning">Over threshold!</span>}
    </div>
  );
}
