export async function fetchUser(id: string): Promise<Response> {
  return fetch(`/api/users/${id}`);
}

export async function fetchTodos(): Promise<Response> {
  return fetch('/api/todos');
}
