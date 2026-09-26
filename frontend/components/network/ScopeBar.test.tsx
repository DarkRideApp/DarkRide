import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ScopeBar } from './ScopeBar';
import type { NetworkScope } from './NetworkScopeContext';

function mockWs(opts: { capturing?: boolean; liveSessionId?: number | null } = {}) {
  const listeners = new Map<string, (msg: any) => void>();
  const sendRestApi = vi.fn().mockImplementation((_m: string, path: string) => {
    if (path.startsWith('/v1/device/list')) {
      return Promise.resolve({ body: { data: [{ id: 'dev-1', name: 'Pixel' }] } });
    }
    if (path.startsWith('/v1/automation/sessions')) {
      return Promise.resolve({ body: { data: { items: [
        { id: 5, name: 'checkout run', deviceId: 'dev-1' },
        { id: 9, name: 'later run', deviceId: 'dev-1' },
      ] } } });
    }
    if (path.startsWith('/v1/capture/status/')) {
      const live = opts.capturing ? (opts.liveSessionId === undefined ? 5 : opts.liveSessionId) : null;
      return Promise.resolve({ body: { data: { capturing: opts.capturing ?? false, sessionId: live } } });
    }
    return Promise.resolve({ body: {} });
  });
  const subscribe = vi.fn().mockImplementation((type: string, cb: (msg: any) => void) => {
    listeners.set(type, cb);
    return () => listeners.delete(type);
  });
  const emit = (type: string, msg: any) => act(() => { listeners.get(type)?.(msg); });
  return { sendRestApi, subscribe, emit };
}

