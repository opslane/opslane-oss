import type { User } from '../types';

interface Props {
  user?: User;
}

export function UserProfile({ user }: Props) {
  return (
    <div className="user-profile">
      <h2 data-testid="user-name">{user?.name ?? 'Unknown User'}</h2>
      <p data-testid="user-email">{user?.email ?? 'No email'}</p>
    </div>
  );
}
