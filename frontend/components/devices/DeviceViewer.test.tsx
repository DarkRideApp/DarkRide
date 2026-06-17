import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';
import { WebSocketContext, WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

// Mock android-emulator-webrtc's <Emulator> (used by EmulatorVideo, rendered
// in DeviceViewer's emulator mode) before importing the component. A class
// mock so refs resolve to an instance exposing sendKey. lastEmulator tracks
// the most recent instance so tests can assert nav/keyboard → sendKey.
let lastEmulator: any = null;
vi.mock('android-emulator-webrtc/emulator', () => ({
  Emulator: class MockEmulator extends React.Component<any> {
    sendKey = vi.fn();
    constructor(props: any) { super(props); lastEmulator = this; }
    render() {
      return React.createElement('div', { 'data-testid': 'mock-emulator', 'data-view': this.props.view });
    }
  },
}));

import { DeviceViewer } from './DeviceViewer';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';

vi.mock('../../hooks/useAuthState', () => ({
  useAuthOptional: () => ({
    hasScope: () => true,
  }),
}));

function resetRegistry() {
  (pluginRegistry as any).buttonContribs = [];
  (pluginRegistry as any).navItemContribs = [];
  (pluginRegistry as any).uiSlots = [];
  (pluginRegistry as any).disabledPlugins = new Set();
  (pluginRegistry as any).typedOrderCounter = 0;
}

function makeWs(overrides?: Partial<WebSocketContextValue>): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { success: true, data: {} } }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as any;
}

afterEach(() => {
  resetRegistry();
});

describe('DeviceViewer — stream lifecycle', () => {
  it('sends device-stream-start on mount with the given deviceId', () => {
    const ws = makeWs();
    render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    expect(ws.sendMessage).toHaveBeenCalledWith('device-stream-start', expect.objectContaining({ deviceId: 'dev-1' }));
  });

  it('sends device-stream-stop on unmount with the same viewerId', () => {
    const ws = makeWs();
    const { unmount } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    const startCall = (ws.sendMessage as any).mock.calls.find((c: any[]) => c[0] === 'device-stream-start');
    const viewerId = startCall[1].viewerId;
    unmount();
    expect(ws.sendMessage).toHaveBeenCalledWith('device-stream-stop', { deviceId: 'dev-1', viewerId });
  });

  it('fires onStreamReady with dimensions when device-stream-started arrives', async () => {
    let streamStartedCb: ((msg: any) => void) | null = null;
    const subscribe = vi.fn((type: string, cb: (msg: any) => void) => {
      if (type === 'device-stream-started') streamStartedCb = cb;
      return () => {};
    });
    const ws = makeWs({ subscribe });
    const onStreamReady = vi.fn();
    render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" onStreamReady={onStreamReady} />
      </WebSocketContext.Provider>,
    );
    streamStartedCb!({ deviceId: 'dev-1', screenWidth: 1080, screenHeight: 1920, backend: 'scrcpy' });
    await waitFor(() => {
      expect(onStreamReady).toHaveBeenCalledWith({ screenWidth: 1080, screenHeight: 1920, backend: 'scrcpy' });
    });
  });
});

describe('DeviceViewer — touch mapping', () => {
  it('maps mousedown to device screen coordinates (not frame/canvas pixels)', async () => {
    let streamStartedCb: ((msg: any) => void) | null = null;
    const subscribe = vi.fn((type: string, cb: (msg: any) => void) => {
      if (type === 'device-stream-started') streamStartedCb = cb;
      return () => {};
    });
    const ws = makeWs({ subscribe });
    const { container } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    // Backend reports the device is 1080x1920 even though frames arrive at 540x960
    streamStartedCb!({ deviceId: 'dev-1', screenWidth: 1080, screenHeight: 1920, backend: 'scrcpy' });

    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    // Mock the canvas bounding rect: rendered as 270x480 on the page
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 270, bottom: 480, width: 270, height: 480, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.mouseDown(canvas, { clientX: 135, clientY: 240 }); // dead centre of rendered canvas

    // Click centre → should map to (540, 960) in device-screen space (half of 1080x1920)
    expect(ws.sendMessage).toHaveBeenCalledWith('device-touch', {
      deviceId: 'dev-1', eventType: 'down', x: 540, y: 960,
    });
  });

  it('falls back to canvas pixel size before device-stream-started fires', () => {
    const ws = makeWs();
    const { container } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.width = 540;
    canvas.height = 960;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 270, bottom: 480, width: 270, height: 480, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.mouseDown(canvas, { clientX: 135, clientY: 240 });
    expect(ws.sendMessage).toHaveBeenCalledWith('device-touch', {
      deviceId: 'dev-1', eventType: 'down', x: 270, y: 480,
    });
  });
});

