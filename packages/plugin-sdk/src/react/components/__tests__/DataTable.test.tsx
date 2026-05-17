import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DataTable } from '../DataTable';
import type { Column } from '../DataTable';

interface TestItem {
  id: string;
  name: string;
  status: string;
}

const testData: TestItem[] = [
  { id: '1', name: 'Alpha', status: 'active' },
  { id: '2', name: 'Beta', status: 'inactive' },
  { id: '3', name: 'Gamma', status: 'active' },
];

const testColumns: Column<TestItem>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'status', header: 'Status', sortable: true, hideable: true },
];

beforeEach(() => {
  localStorage.clear();
});

describe('DataTable — loading states', () => {
  it('renders SkeletonTable when loading is true', () => {
    const { container } = render(
      <DataTable columns={testColumns} data={[]} keyField="id" loading={true} />
    );
    expect(container.querySelector('.skeleton-table')).toBeInTheDocument();
    expect(screen.queryByTestId('data-table')).not.toBeInTheDocument();
  });

  it('renders configurable number of skeleton rows', () => {
    const { container } = render(
      <DataTable columns={testColumns} data={[]} keyField="id" loading={true} skeletonRows={8} />
    );
    const rows = container.querySelectorAll('.skeleton-table-row');
    expect(rows).toHaveLength(8);
  });

  it('skeleton has correct number of columns', () => {
    const { container } = render(
      <DataTable columns={testColumns} data={[]} keyField="id" loading={true} />
    );
    const headerCells = container.querySelectorAll('.skeleton-table-header > div');
    expect(headerCells).toHaveLength(2);
  });

  it('renders actual table when loading is false', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" loading={false} />
    );
    expect(screen.getByTestId('data-table')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

describe('DataTable — hover feedback (CSS class application)', () => {
  it('applies clickable-row class when onRowClick is provided', () => {
    const onClick = vi.fn();
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" onRowClick={onClick} />
    );
    const table = screen.getByTestId('data-table');
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(row => {
      expect(row.className).toContain('clickable-row');
    });
  });

  it('does NOT apply clickable-row class when no onRowClick', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" />
    );
    const table = screen.getByTestId('data-table');
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(row => {
      expect(row.className).not.toContain('clickable-row');
    });
  });

  it('calls onRowClick handler when row is clicked', () => {
    const onClick = vi.fn();
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" onRowClick={onClick} />
    );
    fireEvent.click(screen.getByText('Alpha'));
    expect(onClick).toHaveBeenCalledWith(testData[0]);
  });
});

describe('DataTable — selection (checkbox)', () => {
  it('renders select-all checkbox in header when selectable', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );
    expect(screen.getByTestId('select-all-checkbox')).toBeInTheDocument();
  });

  it('renders per-row checkboxes when selectable', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );
    expect(screen.getByTestId('row-select-1')).toBeInTheDocument();
    expect(screen.getByTestId('row-select-2')).toBeInTheDocument();
    expect(screen.getByTestId('row-select-3')).toBeInTheDocument();
  });

  it('individual row selection toggles checked state', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );
    const checkbox = screen.getByTestId('row-select-1') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it('select-all selects all rows, then deselects all', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );
    const selectAll = screen.getByTestId('select-all-checkbox') as HTMLInputElement;
    // toggleSelectAll checks if prev.size === data.length; clicking when none selected → selects all
    fireEvent.click(selectAll);

    // All rows selected
    expect((screen.getByTestId('row-select-1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('row-select-2') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('row-select-3') as HTMLInputElement).checked).toBe(true);

    // Deselect all
    fireEvent.click(selectAll);
    expect((screen.getByTestId('row-select-1') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('row-select-2') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('row-select-3') as HTMLInputElement).checked).toBe(false);
  });

  it('applies selected-row class on selected rows', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );
    const checkbox = screen.getByTestId('row-select-1');
    fireEvent.click(checkbox);

    const row = checkbox.closest('tr')!;
    expect(row.className).toContain('selected-row');
  });

  it('clears selection when data changes', () => {
    const { rerender } = render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );

    fireEvent.click(screen.getByTestId('row-select-1'));
    expect((screen.getByTestId('row-select-1') as HTMLInputElement).checked).toBe(true);

    // Re-render with new data
    const newData = [{ id: '4', name: 'Delta', status: 'active' }];
    rerender(
      <DataTable columns={testColumns} data={newData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );
    expect(screen.getByTestId('row-select-4')).toBeInTheDocument();
    expect((screen.getByTestId('row-select-4') as HTMLInputElement).checked).toBe(false);
  });
});

