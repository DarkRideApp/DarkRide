import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { StringsView } from './StringsView';
import type { StringsData } from './StringsView';

const mockData: StringsData = {
  urls: [
    {
      url: 'https://api.example.com/v1/users',
      domain: 'api.example.com',
      filePath: 'com/example/app/ApiClient.java',
      fileSource: 'jadx',
      lineNumber: 25,
    },
    {
      url: 'https://api.example.com/v1/auth',
      domain: 'api.example.com',
      filePath: 'com/example/app/AuthService.java',
      fileSource: 'jadx',
      lineNumber: 12,
    },
    {
      url: 'http://tracking.ads.com/pixel',
      domain: 'tracking.ads.com',
      filePath: 'com/example/app/Analytics.java',
      fileSource: 'jadx',
      lineNumber: 88,
    },
    {
      url: 'https://cdn.example.com/assets/logo.png',
      domain: 'cdn.example.com',
      filePath: 'res/values/strings.xml',
      fileSource: 'apktool',
      lineNumber: 5,
    },
  ],
  strings: [
    {
      value: 'AIzaSyB1234567890abcdefg',
      type: 'api-key',
      filePath: 'com/example/app/Config.java',
      fileSource: 'jadx',
      lineNumber: 42,
    },
    {
      value: '192.168.1.100',
      type: 'ip-address',
      filePath: 'com/example/app/NetworkHelper.java',
      fileSource: 'jadx',
      lineNumber: 15,
    },
    {
      value: 'eyJhbGciOiJIUzI1NiJ9...',
      type: 'token',
      filePath: 'com/example/app/Auth.java',
      fileSource: 'jadx',
      lineNumber: 30,
    },
    {
      value: '-----BEGIN PRIVATE KEY-----',
      type: 'private-key',
      filePath: 'assets/cert.pem',
      fileSource: 'apktool',
      lineNumber: 1,
    },
    {
      value: '-----BEGIN CERTIFICATE-----',
      type: 'certificate',
      filePath: 'assets/server.crt',
      fileSource: 'apktool',
      lineNumber: 1,
    },
  ],
};

