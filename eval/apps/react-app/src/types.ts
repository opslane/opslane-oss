export interface User {
  id: string;
  name: string;
  email?: string;
}

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

export interface Item {
  id: string;
  label: string;
  value: number;
}