describe('DeviceViewer — primary controls', () => {
  it('Back button sends device-nav with button=back', () => {
    const ws = makeWs();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(getByTestId('dv-nav-back'));
    expect(ws.sendMessage).toHaveBeenCalledWith('device-nav', { deviceId: 'dev-1', button: 'back' });
  });

  it('Home button sends device-nav with button=home', () => {
    const ws = makeWs();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(getByTestId('dv-nav-home'));
    expect(ws.sendMessage).toHaveBeenCalledWith('device-nav', { deviceId: 'dev-1', button: 'home' });
  });

  it('Recents, Power similarly map to device-nav', () => {
    const ws = makeWs();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(getByTestId('dv-nav-recents'));
    fireEvent.click(getByTestId('dv-nav-power'));
    expect(ws.sendMessage).toHaveBeenCalledWith('device-nav', { deviceId: 'dev-1', button: 'recents' });
    expect(ws.sendMessage).toHaveBeenCalledWith('device-nav', { deviceId: 'dev-1', button: 'power' });
  });

  it('Screenshot button GETs /v1/device/screenshot when no captureSessionId', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockResolvedValue({
        type: 'restapi', id: '1', status: 200,
        body: { success: true, data: { image: 'base64data' } },
      }),
    });
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(getByTestId('dv-screenshot'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/device/screenshot/dev-1');
    });
  });
});

describe('DeviceViewer — swipe picker', () => {
  it('clicking the swipe button opens the picker and swipe-up sends device-swipe with 35% centre displacement', async () => {
    let streamStartedCb: ((msg: any) => void) | null = null;
    const subscribe = vi.fn((type: string, cb: (msg: any) => void) => {
      if (type === 'device-stream-started') streamStartedCb = cb;
      return () => {};
    });
    const ws = makeWs({ subscribe });
    const { getByTestId, queryByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    streamStartedCb!({ deviceId: 'dev-1', screenWidth: 1080, screenHeight: 1920, backend: 'scrcpy' });

    expect(queryByTestId('dv-swipe-up')).toBeNull();
    fireEvent.click(getByTestId('dv-swipe'));
    fireEvent.click(getByTestId('dv-swipe-up'));

    // centre = (540, 960); dist = 0.35 * min(1080,1920) = 378
    // swipe up: startX=540, startY=960+378=1338, endX=540, endY=960-378=582
    expect(ws.sendMessage).toHaveBeenCalledWith('device-swipe', {
      deviceId: 'dev-1',
      startX: 540, startY: 1338, endX: 540, endY: 582,
      durationMs: 400,
    });
  });
});

describe('DeviceViewer — overflow menu', () => {
  it('Unlock is in the primary strip and POSTs /v1/device/command/:id with command=unlock', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { success: true } }),
    });
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    // Unlock lives in the primary strip — always visible on Android — no overflow needed
    fireEvent.click(getByTestId('dv-cmd-unlock'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/device/command/dev-1', { command: 'unlock' });
    });
  });

  it('Stop All Apps POSTs command=stopall', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { success: true } }),
    });
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(getByTestId('dv-overflow'));
    fireEvent.click(screen.getByRole('button', { name: /Stop all apps/i }));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/device/command/dev-1', { command: 'stopall' });
    });
  });
});

