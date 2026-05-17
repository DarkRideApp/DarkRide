import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import { NotificationsPage } from '../NotificationsPage';
import { IntegrationsPage } from '../IntegrationsPage';
import { AIPage } from '../AIPage';
import { AnalysisPage } from '../AnalysisPage';
import { CloudStoragePage } from '../CloudStoragePage';
import { CertificatesPage } from '../CertificatesPage';
import { TrafficSettingsPage } from '../TrafficSettingsPage';
import { ChangelogPage } from '../ChangelogPage';
import { LicensePage } from '../LicensePage';

function makeWs() {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ status: 200, body: { success: true, data: [] } }),
    subscribe: vi.fn(() => () => {}),
    subscribeBinary: vi.fn(() => () => {}),
  };
}

function renderInRouter(node: React.ReactNode) {
  return render(
    <MemoryRouter>
      <WebSocketContext.Provider value={makeWs()}>
        <ToastProvider>
          {node}
        </ToastProvider>
      </WebSocketContext.Provider>
    </MemoryRouter>
  );
}

describe('Extracted Settings pages — smoke render', () => {
  it.each([
    ['NotificationsPage', <NotificationsPage />],
    ['IntegrationsPage', <IntegrationsPage />],
    ['AIPage', <AIPage />],
    ['AnalysisPage', <AnalysisPage />],
    ['CloudStoragePage', <CloudStoragePage />],
    // CertificatesPage is now a back-compat redirect to /ui/settings/traffic
    // (Client Certs merged into Traffic settings on 2026-05-13).
    ['CertificatesPage', <CertificatesPage />],
    ['TrafficSettingsPage', <TrafficSettingsPage />],
    ['ChangelogPage', <ChangelogPage />],
    ['LicensePage', <LicensePage />],
  ])('%s renders', (_name, node) => {
    expect(() => renderInRouter(node)).not.toThrow();
  });
});
