/**
 * Shared test support for the Plugins workspace: fixture builders and a mock
 * websocket whose responses follow the real REST envelope and payload shapes
 * (see backend/api/plugins.ts and backend/api/plugin-consent.ts).
 */
import React from 'react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import type { InstalledPlugin, RegistryPlugin } from './catalog';

export function registryPlugin(over: Partial<RegistryPlugin> & { name: string }): RegistryPlugin {
  return {
    displayName: over.name,
    description: `${over.name} description`,
    author: 'DarkRide',
    repo: `DarkRideApp/plugin-${over.name}`,
    latestVersion: '1.0.0',
    category: 'tools',
    license: 'MIT',
    npmPackage: `@darkride/plugin-${over.name}`,
    source: 'DarkRide Official',
    ...over,
  };
}

export function installedPlugin(over: Partial<InstalledPlugin> & { name: string }): InstalledPlugin {
  return {
    version: '1.0.0',
    description: null,
    author: null,
    enabled: true,
    installedVia: 'managed',
    loaded: true,
    npmPackage: `@darkride/plugin-${over.name}`,
    signature: null,
    signedBy: null,
    lastError: null,
    metadata: null,
    updateAvailable: false,
    ...over,
  };
}

export const NO_SCOPES = {
  success: true,
  state: 'no-scopes',
  manifestScopes: [],
  approvedScopes: null,
  added: [],
  removed: [],
};

export interface MockApiState {
  registry: RegistryPlugin[];
  installed: InstalledPlugin[];
  fetchedAt: number | null;
  /** Per-plugin scope-status bodies; anything not listed answers NO_SCOPES. */
  scopeStatus: Record<string, unknown>;
  /** Make a path answer with a failure. Keyed `${method} ${path}`. */
  failing: Set<string>;
  /** Override a response. Keyed `${method} ${path}`; may be async. */
  routes: Record<string, (body?: any) => unknown | Promise<unknown>>;
}

export function mockApiState(over: Partial<MockApiState> = {}): MockApiState {
  return {
    registry: [],
    installed: [],
    fetchedAt: null,
    scopeStatus: {},
    failing: new Set(),
    routes: {},
    ...over,
  };
}

const envelope = (body: unknown, status = 200) => ({ type: 'restapi', id: 'x', status, body });

export function createMockWs(state: MockApiState): WebSocketContextValue {
  const sendRestApi = vi.fn(async (method: string, path: string, body?: any) => {
    const key = `${method} ${path}`;
    if (state.failing.has(key)) return envelope({ success: false, error: `${key} failed` }, 502);
    const custom = state.routes[key];
    if (custom) return envelope(await custom(body));

    if (key === 'GET /v1/plugins/installed') {
      return envelope({ success: true, data: { plugins: state.installed, darkrideVersion: '1.5.0' } });
    }
    if (key === 'GET /v1/plugins/marketplace' || key === 'POST /v1/plugins/marketplace/refresh') {
      return envelope({ success: true, data: { sources: [], plugins: state.registry, fetchedAt: state.fetchedAt } });
    }
    const scope = /^GET \/v1\/plugins\/([^/]+)\/scope-status$/.exec(key);
    if (scope) return envelope(state.scopeStatus[decodeURIComponent(scope[1])] ?? NO_SCOPES);
    if (/^GET \/v1\/plugins\/[^/]+\/uninstall-footprint$/.test(key)) {
      return envelope({ success: true, data: { tables: [], fileStorageBytes: 0, npmPackage: null } });
    }
    if (key === 'GET /v1/plugins/sources') return envelope({ success: true, data: [] });
    return envelope({ success: true, restartRequired: true });
  });

  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as WebSocketContextValue;
}

/** Providers every Plugins-workspace component expects. */
export function withProviders(ws: WebSocketContextValue, initialEntry = '/ui/plugins') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>
    );
  };
}

/** Paths a mock ws was called with, as `METHOD path`. */
export function calledPaths(ws: WebSocketContextValue): string[] {
  return (ws.sendRestApi as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => `${c[0]} ${c[1]}`,
  );
}
