import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserProfile } from '../UserProfile';

describe('UserProfile', () => {
  it('renders user name when user provided', () => {
    const user = { id: '1', name: 'Alice', email: 'alice@example.com' };
    render(<UserProfile user={user} />);

    expect(screen.getByTestId('user-name')).toHaveTextContent('Alice');
    expect(screen.getByTestId('user-email')).toHaveTextContent('alice@example.com');
  });

  it('handles undefined user gracefully', () => {
    render(<UserProfile />);

    expect(screen.getByTestId('user-name')).toHaveTextContent('Unknown User');
    expect(screen.getByTestId('user-email')).toHaveTextContent('No email');
  });
});
