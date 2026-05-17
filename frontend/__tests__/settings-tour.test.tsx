import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext, AuthContext, ToastProvider, useToast } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue, AuthState } from '@darkrideapp/plugin-sdk/react';

import { NotificationsPage } from '../pages/settings/NotificationsPage';
import { IntegrationsPage } from '../pages/settings/IntegrationsPage';
import { AIPage } from '../pages/settings/AIPage';
import { AnalysisPage } from '../pages/settings/AnalysisPage';
import { CloudStoragePage } from '../pages/settings/CloudStoragePage';
import { CertificatesPage } from '../pages/settings/CertificatesPage';
import { TrafficSettingsPage } from '../pages/settings/TrafficSettingsPage';
import { ChangelogPage } from '../pages/settings/ChangelogPage';
import { LicensePage } from '../pages/settings/LicensePage';
import { Proxies } from '../pages/Proxies';
import { Credentials } from '../pages/Credentials';
import { Jobs } from '../pages/Jobs';
import { McpSettings } from '../pages/McpSettings';
import { Utils } from '../pages/Utils';
import { SdkCatalog } from '../pages/SdkCatalog';

/**
 * Settings-page tour: render each settings page in turn with a mock WS that
 * returns reasonable empty defaults for anything we don't explicitly handle.
 * Assert no toast.error() calls fire during initial render — settings pages
 * MUST handle "expected absence" responses (404 settings keys, empty lists,
 * etc.) without flashing a global error toast.
 *
 * Regression test for the /ui/settings/mcp "Setting not found" toast bug,
 * generalised to every settings page so a future regression on any page
 * surfaces immediately.
 */

// Default mock WS: returns success:true with empty/null data for any GET, and
// status 404 with success:false for known optional keys. Individual tests can
// override.
function buildMockWs(handlers?: Record<string, (method: string, body?: any) => any>): WebSocketContextValue {
  let counter = 0;
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string, body?: any) => {
      counter++;
      const id = String(counter);
      const handler = handlers?.[path] ?? handlers?.[`${method} ${path}`];
      if (handler) {
        const handled = handler(method, body);
        return Promise.resolve({ type: 'restapi', id, status: 200, body: handled });
      }
      // Settings keys that are commonly unset on a fresh install — return 404
      // to exercise each page's "missing setting" code path. The whole point
      // of this test is that these MUST NOT flash a toast.
      if (path.startsWith('/v1/settings/') && method === 'GET' && !path.includes('/list') && !path.includes('/defaults/')) {
        return Promise.resolve({
          type: 'restapi',
          id,
          status: 404,
          body: { success: false, error: 'Setting not found' },
        });
      }
      // Paginated endpoints expect a specific data shape.
      if (path.startsWith('/v1/changelog')) {
        return Promise.resolve({
          type: 'restapi', id, status: 200,
          body: { success: true, data: { items: [], total: 0, limit: 50, offset: 0 } },
        });
      }
      // Generic empty-list defaults for known list endpoints.
      if (path.endsWith('/list') || path.endsWith('s') || path.includes('/list')) {
        return Promise.resolve({ type: 'restapi', id, status: 200, body: { success: true, data: [] } });
      }
      // Default: success with empty object.
      return Promise.resolve({ type: 'restapi', id, status: 200, body: { success: true, data: {} } });
    }),
  };
}

const allScopesAuth: AuthState = {
  status: 'authenticated',
  user: { id: 1, username: 'admin', displayName: 'Admin', email: null, scopes: ['core.admin:*'], providerId: 'local' },
  csrfToken: 'csrf',
  hasScope: () => true,
  logout: vi.fn().mockResolvedValue(undefined),
  refreshAuth: vi.fn().mockResolvedValue(undefined),
};

let errorToasts: string[];
function ToastSpy() {
  const toast = useToast();
  React.useEffect(() => {
    errorToasts = [];
    const orig = toast.error.bind(toast);
    toast.error = (msg: string) => {
      errorToasts.push(msg);
      return orig(msg);
    };
  }, [toast]);
  return null;
}

function renderPage(
  Component: React.ComponentType,
  initialEntry = '/ui/settings/test',
  wsHandlers?: Record<string, (method: string, body?: any) => any>,
) {
  errorToasts = [];
  const ws = buildMockWs(wsHandlers);
  return render(
    <WebSocketContext.Provider value={ws}>
      <AuthContext.Provider value={allScopesAuth}>
        <ToastProvider>
          <ToastSpy />
          <MemoryRouter initialEntries={[initialEntry]}>
            <Component />
          </MemoryRouter>
        </ToastProvider>
      </AuthContext.Provider>
    </WebSocketContext.Provider>,
  );
}

describe('Settings tour — every page renders without an error toast', () => {
  beforeEach(() => {
    // jsdom doesn't implement clipboard; some pages use it on mount.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Pages tested below all live under /ui/settings/* in App.tsx.
  // If you add a new settings route, add it here too — that's the whole
  // point of the tour.
  const pages: Array<{ name: string; Component: React.ComponentType }> = [
    { name: 'Notifications', Component: NotificationsPage },
    { name: 'Integrations', Component: IntegrationsPage },
    { name: 'AI', Component: AIPage },
    { name: 'APK Analysis', Component: AnalysisPage },
    { name: 'Cloud Storage', Component: CloudStoragePage },
    { name: 'Certificates', Component: CertificatesPage },
    { name: 'Traffic', Component: TrafficSettingsPage },
    { name: 'Proxies', Component: Proxies },
    { name: 'Credentials', Component: Credentials },
    { name: 'Jobs', Component: Jobs },
    { name: 'MCP Server', Component: McpSettings },
    { name: 'Utilities', Component: Utils },
    { name: 'SDK Catalog', Component: SdkCatalog },
    { name: 'Changelog', Component: ChangelogPage },
    { name: 'License', Component: LicensePage },
  ];

  for (const { name, Component } of pages) {
    it(`${name} renders without flashing an error toast`, async () => {
      renderPage(Component);
      // Let any deferred promise chains / fetches resolve.
      await waitFor(() => {
        // Wait for at least one render cycle; we just need the effects to run.
        // No specific element to wait for — pages vary too much. A short tick
        // is enough since all data comes from awaited promises that resolve
        // synchronously in the mock.
      }, { timeout: 1000 });
      await new Promise((r) => setTimeout(r, 50));

      expect(errorToasts).toEqual([]);
    });
  }
});
