import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MultiFileParent } from '../MultiFileParent';

describe('MultiFileParent', () => {
  it('renders child with correct props', () => {
    render(<MultiFileParent userName="Alice" userRole="Admin" />);

    expect(screen.getByTestId('parent-title')).toHaveTextContent('User Info');
    expect(screen.getByTestId('child-name')).toHaveTextContent('Alice');
    expect(screen.getByTestId('child-role')).toHaveTextContent('Admin');
  });

  it('passes name prop correctly to child', () => {
    render(<MultiFileParent userName="Bob" userRole="Viewer" />);

    expect(screen.getByTestId('child-name')).toHaveTextContent('Bob');
  });
});
