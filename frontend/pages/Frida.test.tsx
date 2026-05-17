import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext, WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { Frida } from './Frida';

function makeWs(): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && (path === '/v1/devices' || path === '/v1/device/list')) {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: [{ id: 'dev-1', name: 'Test' }] },
        });
      }
      return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: [] } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as any;
}

// Monaco is imported dynamically inside Frida; stub the module so jsdom doesn't blow up.
vi.mock('monaco-editor', () => ({
  editor: {
    create: vi.fn(() => ({
      getValue: () => '',
      dispose: vi.fn(),
      onDidChangeModelContent: vi.fn(),
      addAction: vi.fn(),
    })),
  },
  KeyMod: { CtrlCmd: 0 },
  KeyCode: { KeyS: 0 },
}));

// Frida touches window.matchMedia when setting Monaco theme; jsdom has no implementation by default.
beforeEach(() => {
  if (!window.matchMedia) {
    (window as any).matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }
});

describe('Frida page — DeviceViewer integration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('after selecting a device, sends device-stream-start via DeviceViewer', async () => {
    const ws = makeWs();
    const { container } = render(
      <WebSocketContext.Provider value={ws}>
        <MemoryRouter><Frida /></MemoryRouter>
      </WebSocketContext.Provider>,
    );

    // Device dropdown populates from the /v1/device/list REST call (first <select> in the page).
    // Wait for the mock device option to render, then select it to mount DeviceViewer.
    await waitFor(() => {
      const firstSelect = container.querySelector('select');
      expect(firstSelect?.querySelector('option[value="dev-1"]')).toBeTruthy();
    });
    const deviceSelect = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(deviceSelect, { target: { value: 'dev-1' } });

    await waitFor(() => {
      // Any call to device-stream-start with the mock device id confirms the DeviceViewer was mounted
      const calls = (ws.sendMessage as any).mock.calls.filter((c: any[]) => c[0] === 'device-stream-start');
      expect(calls.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
  });
});
