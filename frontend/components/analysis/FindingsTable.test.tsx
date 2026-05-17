import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { FindingsTable } from './FindingsTable';
import type { Finding } from './FindingsTable';

const mockFindings: Finding[] = [
  {
    id: 1,
    filePath: 'com/example/app/Config.java',
    fileSource: 'jadx',
    ruleId: 'hardcoded-secret',
    severity: 'critical',
    title: 'Hardcoded API Key',
    description: 'An API key was found hardcoded in source code.',
    lineNumber: 42,
    matchedText: 'AIzaSyB...XXXX',
    category: 'secret',
  },
  {
    id: 2,
    filePath: 'com/example/app/NetworkHelper.java',
    fileSource: 'jadx',
    ruleId: 'cleartext-traffic',
    severity: 'high',
    title: 'Cleartext HTTP Traffic',
    description: 'Application allows cleartext HTTP traffic.',
    lineNumber: 15,
    matchedText: 'http://api.example.com',
    category: 'network',
  },
  {
    id: 3,
    filePath: 'com/example/app/CryptoUtil.java',
    fileSource: 'jadx',
    ruleId: 'weak-cipher',
    severity: 'medium',
    title: 'Weak Cipher',
    description: 'DES cipher is considered weak.',
    lineNumber: 88,
    matchedText: 'DES/ECB/PKCS5Padding',
    category: 'crypto',
  },
  {
    id: 4,
    filePath: 'res/values/strings.xml',
    fileSource: 'apktool',
    ruleId: 'url-in-resource',
    severity: 'low',
    title: 'URL in Resource',
    description: 'A URL was found in string resources.',
    lineNumber: null,
    matchedText: 'https://tracking.example.com',
    category: 'url',
  },
  {
    id: 5,
    filePath: 'AndroidManifest.xml',
    fileSource: 'apktool',
    ruleId: 'debuggable-flag',
    severity: 'info',
    title: 'Debug Flag Set',
    description: 'Application has debuggable flag set to false.',
    lineNumber: 3,
    matchedText: null,
    category: 'permission',
  },
];