describe('DeviceViewer — extraActions', () => {
  it('inserts primary-placement actions into the main strip', () => {
    const ws = makeWs();
    const onClick = vi.fn();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer
          deviceId="dev-1"
          extraActions={[{ key: 'custom', label: 'Custom Thing', icon: '🔧', onClick, placement: 'primary' }]}
        />
      </WebSocketContext.Provider>,
    );
    const btn = getByTestId('dv-extra-custom');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('inserts overflow-placement actions into the ⋯ menu', () => {
    const ws = makeWs();
    const onClick = vi.fn();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer
          deviceId="dev-1"
          extraActions={[{ key: 'rotate', label: 'Rotate', icon: '↻', onClick, placement: 'overflow' }]}
        />
      </WebSocketContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: /Rotate/i })).toBeNull();
    fireEvent.click(getByTestId('dv-overflow'));
    const btn = screen.getByRole('button', { name: /Rotate/i });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('defaults to overflow when placement is omitted', () => {
    const ws = makeWs();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer
          deviceId="dev-1"
          extraActions={[{ key: 'silent', label: 'Silent', icon: 's', onClick: vi.fn() }]}
        />
      </WebSocketContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: /Silent/i })).toBeNull();
    fireEvent.click(getByTestId('dv-overflow'));
    expect(screen.getByRole('button', { name: /Silent/i })).toBeTruthy();
  });
});

describe('DeviceViewer — screenshot session binding', () => {
  it('POSTs with sessionId when captureSessionId prop is set', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockResolvedValue({ type: 'restapi', id: '1', status: 200, body: { success: true, data: {} } }),
    });
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" captureSessionId={42} />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(getByTestId('dv-screenshot'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/device/screenshot/dev-1', { sessionId: 42 });
    });
  });
});

describe('DeviceViewer — retry stream', () => {
  it('overflow "Retry stream" sends device-stream-restart with deviceId and current viewerId', async () => {
    const ws = makeWs();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    // Grab the viewerId that was generated for this instance from the initial
    // device-stream-start call so we can assert the restart carries it.
    const startCall = (ws.sendMessage as any).mock.calls.find((c: any[]) => c[0] === 'device-stream-start');
    const viewerId = startCall[1].viewerId;

    fireEvent.click(getByTestId('dv-overflow'));
    fireEvent.click(screen.getByRole('button', { name: /Retry stream/i }));

    expect(ws.sendMessage).toHaveBeenCalledWith('device-stream-restart', {
      deviceId: 'dev-1',
      viewerId,
    });
  });

  it('on iOS, Retry stream is not shown (Android-only)', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/device/view/dev-1') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { platform: 'ios' } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true } });
      }),
    });
    const { getByTestId, queryByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => {
      expect(queryByTestId('dv-nav-power')).toBeNull();
    });
    fireEvent.click(getByTestId('dv-overflow'));
    expect(screen.queryByRole('button', { name: /Retry stream/i })).toBeNull();
  });
});

describe('DeviceViewer — platform gating', () => {
  it('on iOS, hides Power, Unlock, Stop All Apps', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/device/view/dev-1') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { platform: 'ios' } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true } });
      }),
    });
    const { queryByTestId, getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => {
      expect(queryByTestId('dv-nav-power')).toBeNull();
    });
    // Back/Home/Recents/Swipe/Screenshot remain
    expect(getByTestId('dv-nav-back')).toBeTruthy();
    expect(getByTestId('dv-nav-home')).toBeTruthy();
    expect(getByTestId('dv-swipe')).toBeTruthy();
    expect(getByTestId('dv-screenshot')).toBeTruthy();
    // Overflow menu has no Unlock / StopAll on iOS
    fireEvent.click(getByTestId('dv-overflow'));
    expect(queryByTestId('dv-cmd-unlock')).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop all apps/i })).toBeNull();
  });

  it('on Android, renders the full set', async () => {
    const ws = makeWs({
      sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
        if (method === 'GET' && path === '/v1/device/view/dev-1') {
          return Promise.resolve({
            type: 'restapi', id: '1', status: 200,
            body: { success: true, data: { platform: 'android' } },
          });
        }
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true } });
      }),
    });
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => {
      expect(getByTestId('dv-nav-power')).toBeTruthy();
    });
  });
});

