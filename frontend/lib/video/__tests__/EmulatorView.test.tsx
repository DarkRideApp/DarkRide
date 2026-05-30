import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

// Mock android-emulator-webrtc's <Emulator> before importing the component.
// It would otherwise try to open gRPC/WebRTC connections on mount. The mock
// captures the props EmulatorView hands it (each render) and lets us drive its
// callbacks. `latest()` returns the most recent props (current engine/view).
const emulatorProps: any[] = [];
const latest = () => emulatorProps[emulatorProps.length - 1];
// Class mock so refs resolve to an instance exposing sendKey (for the nav-bar
// test). lastEmulator tracks the most recent instance.
let lastEmulator: any = null;
vi.mock('android-emulator-webrtc/emulator', () => ({
  Emulator: class MockEmulator extends React.Component<any> {
    sendKey = vi.fn();
    constructor(props: any) { super(props); lastEmulator = this; }
    render() {
      emulatorProps.push(this.props);
      return React.createElement('div', { 'data-testid': 'mock-emulator', 'data-view': this.props.view });
    }
  },
}));

import { EmulatorView } from '../EmulatorView';

describe('EmulatorView', () => {
  beforeEach(() => { emulatorProps.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('defaults to the webrtc engine with a same-origin uri built from grpcWebPath', () => {
    render(<EmulatorView serial="localhost:32771" grpcWebPath="/v1/devices/localhost%3A32771/grpc" />);
    const props = latest();
    expect(props.view).toBe('webrtc');
    expect(props.muted).toBe(true);
    expect(props.uri).toBe(`${window.location.origin}/v1/devices/localhost%3A32771/grpc`);
  });

  it('forces the png engine when initialEngine="png"', () => {
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" initialEngine="png" />);
    expect(latest().view).toBe('png');
  });

  it('fires onReady when the session reaches "connected"', async () => {
    const onReady = vi.fn();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" onReady={onReady} />);
    act(() => latest().onStateChange('connected'));
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it('degrades webrtc → png only after the disconnect grace window (not on a blip)', () => {
    vi.useFakeTimers();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" />);
    expect(latest().view).toBe('webrtc');
    act(() => latest().onStateChange('connected'));
    act(() => latest().onStateChange('disconnected'));
    // Still webrtc during the grace window…
    act(() => { vi.advanceTimersByTime(5000); });
    expect(latest().view).toBe('webrtc');
    // …degrades once the window elapses while still down.
    act(() => { vi.advanceTimersByTime(8000); });
    expect(latest().view).toBe('png');
  });

  it('a quick disconnect→reconnect blip does NOT degrade to png', () => {
    vi.useFakeTimers();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" />);
    act(() => latest().onStateChange('connected'));
    act(() => latest().onStateChange('disconnected'));
    act(() => { vi.advanceTimersByTime(3000); });
    act(() => latest().onStateChange('connected')); // recovered
    act(() => { vi.advanceTimersByTime(20000); });
    expect(latest().view).toBe('webrtc');
  });

  it('the shared nav bar maps buttons to the emulator gRPC sendKey', () => {
    const { getByTestId } = render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" />);
    act(() => { getByTestId('dv-nav-home').click(); });
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('GoHome');
    act(() => { getByTestId('dv-nav-back').click(); });
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('GoBack');
    act(() => { getByTestId('dv-nav-recents').click(); });
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('AppSwitch');
  });

  it('forwards keystrokes to the emulator over gRPC (webrtc engine)', () => {
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" />);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' })); });
    expect(lastEmulator.sendKey).toHaveBeenCalledWith('p');
    // Browser shortcuts (Ctrl/F-keys) are NOT forwarded.
    lastEmulator.sendKey.mockClear();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' })); });
    expect(lastEmulator.sendKey).not.toHaveBeenCalled();
  });

  it('fires onDisconnect when the png stream drops after connecting', async () => {
    const onDisconnect = vi.fn();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" initialEngine="png" onDisconnect={onDisconnect} />);
    // Pre-connect churn ignored.
    act(() => latest().onStateChange('disconnected'));
    expect(onDisconnect).not.toHaveBeenCalled();
    // A drop after a real connect (png engine) is a genuine disconnect.
    act(() => latest().onStateChange('connected'));
    act(() => latest().onStateChange('disconnected'));
    await waitFor(() => expect(onDisconnect).toHaveBeenCalled());
  });

  it('does NOT fire onReady on the intermediate "connecting" state', () => {
    const onReady = vi.fn();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" onReady={onReady} />);
    act(() => latest().onStateChange('connecting'));
    expect(onReady).not.toHaveBeenCalled();
  });

  it('falls back from webrtc to png on a webrtc-engine error (not a fatal onError)', async () => {
    const onError = vi.fn();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" initialEngine="webrtc" onError={onError} />);
    expect(latest().view).toBe('webrtc');
    act(() => latest().onError({ message: 'ice failed' }));
    await waitFor(() => expect(latest().view).toBe('png'));
    expect(onError).not.toHaveBeenCalled();
  });

  it('falls back to png if webrtc does not connect within the timeout', async () => {
    vi.useFakeTimers();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" initialEngine="webrtc" />);
    expect(latest().view).toBe('webrtc');
    act(() => { vi.advanceTimersByTime(9000); });
    expect(latest().view).toBe('png');
  });

  it('surfaces a png-engine error to onError (fallback also failed)', async () => {
    const onError = vi.fn();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" initialEngine="webrtc" onError={onError} />);
    // Drop to png first…
    act(() => latest().onError({ message: 'ice failed' }));
    await waitFor(() => expect(latest().view).toBe('png'));
    // …then a png-engine error IS fatal.
    act(() => latest().onError({ message: 'screenshot stream failed' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    expect((onError.mock.calls[0][0] as Error).message).toMatch(/screenshot stream failed/);
  });
});