function createMockWs(findings: Finding[] = mockFindings): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((_method: string, pathWithQuery: string) => {
      const [, qs] = pathWithQuery.split('?');
      const params = new URLSearchParams(qs || '');
      const severity = params.get('severity');
      const category = params.get('category');
      const excludePaths = params.get('excludePaths');

      let filtered = findings;
      if (severity) filtered = filtered.filter(f => f.severity === severity);
      if (category) filtered = filtered.filter(f => f.category === category);
      if (excludePaths) {
        const prefixes = excludePaths.split(',');
        filtered = filtered.filter(f =>
          !prefixes.some(p => ('/' + f.filePath).includes('/' + p.replace(/\./g, '/') + '/')),
        );
      }

      return Promise.resolve({
        type: 'restapi',
        id: '1',
        status: 200,
        body: { data: filtered, total: filtered.length },
      });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderFindingsTable(ws?: WebSocketContextValue, onNavigate?: any, props?: { excludedPaths?: string[]; showLibrary?: boolean }) {
  const mockWs = ws || createMockWs();
  const mockNavigate = onNavigate || vi.fn();
  render(
    <WebSocketContext.Provider value={mockWs}>
      <FindingsTable versionId="42" onNavigate={mockNavigate} {...props} />
    </WebSocketContext.Provider>,
  );
  return { ws: mockWs, onNavigate: mockNavigate };
}

describe('FindingsTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    const ws = createMockWs();
    ws.sendRestApi = vi.fn().mockReturnValue(new Promise(() => {}));
    renderFindingsTable(ws);
    expect(screen.getByTestId('findings-loading')).toBeInTheDocument();
  });

  it('fetches findings on mount with pagination', async () => {
    const { ws } = renderFindingsTable();
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', expect.stringContaining('/v1/apps/analysis/42/findings'));
    });
  });

  it('renders the findings table after loading', async () => {
    renderFindingsTable();
    await waitFor(() => {
      expect(screen.getByTestId('findings-table')).toBeInTheDocument();
    });
  });

  it('renders the toolbar', async () => {
    renderFindingsTable();
    await waitFor(() => {
      expect(screen.getByTestId('findings-toolbar')).toBeInTheDocument();
    });
  });

  it('renders severity filter dropdown', async () => {
    renderFindingsTable();
    await waitFor(() => {
      expect(screen.getByTestId('severity-filter')).toBeInTheDocument();
    });
  });

  it('renders category filter dropdown', async () => {
    renderFindingsTable();
    await waitFor(() => {
      expect(screen.getByTestId('category-filter')).toBeInTheDocument();
    });
  });

  it('renders export button', async () => {
    renderFindingsTable();
    await waitFor(() => {
      expect(screen.getByTestId('export-btn')).toBeInTheDocument();
    });
  });

  it('shows total findings count', async () => {
    renderFindingsTable();
    await waitFor(() => {
      expect(screen.getByTestId('findings-count')).toHaveTextContent('5 findings');
    });
  });

  it('renders all finding rows', async () => {
    renderFindingsTable();
    await waitFor(() => {
      expect(screen.getByTestId('finding-row-1')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-2')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-3')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-4')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-5')).toBeInTheDocument();
    });
  });

  it('displays correct columns in each row', async () => {
    renderFindingsTable();
    await waitFor(() => {
      const row1 = screen.getByTestId('finding-row-1');
      expect(row1).toHaveTextContent('critical');
      expect(row1).toHaveTextContent('secret');
      expect(row1).toHaveTextContent('Hardcoded API Key');
      expect(row1).toHaveTextContent('com/example/app/Config.java');
      expect(row1).toHaveTextContent('42');
      expect(row1).toHaveTextContent('AIzaSyB...XXXX');
    });
  });

  it('renders severity badges with correct text', async () => {
    renderFindingsTable();
    await waitFor(() => {
      expect(screen.getByTestId('badge-critical')).toHaveTextContent('critical');
      expect(screen.getByTestId('badge-high')).toHaveTextContent('high');
      expect(screen.getByTestId('badge-medium')).toHaveTextContent('medium');
      expect(screen.getByTestId('badge-low')).toHaveTextContent('low');
      expect(screen.getByTestId('badge-info')).toHaveTextContent('info');
    });
  });

  it('severity badge has correct color styling', async () => {
    renderFindingsTable();
    await waitFor(() => {
      const criticalBadge = screen.getByTestId('badge-critical');
      expect(criticalBadge.style.color).toBe('rgb(220, 53, 69)'); // #dc3545
    });
  });

  it('shows dash for null lineNumber', async () => {
    renderFindingsTable();
    await waitFor(() => {
      const row4 = screen.getByTestId('finding-row-4');
      // The row should contain a dash for null lineNumber
      const cells = row4.querySelectorAll('td');
      // Line number is the 5th column (index 4)
      expect(cells[4]).toHaveTextContent('\u2014'); // em-dash
    });
  });

  it('shows dash for null matchedText', async () => {
    renderFindingsTable();
    await waitFor(() => {
      const row5 = screen.getByTestId('finding-row-5');
      const cells = row5.querySelectorAll('td');
      // Match is the 6th column (index 5)
      expect(cells[5]).toHaveTextContent('\u2014'); // em-dash
    });
  });

  describe('filtering', () => {
    it('filters by severity (server-side)', async () => {
      renderFindingsTable();
      await waitFor(() => screen.getByTestId('findings-data-table'));

      fireEvent.change(screen.getByTestId('severity-filter'), { target: { value: 'critical' } });

      await waitFor(() => {
        expect(screen.getByTestId('finding-row-1')).toBeInTheDocument();
        expect(screen.queryByTestId('finding-row-2')).not.toBeInTheDocument();
      });
    });

    it('filters by category (server-side)', async () => {
      renderFindingsTable();
      await waitFor(() => screen.getByTestId('findings-data-table'));

      fireEvent.change(screen.getByTestId('category-filter'), { target: { value: 'network' } });

      await waitFor(() => {
        expect(screen.queryByTestId('finding-row-1')).not.toBeInTheDocument();
        expect(screen.getByTestId('finding-row-2')).toBeInTheDocument();
      });
    });

    it('filters by both severity and category', async () => {
      renderFindingsTable();
      await waitFor(() => screen.getByTestId('findings-data-table'));

      fireEvent.change(screen.getByTestId('severity-filter'), { target: { value: 'high' } });
      await waitFor(() => screen.getByTestId('findings-data-table'));
      fireEvent.change(screen.getByTestId('category-filter'), { target: { value: 'network' } });

      await waitFor(() => {
        expect(screen.getByTestId('finding-row-2')).toBeInTheDocument();
        expect(screen.queryByTestId('finding-row-1')).not.toBeInTheDocument();
      });
    });

    it('updates count when filtered', async () => {
      renderFindingsTable();
      await waitFor(() => screen.getByTestId('findings-data-table'));

      fireEvent.change(screen.getByTestId('severity-filter'), { target: { value: 'critical' } });

      await waitFor(() => {
        expect(screen.getByTestId('findings-count')).toHaveTextContent('1 finding');
      });
    });

    it('shows empty state when filter matches nothing', async () => {
      renderFindingsTable();
      await waitFor(() => screen.getByTestId('findings-data-table'));

      fireEvent.change(screen.getByTestId('severity-filter'), { target: { value: 'critical' } });
      await waitFor(() => screen.getByTestId('severity-filter'));
      fireEvent.change(screen.getByTestId('category-filter'), { target: { value: 'url' } });

      await waitFor(() => {
        expect(screen.getByTestId('findings-empty')).toBeInTheDocument();
      });
    });

    it('resets to show all when filter set back to all', async () => {
      renderFindingsTable();
      await waitFor(() => screen.getByTestId('findings-data-table'));

      fireEvent.change(screen.getByTestId('severity-filter'), { target: { value: 'critical' } });
      await waitFor(() => {
        expect(screen.queryByTestId('finding-row-2')).not.toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('severity-filter'), { target: { value: 'all' } });
      await waitFor(() => {
        expect(screen.getByTestId('finding-row-2')).toBeInTheDocument();
      });
    });
  });

  describe('navigation', () => {
    it('calls onNavigate with filePath, lineNumber, and source when row is clicked', async () => {
      const onNavigate = vi.fn();
      renderFindingsTable(undefined, onNavigate);
      await waitFor(() => screen.getByTestId('finding-row-1'));

      fireEvent.click(screen.getByTestId('finding-row-1'));

      expect(onNavigate).toHaveBeenCalledWith('com/example/app/Config.java', 42, 'jadx');
    });

    it('passes lineNumber 1 when lineNumber is null', async () => {
      const onNavigate = vi.fn();
      renderFindingsTable(undefined, onNavigate);
      await waitFor(() => screen.getByTestId('finding-row-4'));

      fireEvent.click(screen.getByTestId('finding-row-4'));

      expect(onNavigate).toHaveBeenCalledWith('res/values/strings.xml', 1, 'apktool');
    });

    it('passes the correct fileSource for each finding', async () => {
      const onNavigate = vi.fn();
      renderFindingsTable(undefined, onNavigate);
      await waitFor(() => screen.getByTestId('finding-row-3'));

      fireEvent.click(screen.getByTestId('finding-row-3'));

      expect(onNavigate).toHaveBeenCalledWith('com/example/app/CryptoUtil.java', 88, 'jadx');
    });
  });

  describe('export', () => {
    it('triggers file download on export click', async () => {
      renderFindingsTable();
      await waitFor(() => screen.getByTestId('export-btn'));

      // Mock DOM methods
      const createObjectURL = vi.fn().mockReturnValue('blob:test');
      const revokeObjectURL = vi.fn();
      Object.defineProperty(window, 'URL', {
        value: { createObjectURL, revokeObjectURL },
        writable: true,
      });

      const mockClick = vi.fn();
      const mockAppendChild = vi.spyOn(document.body, 'appendChild').mockImplementation(((node: Node) => {
        if (node instanceof HTMLAnchorElement) {
          node.click = mockClick;
        }
        return node;
      }) as any);
      const mockRemoveChild = vi.spyOn(document.body, 'removeChild').mockImplementation(((node: Node) => node) as any);

      fireEvent.click(screen.getByTestId('export-btn'));

      expect(createObjectURL).toHaveBeenCalled();
      expect(mockClick).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');

      mockAppendChild.mockRestore();
      mockRemoveChild.mockRestore();
    });

    it('disables export button when no findings', async () => {
      const ws = createMockWs([]);
      renderFindingsTable(ws);
      await waitFor(() => screen.getByTestId('export-btn'));
      expect(screen.getByTestId('export-btn')).toBeDisabled();
    });
  });

  describe('empty state', () => {
    it('shows empty state when no findings exist', async () => {
      const ws = createMockWs([]);
      renderFindingsTable(ws);
      await waitFor(() => {
        expect(screen.getByTestId('findings-empty')).toBeInTheDocument();
        expect(screen.getByText('No security findings were detected in this analysis.')).toBeInTheDocument();
      });
    });
  });

  describe('error handling', () => {
    it('shows error state when API fails', async () => {
      const ws = createMockWs();
      ws.sendRestApi = vi.fn().mockResolvedValue({
        type: 'restapi',
        id: '1',
        status: 500,
        body: { error: 'Internal server error' },
      });
      renderFindingsTable(ws);
      await waitFor(() => {
        expect(screen.getByTestId('findings-error')).toBeInTheDocument();
        expect(screen.getByText('Internal server error')).toBeInTheDocument();
      });
    });

    it('shows error state when API throws', async () => {
      const ws = createMockWs();
      ws.sendRestApi = vi.fn().mockRejectedValue(new Error('Network error'));
      renderFindingsTable(ws);
      await waitFor(() => {
        expect(screen.getByTestId('findings-error')).toBeInTheDocument();
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });
  });

  describe('library path exclusion', () => {
    const excludedPaths = ['com.example.app'];

    it('hides findings with excluded paths when showLibrary is false', async () => {
      renderFindingsTable(undefined, undefined, { excludedPaths, showLibrary: false });
      await waitFor(() => {
        expect(screen.getByTestId('findings-table')).toBeInTheDocument();
      });
      // Findings in com/example/app/ should be hidden (IDs 1, 2, 3)
      expect(screen.queryByTestId('finding-row-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('finding-row-2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('finding-row-3')).not.toBeInTheDocument();
      // Findings not in excluded paths should still show
      expect(screen.getByTestId('finding-row-4')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-5')).toBeInTheDocument();
    });

    it('shows all findings when showLibrary is true', async () => {
      renderFindingsTable(undefined, undefined, { excludedPaths, showLibrary: true });
      await waitFor(() => {
        expect(screen.getByTestId('findings-table')).toBeInTheDocument();
      });
      expect(screen.getByTestId('finding-row-1')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-2')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-3')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-4')).toBeInTheDocument();
      expect(screen.getByTestId('finding-row-5')).toBeInTheDocument();
    });

    it('shows excluded note when library filter is active', async () => {
      renderFindingsTable(undefined, undefined, { excludedPaths, showLibrary: false });
      await waitFor(() => {
        expect(screen.getByTestId('findings-hidden-count')).toHaveTextContent('library findings excluded');
      });
    });

    it('does not show hidden count note when showLibrary is true', async () => {
      renderFindingsTable(undefined, undefined, { excludedPaths, showLibrary: true });
      await waitFor(() => {
        expect(screen.getByTestId('findings-table')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('findings-hidden-count')).not.toBeInTheDocument();
    });
  });

  it('renders table headers', async () => {
    renderFindingsTable();
    await waitFor(() => {
      const table = screen.getByTestId('findings-data-table');
      expect(table).toBeInTheDocument();
      const headers = table.querySelectorAll('th');
      expect(headers[0]).toHaveTextContent('Severity');
      expect(headers[1]).toHaveTextContent('Category');
      expect(headers[2]).toHaveTextContent('Rule');
      expect(headers[3]).toHaveTextContent('File');
      expect(headers[4]).toHaveTextContent('Line');
      expect(headers[5]).toHaveTextContent('Match');
    });
  });
});
