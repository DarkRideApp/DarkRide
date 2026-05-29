// Mock noVNC so VncViewer renders a plain div (data-testid=vnc-viewer-*)
// without trying to open a real WebSocket in jsdom.
vi.mock('@novnc/novnc', () => ({
  default: class MockRFB {
    addEventListener() {}
    removeEventListener() {}
    disconnect() {}
    scaleViewport = false;
    resizeSession = false;
    constructor(_target: HTMLElement, _url: string, _opts: any) {}
  },
}));

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WebSocketContext, WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import { DeviceView } from './DeviceView';

function makeWs(overrides?: Partial<WebSocketContextValue>): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/v1/device/view/')) {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { id: 'dev-1', name: 'Test Device', platform: 'android', isRooted: true, lastSeen: Date.now() } },
        });
      }
      if (method === 'GET' && path === '/v1/settings/list') {
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: [] } });
      }
      if (method === 'GET' && path.startsWith('/v1/capture/status/')) {
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: { capturing: false } } });
      }
      return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true, data: {} } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as any;
}

function renderAtDeviceRoute(ws: WebSocketContextValue) {
  return render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/ui/devices/dev-1']}>
          <Routes>
            <Route path="/ui/devices/:id" element={<DeviceView />} />
            <Route path="/ui/devices/:id/:tab" element={<DeviceView />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
}

describe('DeviceView — DeviceViewer integration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes capture-dom as an overflow extraAction to DeviceViewer', async () => {
    const ws = makeWs();
    const { findByTestId, getByTestId } = renderAtDeviceRoute(ws);

    // DeviceViewer's overflow button renders once the device info has loaded
    const overflowBtn = await findByTestId('dv-overflow');
    fireEvent.click(overflowBtn);

    // DOM capture moved into overflow as an extraAction
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Capture DOM/i })).toBeTruthy();
    });
  });
});

function renderAtPath(ws: WebSocketContextValue, path: string) {
  return render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/ui/devices/:id" element={<DeviceView />} />
            <Route path="/ui/devices/:id/:tab" element={<DeviceView />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
}

describe('DeviceView — tab routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bare /ui/devices/:id redirects to /details', async () => {
    const ws = makeWs();
    const { findByTestId } = renderAtPath(ws, '/ui/devices/dev-1');
    // Details tab is the default; once device info loads, the tab strip marks
    // "Details" as active — confirm via the active-tab test id.
    expect(await findByTestId('dv-tab-active-details')).toBeTruthy();
  });

  it('unknown tab slug redirects to /details', async () => {
    const ws = makeWs();
    const { findByTestId } = renderAtPath(ws, '/ui/devices/dev-1/bogus');
    expect(await findByTestId('dv-tab-active-details')).toBeTruthy();
  });

  it('iOS-only slug (crashes) on an Android device redirects to /details', async () => {
    const ws = makeWs(); // makeWs defaults to platform: 'android'
    const { findByTestId } = renderAtPath(ws, '/ui/devices/dev-1/crashes');
    expect(await findByTestId('dv-tab-active-details')).toBeTruthy();
  });

  it('known slug (capture) stays on that tab', async () => {
    const ws = makeWs();
    const { findByTestId } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    expect(await findByTestId('dv-tab-active-capture')).toBeTruthy();
  });
});

describe('DeviceView — layout shell', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders device name + status badge in the header above the split', async () => {
    const ws = makeWs();
    const { findByRole } = renderAtPath(ws, '/ui/devices/dev-1/details');
    // Name lives in the h1 header (Task 2); also appears in the Details tab
    // Name info-row (Task 3) — scope the assertion to the heading element.
    expect(await findByRole('heading', { level: 1, name: 'Test Device' })).toBeTruthy();
  });

  it('DeviceViewer is in the left column and persists across tab navigation', async () => {
    const ws = makeWs();
    const { findByTestId, getByTestId } = renderAtPath(ws, '/ui/devices/dev-1/details');

    // Wait for stream start-call to be sent (proves DeviceViewer mounted)
    await waitFor(() => {
      const calls = (ws.sendMessage as any).mock.calls.filter((c: any[]) => c[0] === 'device-stream-start');
      expect(calls.length).toBeGreaterThan(0);
    });

    const stopCount = () => (ws.sendMessage as any).mock.calls.filter((c: any[]) => c[0] === 'device-stream-stop').length;
    const before = stopCount();

    // Switch to Capture tab
    fireEvent.click(getByTestId('dv-tab-capture'));
    await findByTestId('dv-tab-active-capture');

    // DeviceViewer should NOT have unmounted — no new stream-stop calls
    expect(stopCount()).toBe(before);
  });
});

