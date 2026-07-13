import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { WebSocketContext, WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { InterceptHoldPanel, InterceptArmControl } from './InterceptHoldPanel';
import type { HeldFlow } from '../../../shared/types/websocket';

type SubMap = Record<string, ((msg: any) => void)[]>;

function makeWs(opts: { held?: HeldFlow[]; armed?: boolean } = {}): {
  ws: WebSocketContextValue;
  emit: (type: string, msg: any) => void;
  resolveCalls: any[];
} {
  const subs: SubMap = {};
  const resolveCalls: any[] = [];
  const ws = {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string, bodyArg?: any) => {
      if (method === 'GET' && path === '/v1/intercept/held') {
        return Promise.resolve({ type: 'restapi', id: '1', status: 200, body: { success: true, data: opts.held || [] } });
      }
      if (method === 'GET' && path === '/v1/intercept/armed') {
        return Promise.resolve({ type: 'restapi', id: '2', status: 200, body: { success: true, data: { enabled: !!opts.armed, phases: ['request', 'response'] } } });
      }
      if (method === 'POST' && path === '/v1/intercept/resolve') {
        resolveCalls.push(bodyArg);
        return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true } });
      }
      if (method === 'POST' && path === '/v1/intercept/armed') {
        return Promise.resolve({ type: 'restapi', id: '4', status: 200, body: { success: true, data: bodyArg } });
      }
      return Promise.resolve({ type: 'restapi', id: '9', status: 200, body: { success: true } });
    }),
    subscribe: vi.fn().mockImplementation((type: string, cb: (msg: any) => void) => {
      (subs[type] = subs[type] || []).push(cb);
      return () => {
        subs[type] = (subs[type] || []).filter((f) => f !== cb);
      };
    }),
  } as any;

  const emit = (type: string, msg: any) => {
    (subs[type] || []).forEach((cb) => cb(msg));
  };
  return { ws, emit, resolveCalls };
}

function requestFlow(over: Partial<HeldFlow> = {}): HeldFlow {
  return {
    flowId: 'flow-1',
    phase: 'request',
    deviceId: 'dev-1',
    sessionId: null,
    method: 'GET',
    url: 'https://api.example.com/v1/thing',
    headers: { 'x-token': 'abc' },
    body: '{"a":1}',
    createdAt: Date.now(),
    ...over,
  };
}

function renderWith(ws: WebSocketContextValue, node: React.ReactElement) {
  return render(<WebSocketContext.Provider value={ws}>{node}</WebSocketContext.Provider>);
}

