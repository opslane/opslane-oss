import { useState } from 'react';
import { BuggyProfile } from './BuggyProfile';

export function App() {
  const [view, setView] = useState('home');
  return (
    <div>
      <nav>
        <button data-testid="nav-home" onClick={() => setView('home')}>Home</button>
        <button data-testid="nav-profile" onClick={() => setView('profile')}>Profile</button>
      </nav>
      <main>
        {view === 'home' && <p>Select a bug to trigger</p>}
        {view === 'profile' && <BuggyProfile />}
      </main>
    </div>
  );
}
