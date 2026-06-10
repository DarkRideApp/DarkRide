import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApkAnalysis } from './ApkAnalysis';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';

// Mock react-markdown and plugins
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('rehype-highlight', () => ({ default: () => {} }));
vi.mock('../components/analysis/ReactNativeTab', () => ({
  ReactNativeTab: ({ versionId }: { versionId: string }) => (
    <div data-testid="tab-content-reactnative">ReactNativeTab mock for {versionId}</div>
  ),
}));

const mockOverview = {
  appName: null,
  packageName: 'com.example.app',
  versionName: '1.0.0',
  versionCode: 100,
  manifest: {
    package: 'com.example.app',
    permissions: [
      'android.permission.INTERNET',
      'android.permission.CAMERA',
      'android.permission.ACCESS_FINE_LOCATION',
    ],
    activities: ['com.example.app.MainActivity', 'com.example.app.SettingsActivity'],
    services: ['com.example.app.SyncService'],
    receivers: ['com.example.app.BootReceiver'],
    providers: ['com.example.app.DataProvider'],
    min_sdk: 21,
    target_sdk: 34,
  },
  findingCounts: { critical: 2, high: 5, medium: 10, low: 3, info: 1 },
  findingsByCategory: { secrets: 3, crypto: 4, network: 5 },
  fileCount: 150,
  totalSize: 2048576,
  sourceCounts: { jadx: 120, apktool: 30 },
};

function createMockWs(overviewData = mockOverview, excludedPaths?: string[]): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((_method: string, path: string) => {
      if (path.includes('/v1/settings/analysis_excluded_paths')) {
        if (excludedPaths) {
          return Promise.resolve({
            type: 'restapi', id: '2', status: 200,
            body: { success: true, data: { key: 'analysis_excluded_paths', value: JSON.stringify(excludedPaths) } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '2', status: 404, body: { success: false, error: 'Setting not found' } });
      }
      if (path.includes('/findings')) {
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { data: [], total: 0 } });
      }
      if (path.includes('/strings')) {
        return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { data: { urls: [], strings: [] } } });
      }
      if (path.includes('/notes')) {
        if (_method === 'PUT') {
          return Promise.resolve({ type: 'restapi', id: '6', status: 200, body: { success: true, ok: true } });
        }
        return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { success: true, notes: '' } });
      }
      return Promise.resolve({
        type: 'restapi', id: '1', status: 200,
        body: { success: true, data: overviewData },
      });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderApkAnalysis(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  render(
    <ToastProvider>
      <WebSocketContext.Provider value={mockWs}>
        <MemoryRouter initialEntries={['/ui/apps/1/analysis/42']}>
          <Routes>
            <Route path="/ui/apps/:trackedAppId/analysis/:versionId" element={<ApkAnalysis />} />
          </Routes>
        </MemoryRouter>
      </WebSocketContext.Provider>
    </ToastProvider>,
  );
  return mockWs;
}

