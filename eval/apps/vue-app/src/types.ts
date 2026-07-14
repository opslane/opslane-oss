export interface User {
  id: string;
  name: string;
  profile: UserProfile | null;
}

export interface UserProfile {
  name: string;
  email: string;
  bio?: string;
}

export interface Item {
  id: string;
  label: string;
  active: boolean;
}