describe('DeviceViewer — plugin slot injection', () => {
  it('a plugin button contribution appears in the overflow menu', async () => {
    const click = vi.fn();
    pluginRegistry.registerButtonContribution('test-plug', {
      slot: 'device-viewer:overflow-actions',
      id: 'test-plug:hello',
      label: 'PluginButton',
      icon: 'star',
      onClick: click,
    });
    const ws = makeWs();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    // Plugin button should not be visible before the popover is opened
    expect(screen.queryByRole('button', { name: /PluginButton/i })).toBeNull();
    // Open the overflow popover
    fireEvent.click(getByTestId('dv-overflow'));
    // Plugin button should now appear
    const pluginBtn = screen.getByRole('button', { name: /PluginButton/i });
    expect(pluginBtn).toBeTruthy();
    fireEvent.click(pluginBtn);
    expect(click).toHaveBeenCalled();
  });
});

describe('DeviceViewer — H.264 video', () => {
  // Build a minimal SPS NAL unit with start code: profile_idc=0x42, profile_iop=0x00, level_idc=0x1e
  const SPS_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);

  function buildBinaryFrame(msgType: number, payload: Uint8Array, frameId = 1): ArrayBuffer {
    const HEADER_SIZE = 14;
    const buf = new ArrayBuffer(HEADER_SIZE + payload.length);
    const view = new DataView(buf);
    view.setUint8(0, 2); // WIRE_VERSION
    view.setUint8(1, msgType);
    view.setBigUint64(2, 0n, false);
    view.setUint32(10, frameId, false);
    new Uint8Array(buf, HEADER_SIZE).set(payload);
    return buf;
  }

  // Fake WebCodecs globals
  class FakeVideoDecoder {
    static instances: FakeVideoDecoder[] = [];
    state = 'unconfigured';
    configure = vi.fn(() => { (this as any).state = 'configured'; });
    decode = vi.fn();
    close = vi.fn(() => { (this as any).state = 'closed'; });
    output: (frame: any) => void;
    error: (e: any) => void;
    constructor(init: any) {
      this.output = init.output;
      this.error = init.error;
      FakeVideoDecoder.instances.push(this);
    }
  }
  class FakeEncodedVideoChunk {
    constructor(public init: any) {}
    get type() { return this.init.type; }
    get timestamp() { return this.init.timestamp; }
    get data() { return this.init.data; }
  }

  beforeEach(() => {
    FakeVideoDecoder.instances = [];
    (global as any).VideoDecoder = FakeVideoDecoder;
    (global as any).VideoDecoder.isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    (global as any).EncodedVideoChunk = FakeEncodedVideoChunk;
  });

  afterEach(() => {
    delete (global as any).VideoDecoder;
    delete (global as any).EncodedVideoChunk;
  });

  it('configures the WebCodecs decoder when a CONFIG binary frame arrives', async () => {
    let binaryCb: ((data: ArrayBuffer) => void) | null = null;
    const subscribeBinary = vi.fn((cb: (data: ArrayBuffer) => void) => {
      binaryCb = cb;
      return () => {};
    });
    const ws = makeWs({ subscribeBinary });
    render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(binaryCb).toBeTruthy());
    binaryCb!(buildBinaryFrame(0, SPS_BYTES));
    await waitFor(() => expect(FakeVideoDecoder.instances).toHaveLength(1));
    expect(FakeVideoDecoder.instances[0].configure).toHaveBeenCalled();
  });

  it('shows browser-unsupported empty-state when VideoDecoder is not available', async () => {
    delete (global as any).VideoDecoder;
    const ws = makeWs();
    render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Live video requires a modern browser/i)).toBeInTheDocument();
    });
  });
});

