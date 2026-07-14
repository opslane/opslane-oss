import type { User } from './types';

export async function fetchUser(id: string): Promise<Response> {
  return fetch(`/api/users/${id}`);
}

export async function fetchItems(): Promise<Response> {
  return fetch('/api/items');
}
