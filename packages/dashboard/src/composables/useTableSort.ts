import { ref, computed, type Ref } from 'vue';

type SortDir = 'asc' | 'desc';

export function useTableSort<K extends string, T>(
  items: Ref<T[]>,
  defaultKey: K,
  comparators: Record<K, (a: T, b: T) => number>,
  defaultDirForKey?: (key: K) => SortDir,
) {
  const sortKey = ref<K>(defaultKey) as Ref<K>;
  const sortDir = ref<SortDir>(defaultDirForKey?.(defaultKey) ?? 'desc');

  /*
   * DIRECTION INVERSION — read before writing a comparator.
   *
   *   toggleSort(newKey) ──► sortDir = 'desc'   (default for any newly-picked key)
   *                              │
   *   sorted = [...items].sort((a,b) => comparators[key](a,b) * dir)
   *                                                              │
   *                                        dir = 'asc' ? 1 : -1 ─┘
   *
   * So the FIRST click on a column renders your comparator NEGATED.
   * Write each comparator in its natural ascending sense and let the default
   * 'desc' invert it; do not pre-invert inside the comparator.
   */
  const sorted = computed(() => {
    const dir = sortDir.value === 'asc' ? 1 : -1;
    return [...items.value].sort((a, b) => comparators[sortKey.value](a, b) * dir);
  });

  function toggleSort(key: K): void {
    if (sortKey.value === key) {
      sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey.value = key;
      sortDir.value = defaultDirForKey?.(key) ?? 'desc';
    }
  }

  function sortIndicator(key: K): string {
    if (sortKey.value !== key) return '';
    return sortDir.value === 'asc' ? ' \u2191' : ' \u2193';
  }

  /** For `<th aria-sort>`. Screen readers announce the active column and direction. */
  function ariaSort(key: K): 'ascending' | 'descending' | 'none' {
    if (sortKey.value !== key) return 'none';
    return sortDir.value === 'asc' ? 'ascending' : 'descending';
  }

  return { sortKey, sortDir, sorted, toggleSort, sortIndicator, ariaSort };
}
