import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

// Mock the noVNC library before importing the component under test.
// The mock captures the URL/credentials VncViewer hands to RFB and lets
// us drive RFB events from outside.
const rfbCtor = vi.fn();
const rfbInstances: any[] = [];
vi.mock('@novnc/novnc', () => ({
  default: class MockRFB {
    listeners = new Map<string, ((e: any) => void)[]>();
    disconnect = vi.fn();
    constructor(target: HTMLElement, url: string, opts: any) {
      rfbCtor(target, url, opts);
      rfbInstances.push(this);
    }
    addEventListener(event: string, cb: (e: any) => void) {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
    }
    fire(event: string, detail: any = {}) {
      for (const cb of this.listeners.get(event) ?? []) cb({ detail });
    }
  },
}));

import { VncViewer } from '../VncViewer';

describe('VncViewer', () => {
  beforeEach(() => { rfbCtor.mockClear(); rfbInstances.length = 0; });

  it('constructs RFB with the WebSocket URL derived from wsPath', () => {
    render(<VncViewer serial="localhost:32770" wsPath="/ws/vnc?serial=localhost%3A32770" />);
    expect(rfbCtor).toHaveBeenCalledTimes(1);
    const [target, url] = rfbCtor.mock.calls[0];
    expect(target).toBeInstanceOf(HTMLElement);
    expect(url).toMatch(/^wss?:\/\/.+\/ws\/vnc\?serial=localhost%3A32770$/);
  });

  it('fires onReady when RFB emits "connect"', async () => {
    const onReady = vi.fn();
    render(<VncViewer serial="x" wsPath="/ws/vnc?serial=x" onReady={onReady} />);
    act(() => rfbInstances[0].fire('connect'));
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it('fires onError when RFB emits "securityfailure"', async () => {
    const onError = vi.fn();
    render(<VncViewer serial="x" wsPath="/ws/vnc?serial=x" onError={onError} />);
    act(() => rfbInstances[0].fire('securityfailure', { reason: 'bad password' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });

  it('fires onDisconnect when RFB emits "disconnect"', async () => {
    const onDisconnect = vi.fn();
    render(<VncViewer serial="x" wsPath="/ws/vnc?serial=x" onDisconnect={onDisconnect} />);
    act(() => rfbInstances[0].fire('disconnect', { clean: true }));
    await waitFor(() => expect(onDisconnect).toHaveBeenCalled());
  });

  it('tears down the RFB instance on unmount', () => {
    const { unmount } = render(<VncViewer serial="x" wsPath="/ws/vnc?serial=x" />);
    const inst = rfbInstances[0];
    unmount();
    expect(inst.disconnect).toHaveBeenCalled();
  });
});
