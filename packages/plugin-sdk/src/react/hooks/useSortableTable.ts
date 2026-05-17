import { useState, useMemo } from 'react';

type SortDir = 'asc' | 'desc';

export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * Lightweight hook for adding client-side sorting to any table.
 *
 * Usage:
 *   const { sorted, sortKey, sortDir, onSort } = useSortableTable(data, 'name');
 *   <SortableHeader label="Name" sortKey="name" currentSort={sortKey} dir={sortDir} onSort={onSort} />
 */
export function useSortableTable<T extends Record<string, any>>(
  data: T[],
  defaultKey?: string,
  defaultDir: SortDir = 'asc',
) {
  const [sortKey, setSortKey] = useState(defaultKey ?? '');
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);

  const onSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, onSort };
}
