import { onMounted, ref, toValue, watch, type MaybeRef } from 'vue';
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw } from 'vue-router';

import { listEnvironments, type Environment } from '../api';

export const ENVIRONMENT_STORAGE_KEY = 'opslane_environment_id';

type QueryValue = string | null | undefined | Array<string | null>;
type EnvironmentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function initialEnvironmentId(queryValue: QueryValue, storedValue: string | null): string {
  const value = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  return value || storedValue || '';
}

export function environmentFilterQuery(
  currentQuery: Readonly<LocationQuery>,
  environmentId: string,
): LocationQueryRaw {
  const query: LocationQueryRaw = { ...currentQuery };
  if (environmentId) query['environment_id'] = environmentId;
  else delete query['environment_id'];
  return query;
}

export function persistEnvironmentId(storage: EnvironmentStorage, environmentId: string): void {
  if (environmentId) storage.setItem(ENVIRONMENT_STORAGE_KEY, environmentId);
  else storage.removeItem(ENVIRONMENT_STORAGE_KEY);
}

export function useEnvironmentFilter(projectId: MaybeRef<string>) {
  const route = useRoute();
  const router = useRouter();
  const environments = ref<Environment[]>([]);
  const rollupReady = ref(false);
  const loading = ref(false);
  let loadGeneration = 0;
  const selectedEnvironmentId = ref(initialEnvironmentId(
    route.query['environment_id'],
    localStorage.getItem(ENVIRONMENT_STORAGE_KEY),
  ));

  function syncSelection(environmentId: string): void {
    persistEnvironmentId(localStorage, environmentId);
    void router.replace({ query: environmentFilterQuery(route.query, environmentId) });
  }

  function clear(): void {
    selectedEnvironmentId.value = '';
    syncSelection('');
  }

  async function loadOptions(): Promise<void> {
    const id = toValue(projectId);
    const generation = ++loadGeneration;
    if (!id) {
      environments.value = [];
      rollupReady.value = false;
      return;
    }
    loading.value = true;
    try {
      const response = await listEnvironments(id);
      if (generation !== loadGeneration || id !== toValue(projectId)) return;
      environments.value = response.environments;
      rollupReady.value = response.rollup_ready;
      if (selectedEnvironmentId.value &&
          !response.environments.some((environment) => environment.id === selectedEnvironmentId.value)) {
        clear();
      }
    } catch {
      if (generation !== loadGeneration || id !== toValue(projectId)) return;
      environments.value = [];
      rollupReady.value = false;
    } finally {
      if (generation === loadGeneration) loading.value = false;
    }
  }

  watch(selectedEnvironmentId, syncSelection);
  watch(
    () => toValue(projectId),
    (next, previous) => {
      if (previous && next !== previous) clear();
      void loadOptions();
    },
  );
  onMounted(() => { void loadOptions(); });

  return {
    clear,
    environments,
    loading,
    loadOptions,
    rollupReady,
    selectedEnvironmentId,
  };
}
