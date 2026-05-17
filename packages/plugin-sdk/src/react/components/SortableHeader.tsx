import React from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';

interface SortableHeaderProps {
  /** Display label */
  label: string;
  /** Key this column sorts by (must match the object property name) */
  sortKey: string;
  /** Currently active sort key */
  currentSort: string;
  /** Current sort direction */
  dir: 'asc' | 'desc';
  /** Sort handler from useSortableTable */
  onSort: (key: string) => void;
  /** Additional inline styles for the <th> */
  style?: React.CSSProperties;
}

/**
 * Drop-in replacement for a raw <th> that adds click-to-sort with a direction indicator.
 * Pairs with the `useSortableTable` hook.
 *
 * Usage:
 *   <SortableHeader label="Name" sortKey="name" currentSort={sortKey} dir={sortDir} onSort={onSort} />
 */
export function SortableHeader({ label, sortKey, currentSort, dir, onSort, style }: SortableHeaderProps) {
  const active = currentSort === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{ cursor: 'pointer', ...style }}
    >
      {label}
      {active && (
        dir === 'asc'
          ? <ArrowUp size={12} style={{ marginLeft: 4, verticalAlign: -1, opacity: 0.7 }} />
          : <ArrowDown size={12} style={{ marginLeft: 4, verticalAlign: -1, opacity: 0.7 }} />
      )}
    </th>
  );
}
