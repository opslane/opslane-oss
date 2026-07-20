import type { LocationQuery, LocationQueryRaw } from 'vue-router';

export interface ProjectSelection {
  id: string;
  name: string;
}

type ProjectStorage = Pick<Storage, 'setItem' | 'removeItem'>;

const PROJECT_QUERY_KEYS = [
  'project_id',
  'environment_id',
  'account_id',
  'end_user_id',
  'status',
] as const;

export function shouldSwitchProject(
  selectedProjectId: string,
  activeProjectId: string,
  switching: boolean,
): boolean {
  return !!selectedProjectId && selectedProjectId !== activeProjectId && !switching;
}

export function applyProjectSelection(storage: ProjectStorage, project: ProjectSelection): void {
  storage.setItem('opslane_project_id', project.id);
  storage.setItem('opslane_project_name', project.name);
  storage.removeItem('opslane_environment_id');
  storage.removeItem('opslane_account_id');
}

export function projectSwitchQuery(query: Readonly<LocationQuery>): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query };
  for (const key of PROJECT_QUERY_KEYS) delete next[key];
  return next;
}