describe('DeviceView — Details tab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows device info card when tab=details', async () => {
    const ws = makeWs();
    const { findByText } = renderAtPath(ws, '/ui/devices/dev-1/details');
    expect(await findByText(/Platform/i)).toBeTruthy();
    expect(await findByText(/Android/i)).toBeTruthy();
  });

  it('shows "Run setup" button when setupVersion is behind', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path.startsWith('/v1/device/view/')) {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { id: 'dev-1', name: 'Test', platform: 'android', isRooted: true, setupVersion: 0, lastSeen: Date.now() } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: {} } });
      }),
    });
    const { findByRole } = renderAtPath(ws, '/ui/devices/dev-1/details');
    expect(await findByRole('button', { name: /run setup/i })).toBeTruthy();
  });
});

describe('DeviceView — Capture tab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows Start Capture CTA when not capturing', async () => {
    const ws = makeWs(); // default: capturing=false
    const { findByRole } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    expect(await findByRole('button', { name: /start capture/i })).toBeTruthy();
  });

  it('clicking Start posts to /v1/capture/start with form values', async () => {
    const ws = makeWs();
    const { findByRole, findByLabelText } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    const proxyMode = await findByLabelText(/proxy/i) as HTMLSelectElement;
    fireEvent.change(proxyMode, { target: { value: 'normal' } });
    const startBtn = await findByRole('button', { name: /start capture/i });
    fireEvent.click(startBtn);
    await waitFor(() => {
      const calls = (ws.sendRestApi as any).mock.calls.filter(
        (c: any[]) => c[0] === 'POST' && c[1] === '/v1/capture/start',
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][2]).toMatchObject({ deviceId: 'dev-1', proxyMode: 'normal' });
    });
  });

  it('shows live traffic view when capturing', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path.startsWith('/v1/device/view/')) {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { id: 'dev-1', name: 'Test', platform: 'android', isRooted: true, lastSeen: Date.now() } },
          });
        }
        if (method === 'GET' && path.startsWith('/v1/capture/status/')) {
          return Promise.resolve({
            type: 'restapi', id: '2', status: 200,
            body: { success: true, data: { capturing: true, sessionId: 42 } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: {} } });
      }),
    });
    const { findByRole } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    expect(await findByRole('button', { name: /stop capture/i })).toBeTruthy();
  });
});

