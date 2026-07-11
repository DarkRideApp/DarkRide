import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TrafficTable } from './TrafficTable';
import type { TrafficEntry } from './TrafficEntryRow';
import { loadFilterPresets } from './trafficUtils';

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

// ---------------------------------------------------------------------------
// Deep filter + search — content type, size, exact status, search, presets,
// selection stability, active-filter chips.
// ---------------------------------------------------------------------------

describe('TrafficTable — content-type filter', () => {
  it('narrows rows to the selected content-type pill', () => {
    const jsonEntry = makeEntry({ id: 1, responseHeaders: JSON.stringify({ 'content-type': 'application/json' }) });
    const htmlEntry = makeEntry({ id: 2, responseHeaders: JSON.stringify({ 'content-type': 'text/html' }) });

    render(<TrafficTable entries={[jsonEntry, htmlEntry]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('filter-contenttype-json'));

    expect(screen.getByTestId('traffic-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('traffic-row-2')).not.toBeInTheDocument();
  });
});

describe('TrafficTable — size filter', () => {
  it('narrows rows using the "Has body" quick filter', () => {
    const withBody = makeEntry({ id: 1, responseBody: 'hello world' });
    const noBody = makeEntry({ id: 2, responseBody: null });

    render(<TrafficTable entries={[withBody, noBody]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('filter-size-hasBody'));

    expect(screen.getByTestId('traffic-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('traffic-row-2')).not.toBeInTheDocument();
  });
});

describe('TrafficTable — exact status filter', () => {
  it('narrows rows to an exact status code entered by the user', () => {
    const e404 = makeEntry({ id: 1, responseStatus: 404 });
    const e429 = makeEntry({ id: 2, responseStatus: 429 });

    render(<TrafficTable entries={[e404, e429]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));

    const input = screen.getByTestId('filter-exact-status-input');
    fireEvent.change(input, { target: { value: '404' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTestId('traffic-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('traffic-row-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('exact-status-chip-404')).toBeInTheDocument();
  });
});

describe('TrafficTable — search wiring', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces the search-all input and calls onFilterChange with the server search param', () => {
    const onFilterChange = vi.fn();
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} onFilterChange={onFilterChange} />);

    const input = screen.getByTestId('traffic-search-all-input');
    fireEvent.change(input, { target: { value: 'auth-token' } });

    // Not called yet — debounced
    expect(onFilterChange.mock.calls.some(([f]) => f.search === 'auth-token')).toBe(false);

    act(() => { vi.advanceTimersByTime(350); });

    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'auth-token' }));
  });
});

describe('TrafficTable — saved filter presets', () => {
  beforeEach(() => localStorage.clear());

  it('shows built-in presets in the filter panel', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(screen.getByTestId('preset-errors-only')).toBeInTheDocument();
    expect(screen.getByTestId('preset-apis-only')).toBeInTheDocument();
  });

  it('applying "Errors only" filters to 4xx/5xx rows', () => {
    const e404 = makeEntry({ id: 1, responseStatus: 404 });
    const e200 = makeEntry({ id: 2, responseStatus: 200 });

    render(<TrafficTable entries={[e404, e200]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('preset-errors-only'));

    expect(screen.getByTestId('traffic-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('traffic-row-2')).not.toBeInTheDocument();
  });

  it('saves the current filter set under a name and round-trips it via localStorage', () => {
    const jsonEntry = makeEntry({ id: 1, responseHeaders: JSON.stringify({ 'content-type': 'application/json' }) });
    const htmlEntry = makeEntry({ id: 2, responseHeaders: JSON.stringify({ 'content-type': 'text/html' }) });

    const { unmount } = render(<TrafficTable entries={[jsonEntry, htmlEntry]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('filter-contenttype-json'));

    fireEvent.click(screen.getByTestId('preset-save-btn'));
    fireEvent.change(screen.getByTestId('preset-name-input'), { target: { value: 'JSON only' } });
    fireEvent.click(screen.getByTestId('preset-save-confirm'));

    const saved = loadFilterPresets();
    expect(saved.some(p => p.name === 'JSON only')).toBe(true);
    expect(saved.find(p => p.name === 'JSON only')?.filters.contentTypes).toEqual(['json']);

    unmount();

    // Reload in a fresh mount and re-apply the saved preset
    render(<TrafficTable entries={[jsonEntry, htmlEntry]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('preset-json-only'));

    expect(screen.getByTestId('traffic-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('traffic-row-2')).not.toBeInTheDocument();
  });
});

describe('TrafficTable — selection survives filter changes when the row still matches', () => {
  it('keeps the selected row selected if it still matches the new filter', () => {
    const getEntry = makeEntry({ id: 1, requestMethod: 'GET' });
    const postEntry = makeEntry({ id: 2, requestMethod: 'POST' });

    render(<TrafficTable entries={[getEntry, postEntry]} showFilterBar={true} />);
    fireEvent.click(screen.getByTestId('traffic-row-1'));
    expect(screen.getByTestId('traffic-row-1')).toHaveClass('selected');

    // Apply a size filter that both rows still pass (no body on either) —
    // selection should be preserved since row 1 still matches.
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('filter-size-empty'));

    expect(screen.getByTestId('traffic-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('traffic-row-1')).toHaveClass('selected');
  });

  it('clears the selection if the selected row no longer matches the new filter', () => {
    const getEntry = makeEntry({ id: 1, requestMethod: 'GET' });
    const postEntry = makeEntry({ id: 2, requestMethod: 'POST' });

    render(<TrafficTable entries={[getEntry, postEntry]} showFilterBar={true} />);
    fireEvent.click(screen.getByTestId('traffic-row-1'));
    expect(screen.getByTestId('traffic-row-1')).toHaveClass('selected');

    // Include only POST — row 1 (GET) drops out of the filtered set.
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    const postFilter = screen.getByTestId('filter-method-POST');
    fireEvent.click(postFilter.querySelector('.traffic-method-filter-btn') as HTMLElement);

    expect(screen.queryByTestId('traffic-row-1')).not.toBeInTheDocument();
    // No detail panel should be rendered for a cleared selection
    expect(screen.queryByText(/repeat request/i)).not.toBeInTheDocument();
  });
});

describe('TrafficTable — active-filter chips', () => {
  it('renders a removable chip for an active status-group filter and clears it on click', () => {
    const e404 = makeEntry({ id: 1, responseStatus: 404 });
    const e200 = makeEntry({ id: 2, responseStatus: 200 });

    render(<TrafficTable entries={[e404, e200]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByText('4xx'));

    const chip = screen.getByTestId('active-filter-chip-status-4xx');
    expect(chip).toBeInTheDocument();
    expect(screen.queryByTestId('traffic-row-2')).not.toBeInTheDocument();

    fireEvent.click(chip.querySelector('button') as HTMLElement);

    expect(screen.queryByTestId('active-filter-chip-status-4xx')).not.toBeInTheDocument();
    expect(screen.getByTestId('traffic-row-2')).toBeInTheDocument();
  });

  it('renders a removable chip for the content-type filter', () => {
    const jsonEntry = makeEntry({ id: 1, responseHeaders: JSON.stringify({ 'content-type': 'application/json' }) });
    render(<TrafficTable entries={[jsonEntry]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('filter-contenttype-json'));

    expect(screen.getByTestId('active-filter-chip-contenttype-json')).toBeInTheDocument();
  });

  it('"Clear all" removes every active filter including default method excludes', () => {
    render(<TrafficTable entries={[makeEntry()]} showFilterBar={true} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByText('4xx'));

    fireEvent.click(screen.getByTestId('active-filters-clear-all'));

    expect(screen.queryByTestId('active-filters-bar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^filters$/i })).toBeInTheDocument();
  });
});
