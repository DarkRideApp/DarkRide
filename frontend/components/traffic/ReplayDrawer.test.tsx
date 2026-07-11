import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { ReplayDrawer } from './ReplayDrawer';
import type { TrafficEntry } from './TrafficEntryRow';

const CAPTURED: TrafficEntry = {
  id: 1,
  sessionId: 7,
  deviceId: 'DEV001',
  requestMethod: 'POST',
  requestUrl: 'https://api.example.com/v1/thing?q=1',
  requestHeaders: JSON.stringify({ 'Content-Type': 'application/json', Authorization: 'Bearer x' }),
  requestBody: '{"a":1}',
  responseStatus: 404,
  responseHeaders: JSON.stringify({ 'content-type': 'text/html' }),
  responseBody: '<html>old</html>',
  capturedAt: '2026-07-11T00:00:00Z',
  matchedRules: null,
};

interface MockOpts {
  capturing?: boolean;
  sendResult?: any;
  sendError?: string;
  history?: any[];
}

function makeWs(opts: MockOpts = {}): { ws: WebSocketContextValue; sendRestApi: ReturnType<typeof vi.fn> } {
  const sendRestApi = vi.fn().mockImplementation((method: string, path: string) => {
    if (path.startsWith('/v1/capture/status/')) {
      return Promise.resolve({ body: { success: true, data: { capturing: opts.capturing ?? false } } });
    }
    if (path === '/v1/proxy/list') {
      return Promise.resolve({ body: { success: true, data: [] } });
    }
    if (path.startsWith('/v1/proxied-request/history')) {
      return Promise.resolve({ body: { success: true, data: opts.history ?? [] } });
    }
    if (method === 'POST' && path === '/v1/proxied-request') {
      if (opts.sendError) {
        return Promise.resolve({ body: { success: false, error: opts.sendError } });
      }
      return Promise.resolve({
        body: {
          success: true,
          data: opts.sendResult ?? {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-new': '1' },
            body: '{"ok":true}',
            timingMs: 42,
            proxyUsed: 'capture session (nordvpn:us, chrome)',
          },
        },
      });
    }
    return Promise.resolve({ body: { success: true, data: null } });
  });
  const ws: WebSocketContextValue = {
    connected: true,
    serverReady: true,
    startupMessage: 'Ready',
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as WebSocketContextValue;
  return { ws, sendRestApi };
}

function renderDrawer(entry: TrafficEntry | null, opts: MockOpts = {}) {
  const { ws, sendRestApi } = makeWs(opts);
  const onClose = vi.fn();
  const utils = render(
    <WebSocketContext.Provider value={ws}>
      <ReplayDrawer entry={entry} onClose={onClose} />
    </WebSocketContext.Provider>,
  );
  return { ...utils, sendRestApi, onClose };
}

describe('ReplayDrawer', () => {
  it('renders nothing when closed (entry is null)', () => {
    renderDrawer(null);
    expect(screen.queryByTestId('replay-drawer')).toBeNull();
  });

  it('pre-fills the editor from the captured entry', async () => {
    renderDrawer(CAPTURED);
    expect((await screen.findByTestId('replay-url')).getAttribute('value')).toBe(CAPTURED.requestUrl);
    expect((screen.getByTestId('replay-method') as HTMLSelectElement).value).toBe('POST');
    expect((screen.getByTestId('replay-body') as HTMLTextAreaElement).value).toBe('{"a":1}');
    // Headers came through as editable rows.
    expect((screen.getByTestId('replay-header-key-0') as HTMLInputElement).value).toBe('Content-Type');
  });

  it('defaults "Send via" to the capture session when the device is capturing', async () => {
    renderDrawer(CAPTURED, { capturing: true });
    const select = screen.getByTestId('replay-send-via') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('captureSession'));
  });

  it('defaults "Send via" to direct when the device is not capturing', async () => {
    renderDrawer(CAPTURED, { capturing: false });
    const select = screen.getByTestId('replay-send-via') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('direct'));
  });

  it('sends a captureSession payload and renders the original-vs-new diff', async () => {
    const { sendRestApi } = renderDrawer(CAPTURED, { capturing: true });
    const select = screen.getByTestId('replay-send-via') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('captureSession'));

    fireEvent.click(screen.getByTestId('replay-send'));

    // Response section renders.
    await screen.findByTestId('replay-new-status');

    // The POST used the captureSession proxy source.
    const postCall = sendRestApi.mock.calls.find(
      (c) => c[0] === 'POST' && c[1] === '/v1/proxied-request',
    );
    expect(postCall).toBeTruthy();
    expect(postCall![2].proxy).toEqual({ type: 'captureSession', deviceId: 'DEV001' });

    // Status diff: 404 -> 200, flagged changed.
    expect(screen.getByTestId('replay-orig-status').textContent).toBe('404');
    expect(screen.getByTestId('replay-new-status').textContent).toBe('200');
    expect(screen.getByTestId('replay-status-diff').textContent).toBe('changed');

    // Header diff shows the changed content-type and the added x-new header.
    expect(screen.getByTestId('replay-hdr-content-type').className).toContain('replay-hdr-changed');
    expect(screen.getByTestId('replay-hdr-x-new').className).toContain('replay-hdr-added');

    // Body diff renders with add/remove lines (old html vs new json).
    const bodyDiff = screen.getByTestId('replay-body-diff');
    expect(bodyDiff.querySelector('.replay-diff-add')).toBeTruthy();
    expect(bodyDiff.querySelector('.replay-diff-remove')).toBeTruthy();

    // Routing is surfaced.
    expect(screen.getByTestId('replay-routed-via').textContent).toContain('capture session (nordvpn:us, chrome)');
  });

  it('sends a direct payload when Send via is switched to Direct', async () => {
    const { sendRestApi } = renderDrawer(CAPTURED, { capturing: true });
    const select = screen.getByTestId('replay-send-via') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('captureSession'));

    fireEvent.change(select, { target: { value: 'direct' } });
    fireEvent.click(screen.getByTestId('replay-send'));
    await screen.findByTestId('replay-new-status');

    const postCall = sendRestApi.mock.calls.find(
      (c) => c[0] === 'POST' && c[1] === '/v1/proxied-request',
    );
    expect(postCall![2].proxy).toEqual({ type: 'direct' });
  });

  it('surfaces an error response without rendering a diff', async () => {
    renderDrawer(CAPTURED, { capturing: false, sendError: 'Requests to private/internal network addresses are not allowed' });
    fireEvent.click(screen.getByTestId('replay-send'));
    const err = await screen.findByTestId('replay-error');
    expect(err.textContent).toContain('private/internal');
    // No diff sections when the send failed.
    expect(screen.queryByTestId('replay-new-status')).toBeNull();
  });

  it('shows recent replays for this host from server history', async () => {
    renderDrawer(CAPTURED, {
      capturing: false,
      history: [
        { id: 'r1', method: 'POST', url: 'https://api.example.com/v1/thing', status: 'completed', responseStatus: 200, proxyLabel: 'Direct', timingMs: 12, completedAt: 'x' },
        { id: 'r2', method: 'GET', url: 'https://other.example.com/x', status: 'completed', responseStatus: 500, proxyLabel: 'Direct', timingMs: 30, completedAt: 'y' },
      ],
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId('replay-history-row');
      // Only the same-host replay is shown.
      expect(rows).toHaveLength(1);
    });
  });
});