describe('DeviceViewer — reconnecting overlay', () => {
  // Reuse the same binary frame builder and SPS bytes as the H.264 video block
  const SPS_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);

  function buildBinaryFrame(msgType: number, payload: Uint8Array, frameId = 1): ArrayBuffer {
    const HEADER_SIZE = 14;
    const buf = new ArrayBuffer(HEADER_SIZE + payload.length);
    const view = new DataView(buf);
    view.setUint8(0, 2); // WIRE_VERSION
    view.setUint8(1, msgType);
    view.setBigUint64(2, 0n, false);
    view.setUint32(10, frameId, false);
    new Uint8Array(buf, HEADER_SIZE).set(payload);
    return buf;
  }

  class FakeVideoDecoder {
    static instances: FakeVideoDecoder[] = [];
    state = 'unconfigured';
    configure = vi.fn(() => { (this as any).state = 'configured'; });
    decode = vi.fn();
    close = vi.fn(() => { (this as any).state = 'closed'; });
    output: (frame: any) => void;
    error: (e: any) => void;
    constructor(init: any) {
      this.output = init.output;
      this.error = init.error;
      FakeVideoDecoder.instances.push(this);
    }
  }
  class FakeEncodedVideoChunk {
    constructor(public init: any) {}
    get type() { return this.init.type; }
    get timestamp() { return this.init.timestamp; }
    get data() { return this.init.data; }
  }

  beforeEach(() => {
    FakeVideoDecoder.instances = [];
    (global as any).VideoDecoder = FakeVideoDecoder;
    (global as any).VideoDecoder.isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    (global as any).EncodedVideoChunk = FakeEncodedVideoChunk;
  });

  afterEach(() => {
    delete (global as any).VideoDecoder;
    delete (global as any).EncodedVideoChunk;
  });

  it('shows reconnecting overlay on video-reset, hides it after next CONFIG', async () => {
    let binaryCb: ((data: ArrayBuffer) => void) | null = null;
    let videoResetCb: ((msg: any) => void) | null = null;

    const subscribe = vi.fn((type: string, cb: (msg: any) => void) => {
      if (type === 'video-reset') videoResetCb = cb;
      return () => {};
    });
    const subscribeBinary = vi.fn((cb: (data: ArrayBuffer) => void) => {
      binaryCb = cb;
      return () => {};
    });
    const ws = makeWs({ subscribe, subscribeBinary });

    render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => expect(videoResetCb).toBeTruthy());

    // Trigger a video-reset
    videoResetCb!({ type: 'video-reset', deviceId: 'dev-1', reason: 'congestion' });

    await waitFor(() => {
      expect(screen.getByText(/Reconnecting/i)).toBeInTheDocument();
    });

    // Send a CONFIG binary frame — overlay should disappear
    await waitFor(() => expect(binaryCb).toBeTruthy());
    binaryCb!(buildBinaryFrame(0, SPS_BYTES));

    await waitFor(() => {
      expect(screen.queryByText(/Reconnecting/i)).toBeNull();
    });
  });

  it('clears resetSticky when reconnecting resolves quickly via CONFIG frame', async () => {
    let binaryCb: ((data: ArrayBuffer) => void) | null = null;
    let videoResetCb: ((msg: any) => void) | null = null;

    const subscribe = vi.fn((type: string, cb: (msg: any) => void) => {
      if (type === 'video-reset') videoResetCb = cb;
      return () => {};
    });
    const subscribeBinary = vi.fn((cb: (data: ArrayBuffer) => void) => {
      binaryCb = cb;
      return () => {};
    });
    const ws = makeWs({ subscribe, subscribeBinary });

    const { container } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-1" />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => expect(videoResetCb).toBeTruthy());
    videoResetCb!({ type: 'video-reset', deviceId: 'dev-1', reason: 'congestion' });

    // Health dot should now be in resetting state (red)
    await waitFor(() => {
      expect(container.querySelector('.video-health-dot.resetting')).toBeTruthy();
    });

    // Send a CONFIG frame — reconnecting clears
    await waitFor(() => expect(binaryCb).toBeTruthy());
    binaryCb!(buildBinaryFrame(0, SPS_BYTES));

    // Within a tick the dot should be back to healthy/degraded, NOT stuck on resetting
    await waitFor(() => {
      expect(container.querySelector('.video-health-dot.resetting')).toBeNull();
    });
  });
});