describe('ScopeBar', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('renders All / Device / Session controls', async () => {
    render(<ScopeBar ws={mockWs() as any} scope={{ kind: 'all' }} onScopeChange={() => {}} />);
    expect(await screen.findByTestId('scope-kind-all')).toBeInTheDocument();
    expect(screen.getByTestId('scope-kind-device')).toBeInTheDocument();
    expect(screen.getByTestId('scope-kind-session')).toBeInTheDocument();
  });

  it('selecting a device fires onScopeChange', async () => {
    const onScopeChange = vi.fn();
    render(<ScopeBar ws={mockWs() as any} scope={{ kind: 'device', deviceId: '' }} onScopeChange={onScopeChange} />);
    const select = await screen.findByTestId('scope-device-select');
    fireEvent.change(select, { target: { value: 'dev-1' } });
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'device', deviceId: 'dev-1' });
  });

  it('session scope shows export + copy-link actions and copies the deep link', async () => {
    const scope: NetworkScope = { kind: 'session', sessionId: 5 };
    render(<ScopeBar ws={mockWs() as any} scope={scope} onScopeChange={() => {}} />);
    expect(await screen.findByTestId('scope-export-har')).toBeInTheDocument();
    expect(screen.getByTestId('scope-export-zip')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('scope-copy-link'));
    await waitFor(() =>
      expect((navigator.clipboard.writeText as any)).toHaveBeenCalledWith(
        expect.stringContaining('/ui/network?scope=session:5'),
      ),
    );
  });

  it('shows active capture status and stops the selected session capture', async () => {
    const ws = mockWs({ capturing: true });
    render(<ScopeBar ws={ws as any} scope={{ kind: 'session', sessionId: 5 }} onScopeChange={() => {}} />);
    expect(await screen.findByTestId('scope-capture-status')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('scope-stop-capture'));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/capture/stop',
        { deviceId: 'dev-1', sessionId: 5 },
      );
    });
    await waitFor(() => expect(screen.queryByTestId('scope-capture-status')).not.toBeInTheDocument());
  });

  it('selects a session from the production items response shape', async () => {
    const onScopeChange = vi.fn();
    render(<ScopeBar ws={mockWs() as any} scope={{ kind: 'all' }} onScopeChange={onScopeChange} />);
    const btn = await screen.findByTestId('scope-kind-session');
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'session', sessionId: 5 });
  });

  it('keeps the Session button disabled until the session list has loaded', async () => {
    let resolveSessions: (v: unknown) => void = () => {};
    const sendRestApi = vi.fn().mockImplementation((_m: string, path: string) => {
      if (path.startsWith('/v1/automation/sessions')) return new Promise(r => { resolveSessions = r; });
      return Promise.resolve({ body: { data: [] } });
    });
    const onScopeChange = vi.fn();
    render(<ScopeBar ws={{ sendRestApi }} scope={{ kind: 'all' }} onScopeChange={onScopeChange} />);
    const btn = screen.getByTestId('scope-kind-session');
    expect(btn).toBeDisabled();
    // A click during loading must not silently bounce the scope to "all".
    fireEvent.click(btn);
    expect(onScopeChange).not.toHaveBeenCalled();
    resolveSessions({ body: { data: { items: [{ id: 9, name: 'run', deviceId: 'dev-1' }] } } });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'session', sessionId: 9 });
  });

  it('disables the Session button when there are no capture sessions', async () => {
    const sendRestApi = vi.fn().mockResolvedValue({ body: { data: { items: [] } } });
    render(<ScopeBar ws={{ sendRestApi }} scope={{ kind: 'all' }} onScopeChange={() => {}} />);
    const btn = screen.getByTestId('scope-kind-session');
    await waitFor(() => expect(sendRestApi).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(btn).toHaveAttribute('title', 'No capture sessions yet'));
    expect(btn).toBeDisabled();
  });

  // Viewing an old session on a device that is live-capturing a different
  // session must not offer a Stop that would kill the other capture.
  describe('capture control is tied to the viewed session', () => {
    it('hides the control when the device is capturing a different session', async () => {
      const ws = mockWs({ capturing: true, liveSessionId: 9 });
      render(<ScopeBar ws={ws} scope={{ kind: 'session', sessionId: 5 }} onScopeChange={() => {}} />);
      await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/capture/status/dev-1'));
      // Let the status promise settle before asserting absence.
      await act(async () => {});
      expect(screen.queryByTestId('scope-capture-status')).not.toBeInTheDocument();
      expect(screen.queryByTestId('scope-stop-capture')).not.toBeInTheDocument();
    });

    it('follows capture-status messages: other session hidden, viewed session shown', async () => {
      const ws = mockWs();
      render(<ScopeBar ws={ws} scope={{ kind: 'session', sessionId: 5 }} onScopeChange={() => {}} />);
      await waitFor(() => expect(ws.subscribe).toHaveBeenCalledWith('capture-status', expect.any(Function)));

      ws.emit('capture-status', { deviceId: 'dev-1', status: 'capturing', sessionId: 9 });
      expect(screen.queryByTestId('scope-capture-status')).not.toBeInTheDocument();

      ws.emit('capture-status', { deviceId: 'dev-1', status: 'capturing', sessionId: 5 });
      expect(await screen.findByTestId('scope-capture-status')).toBeInTheDocument();
    });

    it('device scope shows the control for whatever session is live and pins the stop to it', async () => {
      const ws = mockWs({ capturing: true, liveSessionId: 9 });
      render(<ScopeBar ws={ws} scope={{ kind: 'device', deviceId: 'dev-1' }} onScopeChange={() => {}} />);
      fireEvent.click(await screen.findByTestId('scope-stop-capture'));
      await waitFor(() =>
        expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/capture/stop', { deviceId: 'dev-1', sessionId: 9 }),
      );
    });

    it('keeps the control visible when the server refuses the stop (409)', async () => {
      const ws = mockWs({ capturing: true });
      ws.sendRestApi.mockImplementation((m: string, path: string) => {
        if (m === 'POST' && path === '/v1/capture/stop') return Promise.reject(new Error('409'));
        if (path.startsWith('/v1/automation/sessions')) {
          return Promise.resolve({ body: { data: { items: [{ id: 5, name: 'run', deviceId: 'dev-1' }] } } });
        }
        if (path.startsWith('/v1/capture/status/')) {
          return Promise.resolve({ body: { data: { capturing: true, sessionId: 5 } } });
        }
        return Promise.resolve({ body: { data: [] } });
      });
      render(<ScopeBar ws={ws} scope={{ kind: 'session', sessionId: 5 }} onScopeChange={() => {}} />);
      fireEvent.click(await screen.findByTestId('scope-stop-capture'));
      await waitFor(() => expect(screen.getByTestId('scope-stop-capture')).toBeEnabled());
      expect(screen.getByTestId('scope-capture-status')).toBeInTheDocument();
    });
  });
});