describe('InterceptHoldPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when no flow is held', async () => {
    const { ws } = makeWs({ held: [] });
    const { queryByTestId } = renderWith(ws, <InterceptHoldPanel />);
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/intercept/held'));
    expect(queryByTestId('intercept-hold-panel')).toBeNull();
  });

  it('hydrates a held request flow from GET /held and renders the editor', async () => {
    const { ws } = makeWs({ held: [requestFlow()] });
    const { getByTestId } = renderWith(ws, <InterceptHoldPanel />);
    await waitFor(() => expect(getByTestId('intercept-hold-panel')).toBeTruthy());
    expect(getByTestId('intercept-hold-phase').textContent).toContain('Request paused');
    // The editor primes from the flow in an effect that flushes after the panel
    // first mounts — wait for the primed value rather than reading it eagerly.
    await waitFor(() => expect((getByTestId('intercept-edit-method') as HTMLInputElement).value).toBe('GET'));
    expect((getByTestId('intercept-edit-url') as HTMLInputElement).value).toBe('https://api.example.com/v1/thing');
    expect((getByTestId('intercept-edit-body') as HTMLTextAreaElement).value).toBe('{"a":1}');
  });

  it('shows a held flow that arrives via the intercept-held broadcast', async () => {
    const { ws, emit } = makeWs({ held: [] });
    const { getByTestId, queryByTestId } = renderWith(ws, <InterceptHoldPanel />);
    await waitFor(() => expect(ws.subscribe).toHaveBeenCalledWith('intercept-held', expect.any(Function)));
    expect(queryByTestId('intercept-hold-panel')).toBeNull();
    emit('intercept-held', { type: 'intercept-held', flowId: 'flow-1', phase: 'request', flow: requestFlow() });
    await waitFor(() => expect(getByTestId('intercept-hold-panel')).toBeTruthy());
  });

  it('Forward resolves the flow with no modified payload', async () => {
    const { ws, resolveCalls } = makeWs({ held: [requestFlow()] });
    const { getByTestId } = renderWith(ws, <InterceptHoldPanel />);
    await waitFor(() => expect(getByTestId('intercept-forward')).toBeTruthy());
    fireEvent.click(getByTestId('intercept-forward'));
    await waitFor(() => expect(resolveCalls).toHaveLength(1));
    expect(resolveCalls[0]).toEqual({ flowId: 'flow-1', action: 'forward' });
  });

  it('Drop resolves the flow with action drop', async () => {
    const { ws, resolveCalls } = makeWs({ held: [requestFlow()] });
    const { getByTestId } = renderWith(ws, <InterceptHoldPanel />);
    await waitFor(() => expect(getByTestId('intercept-drop')).toBeTruthy());
    fireEvent.click(getByTestId('intercept-drop'));
    await waitFor(() => expect(resolveCalls).toHaveLength(1));
    expect(resolveCalls[0]).toEqual({ flowId: 'flow-1', action: 'drop' });
  });

  it('Forward Modified sends the edited method, url, headers, and body', async () => {
    const { ws, resolveCalls } = makeWs({ held: [requestFlow()] });
    const { getByTestId } = renderWith(ws, <InterceptHoldPanel />);
    await waitFor(() => expect(getByTestId('intercept-edit-url')).toBeTruthy());

    fireEvent.change(getByTestId('intercept-edit-method'), { target: { value: 'POST' } });
    fireEvent.change(getByTestId('intercept-edit-url'), { target: { value: 'https://api.example.com/v2/thing' } });
    fireEvent.change(getByTestId('intercept-edit-body'), { target: { value: '{"a":2}' } });
    fireEvent.click(getByTestId('intercept-forward-modified'));

    await waitFor(() => expect(resolveCalls).toHaveLength(1));
    const call = resolveCalls[0];
    expect(call.flowId).toBe('flow-1');
    expect(call.action).toBe('forward');
    expect(call.modified.method).toBe('POST');
    expect(call.modified.url).toBe('https://api.example.com/v2/thing');
    expect(call.modified.body).toBe('{"a":2}');
    expect(call.modified.headers).toEqual({ 'x-token': 'abc' });
  });

  it('response phase renders an editable status and sends it as statusCode', async () => {
    const flow = requestFlow({ flowId: 'r1', phase: 'response', statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
    const { ws, resolveCalls } = makeWs({ held: [flow] });
    const { getByTestId } = renderWith(ws, <InterceptHoldPanel />);
    await waitFor(() => expect((getByTestId('intercept-edit-status') as HTMLInputElement).value).toBe('200'));
    fireEvent.change(getByTestId('intercept-edit-status'), { target: { value: '503' } });
    fireEvent.click(getByTestId('intercept-forward-modified'));
    await waitFor(() => expect(resolveCalls).toHaveLength(1));
    expect(resolveCalls[0].modified.statusCode).toBe(503);
  });

  it('removes a flow when an intercept-resolved broadcast arrives (other UI / timeout)', async () => {
    const { ws, emit } = makeWs({ held: [requestFlow()] });
    const { getByTestId, queryByTestId } = renderWith(ws, <InterceptHoldPanel />);
    await waitFor(() => expect(getByTestId('intercept-hold-panel')).toBeTruthy());
    emit('intercept-resolved', { type: 'intercept-resolved', flowId: 'flow-1', action: 'forward' });
    await waitFor(() => expect(queryByTestId('intercept-hold-panel')).toBeNull());
  });
});

describe('InterceptArmControl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reflects the armed state and toggles it', async () => {
    const { ws } = makeWs({ armed: false });
    const { getByTestId } = renderWith(ws, <InterceptArmControl />);
    await waitFor(() => expect(getByTestId('intercept-arm-toggle').textContent).toContain('Off'));
    fireEvent.click(getByTestId('intercept-arm-toggle'));
    await waitFor(() =>
      expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/intercept/armed', expect.objectContaining({ enabled: true })),
    );
    expect(getByTestId('intercept-arm-toggle').textContent).toContain('On');
  });

  it('shows a held count badge that tracks held/resolved broadcasts', async () => {
    const { ws, emit } = makeWs({ armed: true, held: [] });
    const { getByTestId, queryByTestId } = renderWith(ws, <InterceptArmControl />);
    await waitFor(() => expect(getByTestId('intercept-arm-toggle')).toBeTruthy());
    expect(queryByTestId('intercept-held-count')).toBeNull();
    emit('intercept-held', { flowId: 'a' });
    emit('intercept-held', { flowId: 'b' });
    await waitFor(() => expect(getByTestId('intercept-held-count').textContent).toBe('2'));
    emit('intercept-resolved', { flowId: 'a' });
    await waitFor(() => expect(getByTestId('intercept-held-count').textContent).toBe('1'));
  });
});
