import { useState } from 'react';

interface Profile {
  displayName: string;
}

export function BuggyProfile() {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  if (profile === null) {
    // Render-phase throw: TypeError reading 'displayName' of null.
    return <p>{(profile as unknown as Profile).displayName.toUpperCase()}</p>;
  }
  return (
    <button data-testid="load-profile-btn" onClick={() => setProfile(null)}>
      Load profile
    </button>
  );
}