describe('ApkAnalysis', () => {
  it('renders loading spinner initially', () => {
    const ws = createMockWs();
    // Never resolve the promise
    ws.sendRestApi = vi.fn().mockReturnValue(new Promise(() => {}));
    renderApkAnalysis(ws);
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('fetches overview data on mount', async () => {
    const ws = renderApkAnalysis();
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/apps/analysis/42/overview');
    });
  });

  it('renders the page with testid after loading', async () => {
    renderApkAnalysis();
    await waitFor(() => {
      expect(screen.getByTestId('apk-analysis-page')).toBeInTheDocument();
    });
  });

  it('renders tab bar with 5 tabs', async () => {
    renderApkAnalysis();
    await waitFor(() => {
      expect(screen.getByTestId('tab-overview')).toBeInTheDocument();
      expect(screen.getByTestId('tab-code')).toBeInTheDocument();
      expect(screen.getByTestId('tab-findings')).toBeInTheDocument();
      expect(screen.getByTestId('tab-strings')).toBeInTheDocument();
      expect(screen.getByTestId('tab-notes')).toBeInTheDocument();
    });
  });

  it('shows overview tab as active by default', async () => {
    renderApkAnalysis();
    await waitFor(() => {
      const overviewTab = screen.getByTestId('tab-overview');
      expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('switches active tab on click', async () => {
    renderApkAnalysis();
    await waitFor(() => screen.getByTestId('tab-code'));
    fireEvent.click(screen.getByTestId('tab-code'));
    expect(screen.getByTestId('tab-code')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('tab-overview')).toHaveAttribute('aria-selected', 'false');
  });

  describe('Overview tab content', () => {
    it('displays package name', async () => {
      renderApkAnalysis();
      await waitFor(() => {
        // Package name appears in the page header title (and possibly elsewhere)
        const matches = screen.getAllByText('com.example.app');
        expect(matches.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('displays SDK versions', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-content-overview'));
      const statCards = screen.getAllByTestId('stat-card');
      const sdkText = statCards.map(c => c.textContent).join(' ');
      expect(sdkText).toMatch('21');
      expect(sdkText).toMatch('34');
    });

    it('displays file count and total size', async () => {
      renderApkAnalysis();
      await waitFor(() => {
        expect(screen.getByText('150')).toBeInTheDocument();
        // 2048576 bytes = ~2.0 MB
        expect(screen.getByText('2.0 MB')).toBeInTheDocument();
      });
    });

    it('displays permissions list', async () => {
      renderApkAnalysis();
      await waitFor(() => {
        expect(screen.getByText('android.permission.INTERNET')).toBeInTheDocument();
        expect(screen.getByText('android.permission.CAMERA')).toBeInTheDocument();
        expect(screen.getByText('android.permission.ACCESS_FINE_LOCATION')).toBeInTheDocument();
      });
    });

    it('displays manifest components', async () => {
      renderApkAnalysis();
      await waitFor(() => {
        expect(screen.getByTestId('manifest-activities')).toBeInTheDocument();
        expect(screen.getByTestId('manifest-services')).toBeInTheDocument();
        expect(screen.getByTestId('manifest-receivers')).toBeInTheDocument();
        expect(screen.getByTestId('manifest-providers')).toBeInTheDocument();
      });
    });

    it('displays activity names when section is expanded', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('manifest-activities'));
      // Expand the activities section
      const activitiesSection = screen.getByTestId('manifest-activities');
      const expandBtn = activitiesSection.querySelector('button')!;
      fireEvent.click(expandBtn);
      expect(screen.getByText('com.example.app.MainActivity')).toBeInTheDocument();
      expect(screen.getByText('com.example.app.SettingsActivity')).toBeInTheDocument();
    });

    it('displays security findings summary with severity badges', async () => {
      renderApkAnalysis();
      await waitFor(() => {
        expect(screen.getByTestId('findings-summary')).toBeInTheDocument();
        expect(screen.getByTestId('severity-critical')).toBeInTheDocument();
        expect(screen.getByTestId('severity-high')).toBeInTheDocument();
        expect(screen.getByTestId('severity-medium')).toBeInTheDocument();
        expect(screen.getByTestId('severity-low')).toBeInTheDocument();
        expect(screen.getByTestId('severity-info')).toBeInTheDocument();
      });
    });

    it('displays correct finding counts per severity', async () => {
      renderApkAnalysis();
      await waitFor(() => {
        expect(screen.getByTestId('severity-critical')).toHaveTextContent('2');
        expect(screen.getByTestId('severity-high')).toHaveTextContent('5');
        expect(screen.getByTestId('severity-medium')).toHaveTextContent('10');
        expect(screen.getByTestId('severity-low')).toHaveTextContent('3');
        expect(screen.getByTestId('severity-info')).toHaveTextContent('1');
      });
    });

    it('displays source counts', async () => {
      renderApkAnalysis();
      await waitFor(() => {
        // Source counts shown in the overview tab stats
        expect(screen.getByText(/jadx: \d+/i)).toBeInTheDocument();
        expect(screen.getByText(/apktool: \d+/i)).toBeInTheDocument();
      });
    });

    it('displays React Native and Hermes framework badges when present', async () => {
      const ws = createMockWs({
        ...mockOverview,
        manifest: {
          ...mockOverview.manifest,
          frameworks: {
            detected: [
              { name: 'React Native', details: { hermesEngine: true, hermesBundlePath: 'assets/index.android.bundle' } },
            ],
            libraries: [],
            buildInfo: null,
            reactNative: true,
            hermesEngine: true,
          },
        },
      });
      renderApkAnalysis(ws);
      await waitFor(() => {
        expect(screen.getAllByText('React Native').length).toBeGreaterThanOrEqual(1);
      });
      expect(screen.getByTestId('frameworks-card')).toBeInTheDocument();
    });

    it('displays hermes error when present', async () => {
      const ws = createMockWs({
        ...mockOverview,
        manifest: {
          ...mockOverview.manifest,
          frameworks: {
            detected: [{ name: 'React Native', details: {} }],
            libraries: [],
            buildInfo: null,
            reactNative: true,
            hermesEngine: true,
            hermesError: 'Command timed out after 300000ms',
          },
        },
      });
      renderApkAnalysis(ws);
      await waitFor(() => {
        expect(screen.getByTestId('hermes-error')).toHaveTextContent('Hermes decompile error: Command timed out after 300000ms');
      });
    });

    it('displays hermes note when present', async () => {
      const ws = createMockWs({
        ...mockOverview,
        manifest: {
          ...mockOverview.manifest,
          frameworks: {
            detected: [{ name: 'React Native', details: {} }],
            libraries: [],
            buildInfo: null,
            reactNative: true,
            hermesEngine: false,
            hermesNote: 'Plain JavaScript bundle (not Hermes bytecode)',
          },
        },
      });
      renderApkAnalysis(ws);
      await waitFor(() => {
        expect(screen.getByTestId('hermes-note')).toHaveTextContent('Plain JavaScript bundle (not Hermes bytecode)');
      });
    });
  });

  describe('error handling', () => {
    it('shows error message when API fails', async () => {
      const ws = createMockWs();
      ws.sendRestApi = vi.fn().mockResolvedValue({
        type: 'restapi',
        id: '1',
        status: 404,
        body: { success: false, error: 'Analysis database not found' },
      });
      renderApkAnalysis(ws);
      await waitFor(() => {
        expect(screen.getByTestId('analysis-error')).toBeInTheDocument();
      });
    });
  });

  describe('empty data', () => {
    it('handles empty permissions gracefully', async () => {
      const ws = createMockWs({
        ...mockOverview,
        manifest: { ...mockOverview.manifest, permissions: [] },
      });
      renderApkAnalysis(ws);
      await waitFor(() => {
        expect(screen.getByTestId('apk-analysis-page')).toBeInTheDocument();
      });
    });

    it('handles missing manifest components gracefully', async () => {
      const ws = createMockWs({
        ...mockOverview,
        manifest: {
          package: 'com.test',
          permissions: [],
          activities: [],
          services: [],
          receivers: [],
          providers: [],
          min_sdk: 21,
          target_sdk: 34,
        },
      });
      renderApkAnalysis(ws);
      await waitFor(() => {
        expect(screen.getByTestId('apk-analysis-page')).toBeInTheDocument();
      });
    });

    it('handles zero findings gracefully', async () => {
      const ws = createMockWs({
        ...mockOverview,
        findingCounts: {},
      });
      renderApkAnalysis(ws);
      await waitFor(() => {
        expect(screen.getByTestId('apk-analysis-page')).toBeInTheDocument();
      });
    });
  });

  describe('library toggle', () => {
    it('shows toggle button on findings tab when excluded paths are configured', async () => {
      const ws = createMockWs(mockOverview, ['com.example']);
      renderApkAnalysis(ws);
      await waitFor(() => screen.getByTestId('tab-findings'));
      fireEvent.click(screen.getByTestId('tab-findings'));
      await waitFor(() => {
        expect(screen.getByTestId('toggle-library')).toBeInTheDocument();
      });
    });

    it('shows toggle button on strings tab when excluded paths are configured', async () => {
      const ws = createMockWs(mockOverview, ['com.example']);
      renderApkAnalysis(ws);
      await waitFor(() => screen.getByTestId('tab-strings'));
      fireEvent.click(screen.getByTestId('tab-strings'));
      await waitFor(() => {
        expect(screen.getByTestId('toggle-library')).toBeInTheDocument();
      });
    });

    it('does not show toggle button on overview tab', async () => {
      const ws = createMockWs(mockOverview, ['com.example']);
      renderApkAnalysis(ws);
      await waitFor(() => screen.getByTestId('apk-analysis-page'));
      expect(screen.queryByTestId('toggle-library')).not.toBeInTheDocument();
    });

    it('does not show toggle button when no excluded paths configured', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-findings'));
      fireEvent.click(screen.getByTestId('tab-findings'));
      // Toggle not visible because excluded paths are empty (404 from settings endpoint)
      expect(screen.queryByTestId('toggle-library')).not.toBeInTheDocument();
    });
  });

  describe('tab placeholder content', () => {
    it('shows code tab placeholder when code tab is active', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-code'));
      fireEvent.click(screen.getByTestId('tab-code'));
      expect(screen.getByTestId('tab-content-code')).toBeInTheDocument();
    });

    it('shows findings tab placeholder when findings tab is active', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-findings'));
      fireEvent.click(screen.getByTestId('tab-findings'));
      expect(screen.getByTestId('tab-content-findings')).toBeInTheDocument();
    });

    it('shows strings tab placeholder when strings tab is active', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-strings'));
      fireEvent.click(screen.getByTestId('tab-strings'));
      expect(screen.getByTestId('tab-content-strings')).toBeInTheDocument();
    });

    it('shows notes tab content when notes tab is active', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      expect(screen.getByTestId('tab-content-notes')).toBeInTheDocument();
    });
  });

  describe('Notes tab', () => {
    it('fetches notes on mount', async () => {
      const ws = renderApkAnalysis();
      await waitFor(() => {
        expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/apps/analysis/42/notes');
      });
    });

    it('renders markdown in view mode by default (empty state)', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => {
        expect(screen.getByTestId('notes-empty')).toBeInTheDocument();
        expect(screen.getByTestId('edit-notes-btn')).toBeInTheDocument();
      });
    });

    it('renders saved notes as markdown in view mode', async () => {
      const ws = createMockWs();
      ws.sendRestApi = vi.fn().mockImplementation((_method: string, p: string) => {
        if (p.includes('/notes') && _method === 'GET') {
          return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { success: true, notes: '# Hello' } });
        }
        if (p.includes('/overview')) {
          return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: mockOverview } });
        }
        if (p.includes('/settings/')) {
          return Promise.resolve({ type: 'restapi', id: '2', status: 404, body: { success: false } });
        }
        return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: {} });
      });
      renderApkAnalysis(ws);
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => {
        expect(screen.getByTestId('notes-rendered')).toBeInTheDocument();
      });
      expect(screen.getByText('# Hello')).toBeInTheDocument();
    });

    it('edit button switches to side-by-side editor+preview', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => screen.getByTestId('edit-notes-btn'));
      fireEvent.click(screen.getByTestId('edit-notes-btn'));
      expect(screen.getByTestId('notes-textarea')).toBeInTheDocument();
      expect(screen.getByTestId('notes-preview')).toBeInTheDocument();
      expect(screen.getByTestId('cancel-notes-btn')).toBeInTheDocument();
    });

    it('cancel discards changes and returns to view mode', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => screen.getByTestId('edit-notes-btn'));
      fireEvent.click(screen.getByTestId('edit-notes-btn'));
      fireEvent.change(screen.getByTestId('notes-textarea'), { target: { value: 'unsaved change' } });
      fireEvent.click(screen.getByTestId('cancel-notes-btn'));
      // Should be back in view mode
      expect(screen.getByTestId('edit-notes-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('notes-textarea')).not.toBeInTheDocument();
    });

    it('save calls PUT and returns to view mode', async () => {
      const ws = renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => screen.getByTestId('edit-notes-btn'));
      fireEvent.click(screen.getByTestId('edit-notes-btn'));
      fireEvent.change(screen.getByTestId('notes-textarea'), { target: { value: 'my notes' } });
      fireEvent.click(screen.getByTestId('save-notes-btn'));
      await waitFor(() => {
        expect(ws.sendRestApi).toHaveBeenCalledWith('PUT', '/v1/apps/analysis/42/notes', { notes: 'my notes' });
      });
      // After successful save, should return to view mode
      await waitFor(() => {
        expect(screen.getByTestId('edit-notes-btn')).toBeInTheDocument();
      });
    });

    it('save button is disabled when notes have not changed', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => screen.getByTestId('edit-notes-btn'));
      fireEvent.click(screen.getByTestId('edit-notes-btn'));
      expect(screen.getByTestId('save-notes-btn')).toBeDisabled();
    });

    it('save button is enabled after editing notes', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => screen.getByTestId('edit-notes-btn'));
      fireEvent.click(screen.getByTestId('edit-notes-btn'));
      fireEvent.change(screen.getByTestId('notes-textarea'), { target: { value: 'new content' } });
      expect(screen.getByTestId('save-notes-btn')).not.toBeDisabled();
    });

    it('dirty indicator shows when unsaved changes exist', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => screen.getByTestId('edit-notes-btn'));
      fireEvent.click(screen.getByTestId('edit-notes-btn'));
      expect(screen.queryByTestId('unsaved-indicator')).not.toBeInTheDocument();
      fireEvent.change(screen.getByTestId('notes-textarea'), { target: { value: 'dirty' } });
      expect(screen.getByTestId('unsaved-indicator')).toBeInTheDocument();
    });

    it('WS broadcast updates notes when not editing', async () => {
      const subscribers = new Map<string, (msg: any) => void>();
      const ws = createMockWs();
      ws.subscribe = vi.fn().mockImplementation((type: string, cb: (msg: any) => void) => {
        subscribers.set(type, cb);
        return () => { subscribers.delete(type); };
      });
      // Return some notes initially
      const origSendRestApi = ws.sendRestApi;
      ws.sendRestApi = vi.fn().mockImplementation((_method: string, p: string, body?: any) => {
        if (p.includes('/notes') && _method === 'GET') {
          return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { success: true, notes: 'initial' } });
        }
        return (origSendRestApi as any)(_method, p, body);
      });
      renderApkAnalysis(ws);
      await waitFor(() => screen.getByTestId('tab-notes'));
      fireEvent.click(screen.getByTestId('tab-notes'));
      await waitFor(() => {
        expect(screen.getByTestId('notes-rendered')).toBeInTheDocument();
      });

      // Simulate WS broadcast
      const cb = subscribers.get('apk:notes-updated');
      expect(cb).toBeDefined();
      act(() => {
        cb!({ versionId: 42, notes: '# Updated by AI' });
      });

      await waitFor(() => {
        expect(screen.getByText('# Updated by AI')).toBeInTheDocument();
      });
    });
  });

  it('renders APK download button in the More actions menu', async () => {
    renderApkAnalysis();
    await waitFor(() => screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await waitFor(() => expect(screen.getByTestId('menu-item-download')).toBeInTheDocument());
  });

  describe('re-analyze button', () => {
    it('renders re-analyze item in the More actions menu', async () => {
      renderApkAnalysis();
      await waitFor(() => screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      await waitFor(() => expect(screen.getByTestId('menu-item-reanalyze')).toBeInTheDocument());
      expect(screen.getByTestId('menu-item-reanalyze')).toHaveTextContent('Re-analyze');
      expect(screen.getByTestId('menu-item-reanalyze')).not.toBeDisabled();
    });

    it('calls POST analyze endpoint on click', async () => {
      const mockWs = createMockWs();
      renderApkAnalysis(mockWs);
      await waitFor(() => screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      await waitFor(() => screen.getByTestId('menu-item-reanalyze'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('menu-item-reanalyze'));
      });
      expect(mockWs.sendRestApi).toHaveBeenCalledWith('POST', '/v1/apps/analyze/42');
    });

    it('shows reanalyze-strip status strip after clicking', async () => {
      const mockWs = createMockWs();
      // Make the POST hang so we can see the pending state
      mockWs.sendRestApi = vi.fn().mockImplementation((_method: string, path: string) => {
        if (_method === 'POST' && path.includes('/analyze/')) {
          return new Promise(() => {}); // never resolves
        }
        if (path.includes('/notes')) {
          return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { success: true, notes: '' } });
        }
        if (path.includes('/settings/')) {
          return Promise.resolve({ type: 'restapi', id: '2', status: 404, body: { success: false } });
        }
        return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: mockOverview } });
      });
      renderApkAnalysis(mockWs);
      await waitFor(() => screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      await waitFor(() => screen.getByTestId('menu-item-reanalyze'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('menu-item-reanalyze'));
      });
      expect(screen.getByTestId('reanalyze-strip')).toBeInTheDocument();
    });

    it('shows stage label in status strip during analysis and hides on completion', async () => {
      let analysisCallback: ((msg: any) => void) | null = null;
      const mockWs = createMockWs();
      mockWs.subscribe = vi.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'apk:analysis-update') analysisCallback = cb;
        return () => {};
      });
      renderApkAnalysis(mockWs);
      await waitFor(() => screen.getByTestId('apk-analysis-page'));

      // Simulate running stage update
      await act(async () => {
        analysisCallback?.({ apkVersionId: 42, status: 'running', stage: 'metadata' });
      });
      expect(screen.getByTestId('reanalyze-strip')).toBeInTheDocument();
      expect(screen.getByTestId('reanalyze-strip')).toHaveTextContent('Metadata');

      // Simulate completion
      await act(async () => {
        analysisCallback?.({ apkVersionId: 42, status: 'completed', stage: 'done' });
      });
      expect(screen.queryByTestId('reanalyze-strip')).not.toBeInTheDocument();
    });

    it('ignores analysis updates for other versions', async () => {
      let analysisCallback: ((msg: any) => void) | null = null;
      const mockWs = createMockWs();
      mockWs.subscribe = vi.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'apk:analysis-update') analysisCallback = cb;
        return () => {};
      });
      renderApkAnalysis(mockWs);
      await waitFor(() => screen.getByTestId('apk-analysis-page'));

      // Update for a different version — no strip should appear
      await act(async () => {
        analysisCallback?.({ apkVersionId: 999, status: 'running', stage: 'scan' });
      });
      expect(screen.queryByTestId('reanalyze-strip')).not.toBeInTheDocument();
    });
  });

  describe('frameworks detection display', () => {
    const frameworksOverview = {
      ...mockOverview,
      manifest: {
        ...mockOverview.manifest,
        frameworks: {
          detected: [
            { name: 'Flutter', details: {} },
            { name: 'React Native', details: { hermesEngine: true, hermesBundlePath: 'assets/index.android.bundle' } },
          ],
          libraries: [
            { name: 'Firebase', packages: ['com/google/firebase/'] },
            { name: 'OkHttp', packages: ['okhttp3/'] },
          ],
          buildInfo: {
            compiler: ['d8'],
            packer: [],
            obfuscator: ['ProGuard'],
            anti_analysis: [],
          },
          reactNative: true,
          hermesEngine: true,
        },
      },
    };

    it('shows frameworks section with detected framework badges', async () => {
      renderApkAnalysis(createMockWs(frameworksOverview));
      await waitFor(() => {
        expect(screen.getByTestId('frameworks-card')).toBeInTheDocument();
      });
      expect(screen.getByText('Flutter')).toBeInTheDocument();
      expect(screen.getAllByText('React Native').length).toBeGreaterThanOrEqual(1);
    });

    it('shows libraries section with library badges', async () => {
      renderApkAnalysis(createMockWs(frameworksOverview));
      await waitFor(() => {
        expect(screen.getByTestId('libraries-section')).toBeInTheDocument();
      });
      expect(screen.getByText('Firebase')).toBeInTheDocument();
      expect(screen.getByText('OkHttp')).toBeInTheDocument();
    });

    it('shows build info section with compiler and obfuscator', async () => {
      renderApkAnalysis(createMockWs(frameworksOverview));
      await waitFor(() => {
        expect(screen.getByTestId('build-info-section')).toBeInTheDocument();
      });
      expect(screen.getByText('d8')).toBeInTheDocument();
      expect(screen.getByText('ProGuard')).toBeInTheDocument();
    });

    it('shows React Native tab when reactNative is truthy', async () => {
      renderApkAnalysis(createMockWs(frameworksOverview));
      await waitFor(() => {
        expect(screen.getByTestId('tab-reactnative')).toBeInTheDocument();
      });
      // Tab button should have React Native text
      expect(screen.getByTestId('tab-reactnative').textContent).toBe('React Native');
    });

    it('hides React Native tab when no RN framework', async () => {
      renderApkAnalysis();
      await waitFor(() => {
        expect(screen.getByTestId('tab-overview')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('tab-reactnative')).not.toBeInTheDocument();
    });

    it('hides frameworks card when all sections empty', async () => {
      const emptyFrameworks = {
        ...mockOverview,
        manifest: {
          ...mockOverview.manifest,
          frameworks: {
            detected: [],
            libraries: [],
            buildInfo: { compiler: [], packer: [], obfuscator: [], anti_analysis: [] },
          },
        },
      };
      renderApkAnalysis(createMockWs(emptyFrameworks));
      await waitFor(() => {
        expect(screen.getByTestId('tab-content-overview')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('frameworks-card')).not.toBeInTheDocument();
    });
  });
});
