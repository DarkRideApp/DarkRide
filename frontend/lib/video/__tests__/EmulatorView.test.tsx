import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

// Mock android-emulator-webrtc's <Emulator> before importing the component.
// It would otherwise try to open gRPC/WebRTC connections on mount. The mock
// captures the props EmulatorView hands it (each render) and lets us drive its
// callbacks. `latest()` returns the most recent props (current engine/view).
const emulatorProps: any[] = [];
const latest = () => emulatorProps[emulatorProps.length - 1];
vi.mock('android-emulator-webrtc/emulator', () => ({
  Emulator: (props: any) => {
    emulatorProps.push(props);
    return React.createElement('div', { 'data-testid': 'mock-emulator', 'data-view': props.view });
  },
}));

import { EmulatorView } from '../EmulatorView';

describe('EmulatorView', () => {
  beforeEach(() => { emulatorProps.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('defaults to the png engine with a same-origin uri built from grpcWebPath', () => {
    render(<EmulatorView serial="localhost:32771" grpcWebPath="/v1/devices/localhost%3A32771/grpc" />);
    const props = latest();
    expect(props.view).toBe('png');
    expect(props.muted).toBe(true);
    expect(props.uri).toBe(`${window.location.origin}/v1/devices/localhost%3A32771/grpc`);
  });

  it('uses the webrtc engine when initialEngine="webrtc"', () => {
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" initialEngine="webrtc" />);
    expect(latest().view).toBe('webrtc');
  });

  it('fires onReady when the session reaches "connected"', async () => {
    const onReady = vi.fn();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" onReady={onReady} />);
    act(() => latest().onStateChange('connected'));
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it('fires onDisconnect only after a successful connect (ignores pre-connect churn)', async () => {
    const onDisconnect = vi.fn();
    render(<EmulatorView serial="x" grpcWebPath="/v1/devices/x/grpc" onDisconnect={onDisconnect} />);
    // Pre-connect 'disconnected' (webrtc setup churn) must be ignored.
    act(() => latest().onStateChange('disconnected'));
    expect(onDisconnect).not.toHaveBeenCalled();
    // After a real connect, a drop is a genuine disconnect.
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
