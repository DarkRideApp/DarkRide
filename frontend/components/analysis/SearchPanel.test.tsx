import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { SearchPanel } from './SearchPanel';

const mockResults = {
  results: [
    { file: 'com/example/app/MainActivity.java', source: 'jadx', line: 7, content: 'String API_KEY = "test"', context: [] },
    { file: 'com/example/app/utils/Helper.java', source: 'jadx', line: 15, content: 'API_KEY used here', context: [] },
  ],
  total: 2,
  limited: false,
};

function createMockWs(searchResponse?: any): WebSocketContextValue {
  const sendRestApi = vi.fn().mockImplementation(() => {
    return Promise.resolve({
      type: 'restapi',
      id: '1',
      status: 200,
      body: { success: true, data: searchResponse ?? mockResults },
    });
  });

  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderSearchPanel(ws?: WebSocketContextValue, props?: Partial<React.ComponentProps<typeof SearchPanel>>) {
  const mockWs = ws || createMockWs();
  const defaultProps = {
    versionId: '42',
    source: 'jadx',
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    ...props,
  };
  render(
    <WebSocketContext.Provider value={mockWs}>
      <SearchPanel {...defaultProps} />
    </WebSocketContext.Provider>,
  );
  return { ws: mockWs, ...defaultProps };
}

describe('SearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search panel with input, toggles, and buttons', () => {
    renderSearchPanel();
    expect(screen.getByTestId('search-panel')).toBeInTheDocument();
    expect(screen.getByTestId('search-input')).toBeInTheDocument();
    expect(screen.getByTestId('search-toggle-case')).toBeInTheDocument();
    expect(screen.getByTestId('search-toggle-regex')).toBeInTheDocument();
    expect(screen.getByTestId('search-submit')).toBeInTheDocument();
    expect(screen.getByTestId('search-close')).toBeInTheDocument();
  });

  it('creates a search tab when submitting query', async () => {
    const { ws } = renderSearchPanel();
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'API_KEY' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('/v1/apps/analysis/42/search?q=API_KEY'),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-panel-tabs')).toBeInTheDocument();
    });
  });

  it('creates a search tab on Enter key', async () => {
    const { ws } = renderSearchPanel();
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalled();
    });
  });

  it('displays search results with file, line, and content', async () => {
    renderSearchPanel();
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'API_KEY' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('search-result-0')).toBeInTheDocument();
      expect(screen.getByTestId('search-result-1')).toBeInTheDocument();
    });

    const firstResult = screen.getByTestId('search-result-0');
    expect(firstResult).toHaveTextContent('MainActivity.java');
    expect(firstResult).toHaveTextContent(':7');
    expect(firstResult).toHaveTextContent('API_KEY');
  });

  it('clicking a result calls onNavigate with correct args', async () => {
    const { onNavigate } = renderSearchPanel();
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'API_KEY' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('search-result-0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('search-result-0'));
    expect(onNavigate).toHaveBeenCalledWith(
      'com/example/app/MainActivity.java',
      7,
      'jadx',
    );
  });

  it('multiple searches create multiple tabs', async () => {
    renderSearchPanel();

    // First search
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'first' } });
    fireEvent.click(screen.getByTestId('search-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('search-panel-tabs')).toBeInTheDocument();
    });

    // Second search
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'second' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      const tabsContainer = screen.getByTestId('search-panel-tabs');
      expect(tabsContainer.children.length).toBe(2);
    });
  });

  it('closing a tab removes it', async () => {
    renderSearchPanel();

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'test' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('search-panel-tabs')).toBeInTheDocument();
    });

    // Find the tab's close button
    const tabs = screen.getByTestId('search-panel-tabs');
    const closeBtn = tabs.querySelector('.search-panel-tab-close');
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn!);

    // Tabs container should be gone (no tabs left)
    expect(screen.queryByTestId('search-panel-tabs')).not.toBeInTheDocument();
  });

  it('case sensitive toggle updates state', () => {
    renderSearchPanel();
    const toggle = screen.getByTestId('search-toggle-case');
    expect(toggle).not.toHaveClass('search-panel-toggle-active');

    fireEvent.click(toggle);
    expect(toggle).toHaveClass('search-panel-toggle-active');

    fireEvent.click(toggle);
    expect(toggle).not.toHaveClass('search-panel-toggle-active');
  });

  it('regex toggle updates state', () => {
    renderSearchPanel();
    const toggle = screen.getByTestId('search-toggle-regex');
    expect(toggle).not.toHaveClass('search-panel-toggle-active');

    fireEvent.click(toggle);
    expect(toggle).toHaveClass('search-panel-toggle-active');
  });

  it('close button calls onClose', () => {
    const { onClose } = renderSearchPanel();
    fireEvent.click(screen.getByTestId('search-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape key calls onClose', () => {
    const { onClose } = renderSearchPanel();
    fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows result count in status bar', async () => {
    renderSearchPanel();
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'API_KEY' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      const status = screen.getByTestId('search-panel-status');
      expect(status).toHaveTextContent('2 results');
    });
  });

  it('shows "No results found" when search returns empty', async () => {
    const ws = createMockWs({ results: [], total: 0, limited: false });
    renderSearchPanel(ws);
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'nonexistent' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(screen.getByText('No results found')).toBeInTheDocument();
    });
  });

  it('does not search when query is empty', () => {
    const { ws } = renderSearchPanel();
    fireEvent.click(screen.getByTestId('search-submit'));
    expect(ws.sendRestApi).not.toHaveBeenCalled();
  });

  it('sends caseSensitive=false when toggle is off (default)', async () => {
    const { ws } = renderSearchPanel();
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'test' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('caseSensitive=false'),
      );
    });
  });

  it('does not send caseSensitive param when toggle is on', async () => {
    const { ws } = renderSearchPanel();
    fireEvent.click(screen.getByTestId('search-toggle-case'));
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'test' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalled();
      const url = (ws.sendRestApi as any).mock.calls[0][1] as string;
      expect(url).not.toContain('caseSensitive=');
    });
  });

  it('sends regex=true when regex toggle is on', async () => {
    const { ws } = renderSearchPanel();
    fireEvent.click(screen.getByTestId('search-toggle-regex'));
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'test.*' } });
    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('regex=true'),
      );
    });
  });

  it('pendingSearch with autoExecute triggers search automatically', async () => {
    const ws = createMockWs();
    renderSearchPanel(ws, {
      pendingSearch: { query: 'MyClass', isRegex: false, caseSensitive: true, autoExecute: true, key: 1 },
    });

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('q=MyClass'),
      );
    });

    // Input should be filled
    expect(screen.getByTestId('search-input')).toHaveValue('MyClass');
  });

  it('pendingSearch with autoExecute false fills query without executing', async () => {
    const ws = createMockWs();
    renderSearchPanel(ws, {
      pendingSearch: { query: 'SearchMe', isRegex: false, caseSensitive: false, autoExecute: false, key: 1 },
    });

    // Input should be filled
    await waitFor(() => {
      expect(screen.getByTestId('search-input')).toHaveValue('SearchMe');
    });

    // Should NOT have triggered a search
    expect(ws.sendRestApi).not.toHaveBeenCalled();
  });

  it('pendingSearch with isRegex enables regex toggle', async () => {
    const ws = createMockWs();
    renderSearchPanel(ws, {
      pendingSearch: { query: 'class\\s+Foo', isRegex: true, caseSensitive: true, autoExecute: true, key: 1 },
    });

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('regex=true'),
      );
    });

    expect(screen.getByTestId('search-toggle-regex')).toHaveClass('search-panel-toggle-active');
  });

  it('pendingSearch with caseSensitive true does not send caseSensitive=false', async () => {
    const ws = createMockWs();
    renderSearchPanel(ws, {
      pendingSearch: { query: 'test', isRegex: false, caseSensitive: true, autoExecute: true, key: 1 },
    });

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalled();
      const url = (ws.sendRestApi as any).mock.calls[0][1] as string;
      expect(url).not.toContain('caseSensitive=');
    });
  });
});