describe('DeviceViewer — reserved aspect ratio', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads cached resolution from localStorage on mount and applies aspect-ratio to the canvas container', () => {
    localStorage.setItem(
      'darkride:device-viewer:last-res:dev-A',
      JSON.stringify({ width: 1080, height: 2400 }),
    );
    const ws = makeWs();
    const { container } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-A" />
      </WebSocketContext.Provider>,
    );
    const wrap = container.querySelector('canvas')!.parentElement!;
    // aspect-ratio style is applied inline via the style prop
    expect(wrap.style.aspectRatio).toBe('1080 / 2400');
  });

  it('saves resolution to localStorage when device-stream-started reports dims', async () => {
    let fire: ((msg: any) => void) | null = null;
    const ws = makeWs({
      subscribe: vi.fn((event: string, handler: any) => {
        if (event === 'device-stream-started') fire = handler;
        return () => {};
      }) as any,
    });
    render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-B" />
      </WebSocketContext.Provider>,
    );
    expect(fire).not.toBeNull();
    fire!({ deviceId: 'dev-B', screenWidth: 720, screenHeight: 1600, backend: 'minicap' });
    await waitFor(() => {
      const raw = localStorage.getItem('darkride:device-viewer:last-res:dev-B');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed).toEqual({ width: 720, height: 1600 });
    });
  });

  it('renders without aspect-ratio when no cached resolution is available', () => {
    const ws = makeWs();
    const { container } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-fresh" />
      </WebSocketContext.Provider>,
    );
    const wrap = container.querySelector('canvas')!.parentElement!;
    expect(wrap.style.aspectRatio).toBe('');
  });
});

describe('DeviceViewer — emulator mode (webrtcGrpcPath)', () => {
  beforeEach(() => { lastEmulator = null; });

  it('renders the EmulatorVideo surface (no scrcpy canvas) when webrtcGrpcPath is set', () => {
    const ws = makeWs();
    const { getByTestId, container } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="localhost:32771" webrtcGrpcPath="/v1/devices/localhost%3A32771/grpc" />
      </WebSocketContext.Provider>,
    );
    expect(getByTestId('emulator-video-localhost:32771')).toBeTruthy();
    // No scrcpy <canvas> and no device-stream-start in emulator mode.
    expect(container.querySelector('canvas')).toBeNull();
    const startCalls = (ws.sendMessage as any).mock.calls.filter((c: any[]) => c[0] === 'device-stream-start');
    expect(startCalls.length).toBe(0);
  });

  it('nav buttons route to the emulator gRPC sendKey with the mapped keys', () => {
    const ws = makeWs();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-emu" webrtcGrpcPath="/v1/devices/dev-emu/grpc" />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(getByTestId('dv-nav-home'));
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('GoHome');
    fireEvent.click(getByTestId('dv-nav-back'));
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('GoBack');
    fireEvent.click(getByTestId('dv-nav-recents'));
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('AppSwitch');
    fireEvent.click(getByTestId('dv-nav-power'));
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('Power');
    // adb path is NOT used in emulator mode.
    expect(ws.sendMessage).not.toHaveBeenCalledWith('device-nav', expect.anything());
  });

  it('forwards window keydown to the emulator sendKey (skipping browser shortcuts)', () => {
    const ws = makeWs();
    render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-emu" webrtcGrpcPath="/v1/devices/dev-emu/grpc" />
      </WebSocketContext.Provider>,
    );
    fireEvent.keyDown(window, { key: 'p' });
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('p');
    lastEmulator.sendKey.mockClear();
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'F5' });
    expect(lastEmulator.sendKey).not.toHaveBeenCalled();
  });

  it('does not render the quality selector in emulator mode', () => {
    const ws = makeWs();
    const { container, queryByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-emu" webrtcGrpcPath="/v1/devices/dev-emu/grpc" />
      </WebSocketContext.Provider>,
    );
    // VideoQualitySelector is gone; nav/swipe/screenshot remain.
    expect(container.querySelector('.video-quality-selector')).toBeNull();
    expect(queryByTestId('dv-nav-home')).toBeTruthy();
    expect(queryByTestId('dv-swipe')).toBeTruthy();
    expect(queryByTestId('dv-screenshot')).toBeTruthy();
  });

  it('does not show Retry stream in the overflow menu in emulator mode', () => {
    const ws = makeWs();
    const { getByTestId } = render(
      <WebSocketContext.Provider value={ws}>
        <DeviceViewer deviceId="dev-emu" webrtcGrpcPath="/v1/devices/dev-emu/grpc" />
      </WebSocketContext.Provider>,
    );
    fireEvent.click(getByTestId('dv-overflow'));
    expect(screen.queryByRole('button', { name: /Retry stream/i })).toBeNull();
  });
});