describe('DeviceView — Capture tab inline traffic view', () => {
  beforeEach(() => vi.clearAllMocks());

  const capturingWs = () => makeWs({
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/v1/device/view/')) {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { id: 'dev-1', name: 'Test', platform: 'android', isRooted: true, lastSeen: Date.now() } },
        });
      }
      if (method === 'GET' && path.startsWith('/v1/capture/status/')) {
        return Promise.resolve({
          type: 'restapi', id: '2', status: 200,
          body: { success: true, data: { capturing: true, sessionId: 42 } },
        });
      }
      if (method === 'GET' && path.startsWith('/v1/traffic/list')) {
        return Promise.resolve({
          type: 'restapi', id: '3', status: 200,
          body: { success: true, data: { items: [], total: 0 } },
        });
      }
      return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true, data: {} } });
    }),
  });

  it('renders the inline traffic view (not a link) when capturing', async () => {
    const ws = capturingWs();
    const { findByTestId, queryByTestId } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    expect(await findByTestId('capture-live-traffic')).toBeTruthy();
    // MVP external-link button is gone
    expect(queryByTestId('capture-open-traffic-view')).toBeNull();
  });

  it('keeps the traffic view visible after capture is stopped (new capture button appears)', async () => {
    // Capture a reference to the capture-status subscriber so we can flip the
    // state mid-test (the page uses a WS broadcast, not the REST poll, to learn
    // about stop events).
    let statusHandler: ((msg: any) => void) | null = null;
    const ws = capturingWs();
    const originalSub = ws.subscribe;
    ws.subscribe = vi.fn((type: string, cb: (msg: any) => void) => {
      if (type === 'capture-status') statusHandler = cb;
      return originalSub(type, cb);
    });

    const { findByTestId } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    expect(await findByTestId('capture-live-traffic')).toBeTruthy();

    // Broadcast a capture-status "stopped" message — simulates the backend's
    // Stop-Capture notification arriving.
    statusHandler!({ type: 'capture-status', deviceId: 'dev-1', status: 'stopped', sessionId: 42 });

    const newCapture = await findByTestId('btn-new-capture');
    expect(newCapture).toBeTruthy();
    // Traffic view is still mounted
    expect(await findByTestId('capture-live-traffic')).toBeTruthy();
  });

  it('fetches /v1/traffic/list scoped to the device AND current session when capturing', async () => {
    const ws = capturingWs();
    renderAtPath(ws, '/ui/devices/dev-1/capture');
    await waitFor(() => {
      const calls = (ws.sendRestApi as any).mock.calls.filter(
        (c: any[]) => c[0] === 'GET' && typeof c[1] === 'string' && c[1].startsWith('/v1/traffic/list'),
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][1]).toMatch(/deviceId=dev-1/);
      // Session-scoped — avoids old capture data pre-populating a fresh view.
      expect(calls[0][1]).toMatch(/sessionId=42/);
    });
  });
});

describe('DeviceView — Capture entry-point unification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clicking DeviceViewer capture-start navigates to the Capture tab', async () => {
    const ws = makeWs();
    const { findByTestId, getByTestId } = renderAtPath(ws, '/ui/devices/dev-1/details');
    // Wait for the DeviceViewer capture button (primary action) to render
    const btn = await findByTestId('dv-extra-capture-start');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(getByTestId('dv-tab-active-capture')).toBeTruthy();
    });
  });
});

describe('DeviceView — iOS-only tabs', () => {
  beforeEach(() => vi.clearAllMocks());

  const iosWs = () => makeWs({
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/v1/device/view/')) {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { id: 'dev-1', name: 'iPhone', platform: 'ios', lastSeen: Date.now() } },
        });
      }
      if (method === 'GET' && path.startsWith('/v1/device/ios-crashes/')) {
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: [] } });
      }
      if (method === 'GET' && path.startsWith('/v1/device/ios-processes/')) {
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true, data: [] } });
      }
      return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true, data: {} } });
    }),
  });

  it('renders Crashes + Processes tabs on iOS', async () => {
    const { findByTestId } = renderAtPath(iosWs(), '/ui/devices/dev-1/details');
    expect(await findByTestId('dv-tab-crashes')).toBeTruthy();
    expect(await findByTestId('dv-tab-processes')).toBeTruthy();
  });

  it('/crashes renders crash logs content on iOS', async () => {
    const { findByRole } = renderAtPath(iosWs(), '/ui/devices/dev-1/crashes');
    expect(await findByRole('heading', { name: /crash logs/i })).toBeTruthy();
  });

  it('/processes renders processes content on iOS', async () => {
    const { findByRole } = renderAtPath(iosWs(), '/ui/devices/dev-1/processes');
    expect(await findByRole('heading', { name: /running processes/i })).toBeTruthy();
  });
});

