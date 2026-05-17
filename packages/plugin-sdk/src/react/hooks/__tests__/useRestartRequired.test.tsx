import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import { useRestartRequired, __resetRestartRequiredStore } from '../useRestartRequired';
import { WebSocketContext } from '../../contexts/WebSocketContext';

type WsSubscribe = (type: string, cb: (msg: any) => void) => () => void;

function makeWsContext(opts: {
  subscribe: WsSubscribe;
  sendRestApi?: (method: string, path: string) => Promise<any>;
}) {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: opts.sendRestApi ?? (async () => ({ body: { success: true, restartRequired: null } })),
    subscribe: opts.subscribe,
    subscribeBinary: vi.fn(),
    setOnApiError: vi.fn(),
  } as any;
}

function TestComponent() {
  const state = useRestartRequired();
  return (
    <div>
      <span data-testid="required">{String(state.required)}</span>
      <span data-testid="reason">{state.reason ?? 'null'}</span>
    </div>
  );
}

describe('useRestartRequired', () => {
  beforeEach(() => { __resetRestartRequiredStore(); });

  it('starts with required:false, then reflects initial fetch', async () => {
    const ws = makeWsContext({
      subscribe: () => () => {},
      sendRestApi: async () => ({ body: { success: true, restartRequired: { reason: 'foo', since: 1 } } }),
    });
    render(<WebSocketContext.Provider value={ws}><TestComponent /></WebSocketContext.Provider>);
    await waitFor(() => expect(screen.getByTestId('required').textContent).toBe('true'));
    expect(screen.getByTestId('reason').textContent).toBe('foo');
  });

  it('defaults to required:false when fetch fails', async () => {
    const ws = makeWsContext({
      subscribe: () => () => {},
      sendRestApi: async () => { throw new Error('boom'); },
    });
    render(<WebSocketContext.Provider value={ws}><TestComponent /></WebSocketContext.Provider>);
    await waitFor(() => expect(screen.getByTestId('required').textContent).toBe('false'));
  });

  it('reacts to system:restart-required WS event', async () => {
    let onRestartRequired: ((msg: any) => void) | null = null;
    const ws = makeWsContext({
      subscribe: (type, cb) => {
        if (type === 'system:restart-required') onRestartRequired = cb;
        return () => {};
      },
    });
    render(<WebSocketContext.Provider value={ws}><TestComponent /></WebSocketContext.Provider>);
    await waitFor(() => expect(onRestartRequired).not.toBeNull());
    act(() => onRestartRequired!({ type: 'system:restart-required', reason: 'plugin foo installed', since: 1 }));
    await waitFor(() => expect(screen.getByTestId('reason').textContent).toBe('plugin foo installed'));
    expect(screen.getByTestId('required').textContent).toBe('true');
  });

  it('reacts to system:restart-cleared WS event', async () => {
    let onCleared: (() => void) | null = null;
    const ws = makeWsContext({
      subscribe: (type, cb) => {
        if (type === 'system:restart-cleared') onCleared = cb;
        return () => {};
      },
      sendRestApi: async () => ({ body: { success: true, restartRequired: { reason: 'foo', since: 1 } } }),
    });
    render(<WebSocketContext.Provider value={ws}><TestComponent /></WebSocketContext.Provider>);
    await waitFor(() => expect(screen.getByTestId('required').textContent).toBe('true'));
    act(() => onCleared!());
    await waitFor(() => expect(screen.getByTestId('required').textContent).toBe('false'));
  });
});
