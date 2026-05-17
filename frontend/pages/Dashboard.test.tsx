import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from './Dashboard';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

const mockDevices = [
  { id: 'dev1', name: 'Pixel 6', isRooted: true, setupVersion: 1, bridgePort: null, lastSeen: new Date().toISOString() },
  { id: 'dev2', name: 'Galaxy S21', isRooted: false, setupVersion: 0, bridgePort: null, lastSeen: null },
];

const mockAutomations = [
  { id: 1, name: 'Test Auto', code: '', passcode: 'abc', requiresHttpsCapture: false, timeoutMs: 300000, isRule: false, priority: 0, createdAt: '', updatedAt: '' },
];

const mockSessions = [
  { id: 1, automationId: 1, deviceId: 'dev1', status: 'success', triggerType: 'manual', logs: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
  { id: 2, automationId: 1, deviceId: 'dev1', status: 'failed', triggerType: 'schedule', logs: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
];

const mockProxies = [
  { id: 1, url: 'http://proxy1:8080', username: null, password: null, failureCount: 0, enabled: true, createdAt: '' },
  { id: 2, url: 'http://proxy2:8080', username: null, password: null, failureCount: 10, enabled: true, createdAt: '' },
];

const mockTrackedApps = [
  { id: 1, packageName: 'com.example.app', appName: 'Example App', versionCount: 3, latestVersion: null },
];

const mockAnalysisJobs = [
  { id: 1, apkVersionId: 1, status: 'completed', stage: null, packageName: 'com.example.app', appName: 'Example App', versionName: '1.0', completedAt: new Date().toISOString(), createdAt: new Date().toISOString(), trackedAppId: 1 },
];

function createMockWs(): WebSocketContextValue {
  return {
    connected: true,
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (path.includes('/device/')) return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { data: mockDevices } });
      if (path.includes('/automation/sessions')) return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { data: mockSessions } });
      if (path.includes('/automation/')) return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { data: mockAutomations } });
      if (path.includes('/proxy/')) return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { data: mockProxies } });
      if (path.includes('/apps/tracked')) return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { data: mockTrackedApps } });
      if (path.includes('/apps/analysis-jobs')) return Promise.resolve({ type: 'restapi', id: '6', status: 200, body: { data: mockAnalysisJobs } });
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderDashboard(ws?: WebSocketContextValue) {
  const mockWs = ws || createMockWs();
  return render(
    <WebSocketContext.Provider value={mockWs}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </WebSocketContext.Provider>
  );
}

describe('Dashboard', () => {
  it('renders dashboard with stat cards', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
      expect(screen.getByTestId('dashboard-stats')).toBeInTheDocument();
    });
  });

  it('displays device count', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Connected Devices')).toBeInTheDocument();
    });
  });

  it('displays proxy info', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Proxies')).toBeInTheDocument();
    });
  });

  it('displays recent sessions table', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('recent-sessions')).toBeInTheDocument();
    });
  });

  it('shows health alerts for failing proxies', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('health-alerts')).toBeInTheDocument();
      expect(screen.getByText(/proxy2/i)).toBeInTheDocument();
    });
  });

  it('displays tracked apps stat card', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Tracked Apps')).toBeInTheDocument();
      expect(screen.getByText('3 APK versions')).toBeInTheDocument();
    });
  });

  it('displays recent analysis jobs table', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('recent-analysis')).toBeInTheDocument();
      expect(screen.getByText('Example App')).toBeInTheDocument();
    });
  });
});