describe('DeviceView — Capture tab session actions', () => {
  beforeEach(() => vi.clearAllMocks());

  const capturingWs = (sessionName?: string) => makeWs({
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/v1/device/view/')) {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { id: 'dev-1', name: 'Test', platform: 'android', isRooted: true, lastSeen: Date.now() } },
        });
      }
      if (method === 'GET' && path.startsWith('/v1/capture/status/')) {
        return Promise.resolve({
          type: 'restapi', id: '2', status: 200,
          body: { success: true, data: { capturing: true, sessionId: 42 } },
        });
      }
      if (method === 'GET' && path === '/v1/automation/session/42') {
        return Promise.resolve({
          type: 'restapi', id: '3', status: 200,
          body: { success: true, data: { id: 42, name: sessionName ?? null } },
        });
      }
      if (method === 'GET' && path.startsWith('/v1/traffic/list')) {
        return Promise.resolve({
          type: 'restapi', id: '4', status: 200,
          body: { success: true, data: { items: [], total: 0 } },
        });
      }
      return Promise.resolve({ type: 'restapi', id: '5', status: 200, body: { success: true, data: {} } });
    }),
  });

  it('shows Export HAR + Export ZIP buttons during an active capture', async () => {
    const ws = capturingWs();
    const { findByTestId } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    expect(await findByTestId('btn-export-har')).toBeTruthy();
    expect(await findByTestId('btn-export-zip')).toBeTruthy();
  });

  it('clicking the Session label enters rename mode and PATCHes on Enter', async () => {
    const ws = capturingWs();
    const { findByTestId } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    const label = await findByTestId('capture-session-id');
    fireEvent.click(label);
    const input = await findByTestId('capture-session-name-input');
    fireEvent.change(input, { target: { value: 'Prod session' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'PATCH',
        '/v1/automation/session/42',
        { name: 'Prod session' },
      );
    });
  });

  it('displays the custom session name when one is saved', async () => {
    const ws = capturingWs('Nightly run');
    const { findByTestId } = renderAtPath(ws, '/ui/devices/dev-1/capture');
    const label = await findByTestId('capture-session-id');
    await waitFor(() => {
      expect(label.textContent).toContain('Nightly run');
    });
  });
});

describe('DeviceView — video transport gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders <VncViewer> when video-transport endpoint returns transport=vnc', async () => {
    const ws: WebSocketContextValue = {
      connected: true,
      sendMessage: vi.fn(),
      sendRestApi: vi.fn().mockImplementation(async (_m: string, path: string) => {
        if (path.endsWith('/video-transport')) {
          return { type: 'restapi', id: '1', status: 200, body: { data: { transport: 'vnc', wsPath: '/ws/vnc?serial=localhost%3A32770' } } };
        }
        if (path.startsWith('/v1/device/view/')) {
          return { type: 'restapi', id: '2', status: 200, body: { data: { id: 'localhost:32770', name: 'localhost:32770', platform: 'android', isRooted: true, setupVersion: 4, lastSeen: Date.now() } } };
        }
        // Permissive defaults so other DeviceView fetches don't blow up.
        return { type: 'restapi', id: '3', status: 200, body: { data: {} } };
      }),
      subscribe: vi.fn().mockReturnValue(() => {}),
    } as any;

    render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/ui/devices/localhost%3A32770/details']}>
            <Routes>
              <Route path="/ui/devices/:id" element={<DeviceView />} />
              <Route path="/ui/devices/:id/:tab" element={<DeviceView />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('vnc-viewer-localhost:32770')).toBeInTheDocument();
    });
  });

  it('renders the existing DeviceViewer (no VncViewer) when transport=scrcpy', async () => {
    const ws: WebSocketContextValue = {
      connected: true,
      sendMessage: vi.fn(),
      sendRestApi: vi.fn().mockImplementation(async (_m: string, path: string) => {
        if (path.endsWith('/video-transport')) {
          return { type: 'restapi', id: '1', status: 200, body: { data: { transport: 'scrcpy' } } };
        }
        if (path.startsWith('/v1/device/view/')) {
          return { type: 'restapi', id: '2', status: 200, body: { data: { id: 'usb-pixel-001', name: 'usb-pixel-001', platform: 'android', isRooted: true, setupVersion: 4, lastSeen: Date.now() } } };
        }
        return { type: 'restapi', id: '3', status: 200, body: { data: {} } };
      }),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };

    render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/ui/devices/usb-pixel-001/details']}>
            <Routes>
              <Route path="/ui/devices/:id" element={<DeviceView />} />
              <Route path="/ui/devices/:id/:tab" element={<DeviceView />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>
    );

    // Wait for the video-transport fetch to settle so we know the conditional ran.
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/devices/usb-pixel-001/video-transport');
    });
    // VncViewer must NOT be in the document for a scrcpy-transport device.
    expect(screen.queryByTestId('vnc-viewer-usb-pixel-001')).not.toBeInTheDocument();
  });
});
