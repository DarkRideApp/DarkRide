import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrafficTable } from './TrafficTable';
import type { TrafficEntry } from './TrafficEntryRow';

// Mock useNavigate (used by useTrafficReplay inside TrafficTable)
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

const makeEntry = (overrides: Partial<TrafficEntry> = {}): TrafficEntry => ({
  id: 1,
  sessionId: null,
  deviceId: null,
  requestMethod: 'GET',
  requestUrl: 'https://example.com/api',
  requestHeaders: null,
  requestBody: null,
  responseStatus: 200,
  responseHeaders: null,
  responseBody: null,
  capturedAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('TrafficTable — collapsible filter bar', () => {
  it('shows the search input by default', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    expect(screen.getByPlaceholderText(/filter by host/i)).toBeInTheDocument();
  });

  it('hides method toggles and status pills by default (collapsed)', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    // Method filter buttons should not be visible
    expect(screen.queryByTestId('filter-method-GET')).not.toBeInTheDocument();
    // Status pills should not be visible
    expect(screen.queryByText('2xx')).not.toBeInTheDocument();
    expect(screen.queryByText('ALL')).not.toBeInTheDocument();
  });

  it('shows the "Filters" toggle button', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
  });

  it('expands the filter panel when clicking the "Filters" button', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    const toggleBtn = screen.getByRole('button', { name: /filters/i });
    fireEvent.click(toggleBtn);

    // Now method toggles should be visible
    expect(screen.getByTestId('filter-method-GET')).toBeInTheDocument();
    // Status pills should be visible
    expect(screen.getByText('ALL')).toBeInTheDocument();
    expect(screen.getByText('2xx')).toBeInTheDocument();
  });

  it('collapses the filter panel when clicking "Filters" again', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    const toggleBtn = screen.getByRole('button', { name: /filters/i });

    // Expand
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('filter-method-GET')).toBeInTheDocument();

    // Collapse
    fireEvent.click(toggleBtn);
    expect(screen.queryByTestId('filter-method-GET')).not.toBeInTheDocument();
  });

  it('shows a filter count badge when a method filter is active', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    const toggleBtn = screen.getByRole('button', { name: /filters/i });

    // Expand and activate a method filter
    fireEvent.click(toggleBtn);
    // Click the GET include button (first button inside the method filter span)
    const getFilter = screen.getByTestId('filter-method-GET');
    const includeBtn = getFilter.querySelector('.traffic-method-filter-btn') as HTMLElement;
    fireEvent.click(includeBtn);

    // The default filters already exclude DNS, CONNECT, TLS_FAIL (3 methods)
    // Plus the newly included GET = 4 active filters
    // The toggle button should show a count
    expect(screen.getByRole('button', { name: /filters\s*\(4\)/i })).toBeInTheDocument();
  });

  it('shows filter count badge when a status filter is active', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    const toggleBtn = screen.getByRole('button', { name: /filters/i });

    // Expand and activate a status filter
    fireEvent.click(toggleBtn);
    fireEvent.click(screen.getByText('4xx'));

    // Default 3 method excludes + 1 status filter = 4
    expect(screen.getByRole('button', { name: /filters\s*\(4\)/i })).toBeInTheDocument();
  });

  it('keeps search input visible when filter bar is shown, regardless of panel state', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    const input = screen.getByPlaceholderText(/filter by host/i);
    expect(input).toBeInTheDocument();

    // Expand panel
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(input).toBeInTheDocument();

    // Collapse panel
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(input).toBeInTheDocument();
  });
});

describe('TrafficTable — Duration column', () => {
  it('renders a compact duration for an entry with timing', () => {
    render(<TrafficTable entries={[makeEntry({ id: 5, durationMs: 142 })]} showFilterBar={false} />);
    expect(screen.getByTestId('traffic-duration-5')).toHaveTextContent('142ms');
  });

  it('formats durations over a second as seconds', () => {
    render(<TrafficTable entries={[makeEntry({ id: 6, durationMs: 1200 })]} showFilterBar={false} />);
    expect(screen.getByTestId('traffic-duration-6')).toHaveTextContent('1.2s');
  });

  it('shows an em-dash when duration is missing', () => {
    render(<TrafficTable entries={[makeEntry({ id: 7, durationMs: null })]} showFilterBar={false} />);
    expect(screen.getByTestId('traffic-duration-7')).toHaveTextContent('—');
  });

  it('renders a sortable Duration header and calls onSortChange with durationMs', () => {
    const onSortChange = vi.fn();
    render(
      <TrafficTable
        entries={[makeEntry({ id: 8, durationMs: 500 })]}
        showFilterBar={false}
        onSortChange={onSortChange}
        sortBy="capturedAt"
        sortDir="desc"
      />,
    );
    const header = screen.getByTestId('traffic-header-duration');
    fireEvent.click(header);
    expect(onSortChange).toHaveBeenCalledWith('durationMs', 'desc');
  });
});
