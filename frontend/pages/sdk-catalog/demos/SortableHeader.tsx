import { SortableHeader, StatusBadge, useSortableTable } from '@darkrideapp/plugin-sdk/react';

interface Row { id: string; name: string; status: string; count: number }

const MOCK_ROWS: Row[] = [
  { id: '1', name: 'Session A', status: 'online', count: 42 },
  { id: '2', name: 'Session B', status: 'offline', count: 7 },
  { id: '3', name: 'Session C', status: 'running', count: 128 },
];

export default function SortableHeaderDemo() {
  const { sorted: sortedRows, sortKey, sortDir, onSort: handleSort } = useSortableTable(MOCK_ROWS, 'name');
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 14, minWidth: 300 }}>
      <thead>
        <tr>
          <SortableHeader label="Name"  sortKey="name"  currentSort={sortKey} dir={sortDir} onSort={handleSort} />
          <SortableHeader label="Count" sortKey="count" currentSort={sortKey} dir={sortDir} onSort={handleSort} />
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {sortedRows.map(r => (
          <tr key={r.id}>
            <td style={{ padding: '4px 8px' }}>{r.name}</td>
            <td style={{ padding: '4px 8px' }}>{r.count}</td>
            <td style={{ padding: '4px 8px' }}><StatusBadge status={r.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