describe('DataTable — bulk actions', () => {
  it('shows bulk action bar with count when rows are selected', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('row-select-1'));
    fireEvent.click(screen.getByTestId('row-select-2'));

    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-delete-btn')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-delete-btn')).toHaveTextContent('Delete (2)');
  });

  it('hides bulk action bar when no rows selected', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} />
    );
    expect(screen.queryByTestId('bulk-delete-btn')).not.toBeInTheDocument();
  });

  it('calls onBulkDelete with selected items', () => {
    const onBulkDelete = vi.fn();
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={onBulkDelete} />
    );
    fireEvent.click(screen.getByTestId('row-select-1'));
    fireEvent.click(screen.getByTestId('row-select-3'));

    fireEvent.click(screen.getByTestId('bulk-delete-btn'));
    expect(onBulkDelete).toHaveBeenCalledWith([testData[0], testData[2]]);
  });

  it('uses custom bulkDeleteLabel', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" selectable onBulkDelete={vi.fn()} bulkDeleteLabel="Remove" />
    );
    fireEvent.click(screen.getByTestId('row-select-1'));
    expect(screen.getByTestId('bulk-delete-btn')).toHaveTextContent('Remove (1)');
  });
});

describe('DataTable — sorting', () => {
  it('sorts ascending then descending on column header click', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" />
    );
    const nameHeader = screen.getByText('Name');
    fireEvent.click(nameHeader);

    // Default asc: Alpha, Beta, Gamma
    const table = screen.getByTestId('data-table');
    let cells = table.querySelectorAll('tbody tr td:first-child');
    expect(cells[0].textContent).toBe('Alpha');
    expect(cells[2].textContent).toBe('Gamma');

    // Click again for desc
    fireEvent.click(nameHeader);
    cells = table.querySelectorAll('tbody tr td:first-child');
    expect(cells[0].textContent).toBe('Gamma');
    expect(cells[2].textContent).toBe('Alpha');
  });
});

describe('DataTable — density and column visibility', () => {
  it('renders density toggle buttons when tableId provided', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" tableId="test-table" />
    );
    expect(screen.getByTitle('Compact')).toBeInTheDocument();
    expect(screen.getByTitle('Default')).toBeInTheDocument();
    expect(screen.getByTitle('Spacious')).toBeInTheDocument();
  });

  it('persists density to localStorage', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" tableId="test-table" />
    );
    fireEvent.click(screen.getByTitle('Compact'));
    expect(localStorage.getItem('table-density-test-table')).toBe('compact');
  });

  it('column picker hides/shows columns', () => {
    render(
      <DataTable columns={testColumns} data={testData} keyField="id" tableId="test-table" />
    );
    // Open column picker
    fireEvent.click(screen.getByTitle('Show/hide columns'));

    // Uncheck Status column
    const statusCheckbox = screen.getByLabelText('Status');
    fireEvent.click(statusCheckbox);

    // Status column header in the table should be gone (picker label still shows "Status")
    const table = screen.getByTestId('data-table');
    const headers = table.querySelectorAll('th');
    const headerTexts = Array.from(headers).map(h => h.textContent?.trim());
    expect(headerTexts).not.toContain('Status');
    expect(headerTexts).toContain('Name');
  });

  it('empty message displayed when no data', () => {
    render(
      <DataTable columns={testColumns} data={[]} keyField="id" emptyMessage="Nothing here" />
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });
});
