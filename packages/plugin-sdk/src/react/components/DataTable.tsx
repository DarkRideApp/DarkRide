import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { List, AlignJustify, StretchHorizontal, Columns, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { SkeletonTable } from './Skeleton';

export interface Column<T> {
  key: string;
  header: string;
  render?: (item: T) => ReactNode;
  sortable?: boolean;
  hideable?: boolean;
}

type Density = 'compact' | 'default' | 'spacious';

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyField: string;
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
  tableId?: string;
  testId?: string;
  loading?: boolean;
  skeletonRows?: number;
  selectable?: boolean;
  onBulkDelete?: (items: T[]) => void;
  bulkDeleteLabel?: string;
}

export function DataTable<T extends Record<string, any>>({
  columns,
  data,
  keyField,
  onRowClick,
  emptyMessage = 'No data',
  tableId,
  testId,
  loading = false,
  skeletonRows = 5,
  selectable = false,
  onBulkDelete,
  bulkDeleteLabel = 'Delete',
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // Density state — persisted to localStorage if tableId is provided
  const densityKey = tableId ? `table-density-${tableId}` : null;
  const [density, setDensity] = useState<Density>(() => {
    if (densityKey) {
      const stored = localStorage.getItem(densityKey);
      if (stored === 'compact' || stored === 'default' || stored === 'spacious') return stored;
    }
    return 'default';
  });

  // Hidden columns state — persisted to localStorage if tableId is provided
  const colsKey = tableId ? `table-cols-${tableId}` : null;
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    if (colsKey) {
      try {
        const stored = localStorage.getItem(colsKey);
        if (stored) return new Set(JSON.parse(stored));
      } catch {
        // ignore
      }
    }
    return new Set<string>();
  });

  // Column picker dropdown open/close state
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Persist density changes
  useEffect(() => {
    if (densityKey) {
      localStorage.setItem(densityKey, density);
    }
  }, [density, densityKey]);

  // Persist hidden columns changes
  useEffect(() => {
    if (colsKey) {
      localStorage.setItem(colsKey, JSON.stringify([...hiddenCols]));
    }
  }, [hiddenCols, colsKey]);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  // Clear selection when data changes
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [data]);

  const handleSort = (key: string, sortable?: boolean) => {
    if (!sortable) return;
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const toggleColumn = (key: string) => {
    setHiddenCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleRowSelection = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedKeys(prev => {
      if (prev.size === data.length) {
        return new Set();
      }
      return new Set(data.map(item => String(item[keyField])));
    });
  }, [data, keyField]);

  let sorted = [...data];
  if (sortKey) {
    sorted.sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  // Filter to visible columns
  const visibleColumns = columns.filter(col => !hiddenCols.has(col.key));
  const hideableColumns = columns.filter(col => col.hideable);
  const showSelection = selectable && onBulkDelete;
  const totalCols = visibleColumns.length + (showSelection ? 1 : 0);

  const selectedItems = showSelection
    ? data.filter(item => selectedKeys.has(String(item[keyField])))
    : [];

  if (loading) {
    return <SkeletonTable rows={skeletonRows} columns={visibleColumns.length || columns.length} />;
  }

  return (
    <div>
      {(tableId || (showSelection && selectedKeys.size > 0)) && (
        <div className="table-toolbar">
          {/* Bulk action bar */}
          {showSelection && selectedKeys.size > 0 && (
            <div className="bulk-action-bar">
              <span className="bulk-count">{selectedKeys.size} selected</span>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => onBulkDelete!(selectedItems)}
                data-testid="bulk-delete-btn"
              >
                <Trash2 size={13} />
                {bulkDeleteLabel} ({selectedKeys.size})
              </button>
            </div>
          )}

          {tableId && (
            <>
              {/* Density toggle */}
              <div className="density-toggle">
                <button
                  className={density === 'compact' ? 'active' : ''}
                  onClick={() => setDensity('compact')}
                  title="Compact"
                  aria-label="Compact density"
                >
                  <List size={14} />
                </button>
                <button
                  className={density === 'default' ? 'active' : ''}
                  onClick={() => setDensity('default')}
                  title="Default"
                  aria-label="Default density"
                >
                  <AlignJustify size={14} />
                </button>
                <button
                  className={density === 'spacious' ? 'active' : ''}
                  onClick={() => setDensity('spacious')}
                  title="Spacious"
                  aria-label="Spacious density"
                >
                  <StretchHorizontal size={14} />
                </button>
              </div>

              {/* Column picker */}
              {hideableColumns.length > 0 && (
                <div className="column-picker-wrapper" ref={pickerRef}>
                  <button
                    className={`column-picker-btn${pickerOpen ? ' active' : ''}`}
                    onClick={() => setPickerOpen(o => !o)}
                    title="Show/hide columns"
                    aria-label="Show/hide columns"
                  >
                    <Columns size={14} />
                  </button>
                  {pickerOpen && (
                    <div className="column-picker">
                      {hideableColumns.map(col => (
                        <label key={col.key} className="column-picker-item">
                          <input
                            type="checkbox"
                            checked={!hiddenCols.has(col.key)}
                            onChange={() => toggleColumn(col.key)}
                          />
                          {col.header}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <table className="data-table" data-testid={testId ?? 'data-table'} data-density={tableId ? density : undefined}>
        <thead>
          <tr>
            {showSelection && (
              <th className="select-col" style={{ width: 40, cursor: 'default' }}>
                <input
                  type="checkbox"
                  checked={data.length > 0 && selectedKeys.size === data.length}
                  onChange={toggleSelectAll}
                  title="Select all"
                  data-testid="select-all-checkbox"
                />
              </th>
            )}
            {visibleColumns.map(col => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key, col.sortable)}
                style={{ cursor: col.sortable ? 'pointer' : 'default' }}
              >
                {col.header}
                {sortKey === col.key && (
                  sortDir === 'asc'
                    ? <ArrowUp size={12} style={{ display: 'inline', marginLeft: 4, verticalAlign: 'middle' }} />
                    : <ArrowDown size={12} style={{ display: 'inline', marginLeft: 4, verticalAlign: 'middle' }} />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={totalCols} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sorted.map(item => {
              const rowKey = String(item[keyField]);
              const isSelected = selectedKeys.has(rowKey);
              return (
                <tr
                  key={rowKey}
                  className={`${onRowClick ? 'clickable-row' : ''}${isSelected ? ' selected-row' : ''}`}
                  onClick={() => onRowClick?.(item)}
                >
                  {showSelection && (
                    <td className="select-col" style={{ width: 40 }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onClick={e => toggleRowSelection(rowKey, e)}
                        onChange={() => {}}
                        data-testid={`row-select-${rowKey}`}
                      />
                    </td>
                  )}
                  {visibleColumns.map(col => (
                    <td key={col.key}>
                      {col.render ? col.render(item) : String(item[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
