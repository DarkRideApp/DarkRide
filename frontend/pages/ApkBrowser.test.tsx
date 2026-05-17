import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApkBrowser } from './ApkBrowser';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const mockAnalyses = [
  {
    id: 3, apkVersionId: 10, status: 'completed', stage: 'done', error: null,
    createdAt: 1700000000, startedAt: 1700000010, completedAt: 1700000060,
    trackedAppId: 1, packageName: 'com.example.app', appName: 'Example App', versionCode: 200, versionName: '2.0.0',
  },
  {
    id: 2, apkVersionId: 11, status: 'failed', stage: null, error: 'Decompile failed',
    createdAt: 1700000000, startedAt: 1700000010, completedAt: null,
    trackedAppId: 2, packageName: 'com.other.app', appName: null, versionCode: 100, versionName: '1.0',
  },
  {
    id: 1, apkVersionId: 12, status: 'pending', stage: null, error: null,
    createdAt: 1700000000, startedAt: null, completedAt: null,
    trackedAppId: 3, packageName: 'com.pending.app', appName: 'Pending App', versionCode: 50, versionName: null,
  },
];

function createMockWs(analyses = mockAnalyses): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((_method: string, path: string) => {
      if (path === '/v1/apps/analysis-jobs/recent') {
        return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: analyses } });
      }
      if (path === '/v1/apps/tracked') {
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: [] } });
      }
      if (path === '/v1/apps/recent') {
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: [] } });
      }
      if (path === '/v1/device/list') {
        return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true, data: [] } });
      }
      if (path === '/v1/frida/gadget/injected') {
        return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { success: true, data: [] } });
      }
      return Promise.resolve({ type: 'restapi', id: '99', status: 200, body: { success: true, data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderApkBrowser(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  render(
    <WebSocketContext.Provider value={mockWs}>
      <ToastProvider>
        <MemoryRouter>
          <ApkBrowser />
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
  return mockWs;
}

describe('ApkBrowser - Analysis tab', () => {
  it('renders Analysis tab in tab strip', async () => {
    renderApkBrowser();
    await waitFor(() => {
      expect(screen.getByText('Analysis')).toBeInTheDocument();
    });
  });

  it('clicking Analysis tab shows analysis table content', async () => {
    renderApkBrowser();
    await waitFor(() => {
      expect(screen.getByText('Analysis')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Analysis'));
    await waitFor(() => {
      expect(screen.getByText('Example App')).toBeInTheDocument();
      expect(screen.getByText('com.other.app')).toBeInTheDocument();
      expect(screen.getByText('Pending App')).toBeInTheDocument();
    });
  });

  it('completed analysis shows "View" button', async () => {
    renderApkBrowser();
    await waitFor(() => expect(screen.getByText('Analysis')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Analysis'));
    await waitFor(() => {
      expect(screen.getByTestId('analysis-view-3')).toBeInTheDocument();
      expect(screen.getByTestId('analysis-view-3')).toHaveTextContent('View');
    });
  });

  it('failed analysis shows "Analyze" retry button', async () => {
    renderApkBrowser();
    await waitFor(() => expect(screen.getByText('Analysis')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Analysis'));
    await waitFor(() => {
      expect(screen.getByTestId('analysis-retry-2')).toBeInTheDocument();
      expect(screen.getByTestId('analysis-retry-2')).toHaveTextContent('Analyze');
    });
  });

  it('shows empty state when no analyses', async () => {
    renderApkBrowser(createMockWs([]));
    await waitFor(() => expect(screen.getByText('Analysis')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Analysis'));
    await waitFor(() => {
      expect(screen.getByText('No analysis jobs yet')).toBeInTheDocument();
    });
  });

  it('shows status badges for different job states', async () => {
    renderApkBrowser();
    await waitFor(() => expect(screen.getByText('Analysis')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Analysis'));
    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeInTheDocument();
      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
  });
});
