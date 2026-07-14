import { useState } from 'react';
import type { Item } from '../types';

interface Props {
  items: Item[];
  onSelect?: (item: Item) => void;
}

export function ItemFilter({ items, onSelect }: Props) {
  const [filter, setFilter] = useState('');

  const filtered = items.filter(item =>
    item.label.toLowerCase().includes(filter.toLowerCase())
  );

  function handleSelect(item: Item) {
    try {
      onSelect?.(item);
    } catch (err: unknown) {
      console.error('Selection handler error:', err);
    }
  }

  return (
    <div className="item-filter">
      <input
        data-testid="filter-input"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter..."
      />
      <ul>
        {filtered.map(item => (
          <li key={item.id} data-testid={`item-${item.id}`}>
            <button onClick={() => handleSelect(item)}>{item.label}</button>
          </li>
        ))}
      </ul>
      {filtered.length === 0 && <p data-testid="no-results">No items match</p>}
    </div>
  );
}