function createMockWs(data: StringsData = mockData): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({
      type: 'restapi',
      id: '1',
      status: 200,
      body: { data },
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderStringsView(ws?: WebSocketContextValue, onNavigate?: any, props?: { excludedPaths?: string[]; showLibrary?: boolean }) {
  const mockWs = ws || createMockWs();
  const mockNavigate = onNavigate || vi.fn();
  render(
    <WebSocketContext.Provider value={mockWs}>
      <StringsView versionId="42" onNavigate={mockNavigate} {...props} />
    </WebSocketContext.Provider>,
  );
  return { ws: mockWs, onNavigate: mockNavigate };
}

describe('StringsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    const ws = createMockWs();
    ws.sendRestApi = vi.fn().mockReturnValue(new Promise(() => {}));
    renderStringsView(ws);
    expect(screen.getByTestId('strings-loading')).toBeInTheDocument();
  });

  it('fetches strings data on mount', async () => {
    const { ws } = renderStringsView();
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/apps/analysis/42/strings');
    });
  });

  it('renders the strings view after loading', async () => {
    renderStringsView();
    await waitFor(() => {
      expect(screen.getByTestId('strings-view')).toBeInTheDocument();
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
      renderStringsView(ws);
      await waitFor(() => {
        expect(screen.getByTestId('strings-error')).toBeInTheDocument();
        expect(screen.getByText('Internal server error')).toBeInTheDocument();
      });
    });

    it('shows error state when API throws', async () => {
      const ws = createMockWs();
      ws.sendRestApi = vi.fn().mockRejectedValue(new Error('Network error'));
      renderStringsView(ws);
      await waitFor(() => {
        expect(screen.getByTestId('strings-error')).toBeInTheDocument();
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty state when no data exists', async () => {
      const ws = createMockWs({ urls: [], strings: [] });
      renderStringsView(ws);
      await waitFor(() => {
        expect(screen.getByTestId('strings-empty')).toBeInTheDocument();
        expect(screen.getByText('No strings found')).toBeInTheDocument();
      });
    });
  });

  describe('URLs by Domain section', () => {
    it('renders the URLs section', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('urls-section')).toBeInTheDocument();
      });
    });

    it('shows total URL count and domain count', async () => {
      renderStringsView();
      await waitFor(() => {
        const section = screen.getByTestId('urls-section');
        expect(section).toHaveTextContent('4 URLs across 3 domains');
      });
    });

    it('renders domain groups sorted alphabetically', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('domain-group-api.example.com')).toBeInTheDocument();
        expect(screen.getByTestId('domain-group-cdn.example.com')).toBeInTheDocument();
        expect(screen.getByTestId('domain-group-tracking.ads.com')).toBeInTheDocument();
      });
    });

    it('shows URL count badge per domain', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('domain-count-api.example.com')).toHaveTextContent('2');
        expect(screen.getByTestId('domain-count-cdn.example.com')).toHaveTextContent('1');
        expect(screen.getByTestId('domain-count-tracking.ads.com')).toHaveTextContent('1');
      });
    });

    it('domain groups are collapsed by default', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('domain-group-api.example.com')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('domain-urls-api.example.com')).not.toBeInTheDocument();
    });

    it('expands domain group on click', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('domain-toggle-api.example.com')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('domain-toggle-api.example.com'));

      expect(screen.getByTestId('domain-urls-api.example.com')).toBeInTheDocument();
    });

    it('shows individual URLs when domain is expanded', async () => {
      renderStringsView();
      await waitFor(() => screen.getByTestId('domain-toggle-api.example.com'));

      fireEvent.click(screen.getByTestId('domain-toggle-api.example.com'));

      const urlsContainer = screen.getByTestId('domain-urls-api.example.com');
      expect(urlsContainer).toHaveTextContent('https://api.example.com/v1/users');
      expect(urlsContainer).toHaveTextContent('https://api.example.com/v1/auth');
    });

    it('shows file path and line number for each URL', async () => {
      renderStringsView();
      await waitFor(() => screen.getByTestId('domain-toggle-api.example.com'));

      fireEvent.click(screen.getByTestId('domain-toggle-api.example.com'));

      const urlsContainer = screen.getByTestId('domain-urls-api.example.com');
      expect(urlsContainer).toHaveTextContent('com/example/app/ApiClient.java:25');
      expect(urlsContainer).toHaveTextContent('com/example/app/AuthService.java:12');
    });

    it('collapses domain group on second click', async () => {
      renderStringsView();
      await waitFor(() => screen.getByTestId('domain-toggle-api.example.com'));

      fireEvent.click(screen.getByTestId('domain-toggle-api.example.com'));
      expect(screen.getByTestId('domain-urls-api.example.com')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('domain-toggle-api.example.com'));
      expect(screen.queryByTestId('domain-urls-api.example.com')).not.toBeInTheDocument();
    });

    it('calls onNavigate when a URL entry is clicked', async () => {
      const onNavigate = vi.fn();
      renderStringsView(undefined, onNavigate);
      await waitFor(() => screen.getByTestId('domain-toggle-api.example.com'));

      fireEvent.click(screen.getByTestId('domain-toggle-api.example.com'));
      fireEvent.click(screen.getByTestId('url-entry-0'));

      expect(onNavigate).toHaveBeenCalledWith('com/example/app/ApiClient.java', 25, 'jadx');
    });
  });

  describe('Interesting Strings section', () => {
    it('renders the strings section', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('strings-section')).toBeInTheDocument();
      });
    });

    it('shows count of interesting strings (excluding certs)', async () => {
      renderStringsView();
      await waitFor(() => {
        const section = screen.getByTestId('strings-section');
        // 3 interesting strings (api-key, ip-address, token) - certs are separate
        expect(section).toHaveTextContent('Interesting Strings');
        expect(section).toHaveTextContent('(3)');
      });
    });

    it('renders table headers', async () => {
      renderStringsView();
      await waitFor(() => {
        const table = screen.getByTestId('strings-data-table');
        const headers = table.querySelectorAll('th');
        expect(headers[0]).toHaveTextContent('Type');
        expect(headers[1]).toHaveTextContent('Value');
        expect(headers[2]).toHaveTextContent('File');
        expect(headers[3]).toHaveTextContent('Line');
      });
    });

    it('renders string rows with correct data', async () => {
      renderStringsView();
      await waitFor(() => {
        const row0 = screen.getByTestId('string-row-0');
        expect(row0).toHaveTextContent('api-key');
        expect(row0).toHaveTextContent('AIzaSyB1234567890abcdefg');
        expect(row0).toHaveTextContent('com/example/app/Config.java');
        expect(row0).toHaveTextContent('42');
      });
    });

    it('renders type badges', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('type-badge-0')).toHaveTextContent('api-key');
        expect(screen.getByTestId('type-badge-1')).toHaveTextContent('ip-address');
        expect(screen.getByTestId('type-badge-2')).toHaveTextContent('token');
      });
    });

    it('does not include certificate types in interesting strings', async () => {
      renderStringsView();
      await waitFor(() => {
        const table = screen.getByTestId('strings-data-table');
        expect(table).not.toHaveTextContent('private-key');
        expect(table).not.toHaveTextContent('certificate');
      });
    });

    it('calls onNavigate when a string row is clicked', async () => {
      const onNavigate = vi.fn();
      renderStringsView(undefined, onNavigate);
      await waitFor(() => screen.getByTestId('string-row-0'));

      fireEvent.click(screen.getByTestId('string-row-0'));

      expect(onNavigate).toHaveBeenCalledWith('com/example/app/Config.java', 42, 'jadx');
    });

    it('passes correct source for different file sources', async () => {
      const onNavigate = vi.fn();
      renderStringsView(undefined, onNavigate);
      await waitFor(() => screen.getByTestId('string-row-2'));

      fireEvent.click(screen.getByTestId('string-row-2'));

      expect(onNavigate).toHaveBeenCalledWith('com/example/app/Auth.java', 30, 'jadx');
    });
  });

  describe('Certificates section', () => {
    it('renders the certificates section', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('certs-section')).toBeInTheDocument();
      });
    });

    it('shows count of certificate entries', async () => {
      renderStringsView();
      await waitFor(() => {
        const section = screen.getByTestId('certs-section');
        expect(section).toHaveTextContent('Certificates & Keys');
        expect(section).toHaveTextContent('(2)');
      });
    });

    it('renders certificate table headers', async () => {
      renderStringsView();
      await waitFor(() => {
        const table = screen.getByTestId('certs-data-table');
        const headers = table.querySelectorAll('th');
        expect(headers[0]).toHaveTextContent('Type');
        expect(headers[1]).toHaveTextContent('Value');
        expect(headers[2]).toHaveTextContent('File');
        expect(headers[3]).toHaveTextContent('Line');
      });
    });

    it('renders certificate rows', async () => {
      renderStringsView();
      await waitFor(() => {
        const row0 = screen.getByTestId('cert-row-0');
        expect(row0).toHaveTextContent('private-key');
        expect(row0).toHaveTextContent('-----BEGIN PRIVATE KEY-----');
        expect(row0).toHaveTextContent('assets/cert.pem');

        const row1 = screen.getByTestId('cert-row-1');
        expect(row1).toHaveTextContent('certificate');
        expect(row1).toHaveTextContent('-----BEGIN CERTIFICATE-----');
        expect(row1).toHaveTextContent('assets/server.crt');
      });
    });

    it('renders certificate type badges', async () => {
      renderStringsView();
      await waitFor(() => {
        expect(screen.getByTestId('cert-type-badge-0')).toHaveTextContent('private-key');
        expect(screen.getByTestId('cert-type-badge-1')).toHaveTextContent('certificate');
      });
    });

    it('calls onNavigate when a certificate row is clicked', async () => {
      const onNavigate = vi.fn();
      renderStringsView(undefined, onNavigate);
      await waitFor(() => screen.getByTestId('cert-row-0'));

      fireEvent.click(screen.getByTestId('cert-row-0'));

      expect(onNavigate).toHaveBeenCalledWith('assets/cert.pem', 1, 'apktool');
    });
  });

  describe('conditional section rendering', () => {
    it('hides URLs section when no URLs exist', async () => {
      const ws = createMockWs({
        urls: [],
        strings: [
          { value: 'some-secret', type: 'api-key', filePath: 'Foo.java', fileSource: 'jadx', lineNumber: 1 },
        ],
      });
      renderStringsView(ws);
      await waitFor(() => {
        expect(screen.getByTestId('strings-view')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('urls-section')).not.toBeInTheDocument();
      expect(screen.getByTestId('strings-section')).toBeInTheDocument();
    });

    it('hides strings section when no interesting strings exist', async () => {
      const ws = createMockWs({
        urls: [{ url: 'https://example.com', domain: 'example.com', filePath: 'Foo.java', fileSource: 'jadx', lineNumber: 1 }],
        strings: [
          { value: '-----BEGIN PRIVATE KEY-----', type: 'private-key', filePath: 'cert.pem', fileSource: 'apktool', lineNumber: 1 },
        ],
      });
      renderStringsView(ws);
      await waitFor(() => {
        expect(screen.getByTestId('strings-view')).toBeInTheDocument();
      });
      expect(screen.getByTestId('urls-section')).toBeInTheDocument();
      expect(screen.queryByTestId('strings-section')).not.toBeInTheDocument();
      expect(screen.getByTestId('certs-section')).toBeInTheDocument();
    });

    it('hides certificates section when no certs exist', async () => {
      const ws = createMockWs({
        urls: [{ url: 'https://example.com', domain: 'example.com', filePath: 'Foo.java', fileSource: 'jadx', lineNumber: 1 }],
        strings: [
          { value: '192.168.1.1', type: 'ip-address', filePath: 'Foo.java', fileSource: 'jadx', lineNumber: 5 },
        ],
      });
      renderStringsView(ws);
      await waitFor(() => {
        expect(screen.getByTestId('strings-view')).toBeInTheDocument();
      });
      expect(screen.getByTestId('urls-section')).toBeInTheDocument();
      expect(screen.getByTestId('strings-section')).toBeInTheDocument();
      expect(screen.queryByTestId('certs-section')).not.toBeInTheDocument();
    });
  });

  describe('library path exclusion', () => {
    // URLs in com/example/app/ paths: ApiClient, AuthService, Analytics (3 of 4)
    // Strings in com/example/app/ paths: Config, NetworkHelper, Auth (3 of 5, certs are in assets/)
    const excludedPaths = ['com.example.app'];

    it('filters URLs from excluded paths when showLibrary is false', async () => {
      renderStringsView(undefined, undefined, { excludedPaths, showLibrary: false });
      await waitFor(() => {
        expect(screen.getByTestId('strings-view')).toBeInTheDocument();
      });
      // Only cdn.example.com URL remains (from res/values/strings.xml)
      const urlsSection = screen.getByTestId('urls-section');
      expect(urlsSection).toHaveTextContent('1 URL across 1 domain');
      // api.example.com and tracking.ads.com domains should be gone
      expect(screen.queryByTestId('domain-group-api.example.com')).not.toBeInTheDocument();
      expect(screen.queryByTestId('domain-group-tracking.ads.com')).not.toBeInTheDocument();
      expect(screen.getByTestId('domain-group-cdn.example.com')).toBeInTheDocument();
    });

    it('filters strings from excluded paths when showLibrary is false', async () => {
      renderStringsView(undefined, undefined, { excludedPaths, showLibrary: false });
      await waitFor(() => {
        expect(screen.getByTestId('strings-view')).toBeInTheDocument();
      });
      // All 3 interesting strings (api-key, ip-address, token) are in com/example/app/ so section should be hidden
      expect(screen.queryByTestId('strings-section')).not.toBeInTheDocument();
      // Certs in assets/ path should still show
      expect(screen.getByTestId('certs-section')).toBeInTheDocument();
    });

    it('shows all when showLibrary is true', async () => {
      renderStringsView(undefined, undefined, { excludedPaths, showLibrary: true });
      await waitFor(() => {
        expect(screen.getByTestId('strings-view')).toBeInTheDocument();
      });
      expect(screen.getByTestId('urls-section')).toHaveTextContent('4 URLs across 3 domains');
      expect(screen.getByTestId('strings-section')).toBeInTheDocument();
    });

    it('shows hidden count note when items are filtered', async () => {
      renderStringsView(undefined, undefined, { excludedPaths, showLibrary: false });
      await waitFor(() => {
        expect(screen.getByTestId('strings-hidden-count')).toBeInTheDocument();
      });
    });
  });

  describe('singular/plural labels', () => {
    it('uses singular for 1 URL across 1 domain', async () => {
      const ws = createMockWs({
        urls: [{ url: 'https://example.com', domain: 'example.com', filePath: 'Foo.java', fileSource: 'jadx', lineNumber: 1 }],
        strings: [],
      });
      renderStringsView(ws);
      await waitFor(() => {
        const section = screen.getByTestId('urls-section');
        expect(section).toHaveTextContent('1 URL across 1 domain');
      });
    });
  });
});
