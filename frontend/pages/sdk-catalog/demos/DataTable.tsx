import { DataTable, StatusBadge } from '@darkrideapp/plugin-sdk/react';
import type { Column } from '@darkrideapp/plugin-sdk/react';

interface Row { id: string; name: string; status: string; count: number }

const MOCK_ROWS: Row[] = [
  { id: '1', name: 'Session A', status: 'online', count: 42 },
  { id: '2', name: 'Session B', status: 'offline', count: 7 },
  { id: '3', name: 'Session C', status: 'running', count: 128 },
];

const MOCK_COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  { key: 'count', header: 'Count', sortable: true },
];

export default function DataTableDemo() {
  return (
    <DataTable<Row>
      columns={MOCK_COLUMNS}
      data={MOCK_ROWS}
      keyField="id"
      tableId="sdk-catalog-demo"
      emptyMessage="No sessions found"
    />
  );
}
