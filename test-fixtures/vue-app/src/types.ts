export interface UserProfile {
  name: string;
  email: string;
}

export interface User {
  id: number;
  username: string;
  profile: UserProfile | null; // BUG TRIGGER: profile can be null
}
